import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger, type AppConfig, newId, now, sanitizeDiagnostic } from '@llmbugfix/shared';
import { SQLiteBugRepository } from '@llmbugfix/bug-repository';
import { JobQueue, LeaseFencedError, type QueueJob } from '@llmbugfix/job-queue';
import { EnvironmentResolver, EnvironmentProfileSchema, type EnvironmentProfile, type ResolvedEnvironment } from '@llmbugfix/environment-resolver';
import { RepoManager } from '@llmbugfix/repo-manager';
import { EnvironmentRunner } from '@llmbugfix/environment-runner';
import { FakePiRunner, PiAgentOutputFormatError, type AgentRunner, type PiProgressEvent } from '@llmbugfix/pi-runner';
import { Validator, DeterministicValidationSchema, type DeterministicValidation } from '@llmbugfix/validator';
import { BackendAttemptTracker, BackendFailureClassSchema, type BackendFailureClass, type BackendLease, type BackendRegistry, classifyBackendFailure, isInfrastructureFailure } from '@llmbugfix/llm-dispatcher';
import { BugFixTaskSchema, CodingTaskSchema, AgentFixResultSchema, AgentTaskResultSchema, FixCandidateMetadataSchema, BugReviewResultSchema, DevelopmentReviewResultSchema, ReviewResultSchema, GitResultSchema, type AttachmentRef, type CodingTask, type BugReport, type FixCandidateMetadata } from '@llmbugfix/bug-domain';

const logger = createLogger('orchestrator');
const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export interface OrchestratorOptions {
  dryRun?: boolean;
  workerId?: string;
  artifactRoot?: string;
  maxConcurrentJobs?: number;
  leaseTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  dispatcher?: BackendRegistry;
  runnerFactory?: { get(backendId: string): AgentRunner; has?(backendId: string): boolean };
}
export interface PipelineArtifact { bugKey: string; status: string; startedAt: string; finishedAt?: string; error?: string | null; }
class PipelineCancelledError extends Error { constructor() { super('Pipeline cancelled'); this.name = 'PipelineCancelledError'; } }

type FixResult = ReturnType<typeof AgentFixResultSchema.parse> | ReturnType<typeof AgentTaskResultSchema.parse>;
type Role = 'fixer' | 'reviewer';

export class Orchestrator {
  private timer?: NodeJS.Timeout;
  private isRunning = false;
  private ticking = false;
  private readonly activeJobs = new Set<Promise<void>>();
  private readonly options: Required<Pick<OrchestratorOptions, 'dryRun' | 'workerId' | 'artifactRoot' | 'maxConcurrentJobs' | 'leaseTimeoutMs' | 'heartbeatIntervalMs'>> & Pick<OrchestratorOptions, 'dispatcher' | 'runnerFactory'>;

  constructor(
    private readonly config: AppConfig,
    private readonly repo: SQLiteBugRepository,
    private readonly queue: JobQueue,
    private readonly envResolver: EnvironmentResolver,
    private readonly repoManager: RepoManager,
    private readonly envRunner: EnvironmentRunner,
    private readonly agentRunner: AgentRunner = new FakePiRunner(),
    private readonly validator: Validator = new Validator(),
    options: OrchestratorOptions = {},
  ) {
    this.options = {
      dryRun: options.dryRun ?? process.env.DRY_RUN !== 'false',
      workerId: options.workerId ?? `worker-${process.pid}`,
      artifactRoot: options.artifactRoot ?? path.join(config.DATA_ROOT, 'agent-results'),
      maxConcurrentJobs: Math.max(1, Math.floor(options.maxConcurrentJobs ?? envNumber('DISPATCHER_MAX_CONCURRENT_JOBS', 1))),
      leaseTimeoutMs: Math.max(1_000, Math.floor(options.leaseTimeoutMs ?? envNumber('JOB_LEASE_TIMEOUT_MS', 300_000))),
      heartbeatIntervalMs: Math.max(250, Math.floor(options.heartbeatIntervalMs ?? envNumber('JOB_HEARTBEAT_INTERVAL_MS', 15_000))),
      dispatcher: options.dispatcher,
      runnerFactory: options.runnerFactory,
    };
  }

  start(pollIntervalMs = 2_000): void {
    this.isRunning = true;
    this.timer = setInterval(() => { void this.tickInternal(false); }, pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.activeJobs]);
  }

  /** Direct tick waits for every job claimed in this batch. Timer ticks only launch them. */
  async tick(): Promise<boolean> { return this.tickInternal(true); }

  private async tickInternal(waitForBatch: boolean): Promise<boolean> {
    if (this.ticking || (!this.isRunning && this.timer)) return false;
    this.ticking = true;
    const launched: Promise<void>[] = [];
    try {
      try { this.queue.recoverStaleJobs(this.options.leaseTimeoutMs); } catch (error) { logger.warn({ error: String(error) }, 'Stale job recovery failed'); }
      while (this.activeJobs.size < this.options.maxConcurrentJobs) {
        let job: QueueJob | null;
        try { job = this.queue.claimNextJob(this.options.workerId); } catch (error) { logger.warn({ error: String(error) }, 'Queue claim failed'); break; }
        if (!job) break;
        if (!job.leaseToken || !job.workerId) { logger.error({ jobId: job.id }, 'Queue returned a job without ownership lease'); break; }
        launched.push(this.track(this.processJob(job)));
      }
      if (waitForBatch) await Promise.allSettled(launched);
      return launched.length > 0;
    } finally { this.ticking = false; }
  }

  async runJob(job: QueueJob): Promise<void> {
    if (!job.leaseToken || !job.workerId) throw new Error(`Job ${job.id} is not owned by a fenced worker`);
    await this.track(this.processJob(job));
  }

  private async track(operation: Promise<void>): Promise<void> {
    this.activeJobs.add(operation);
    try { await operation; } finally { this.activeJobs.delete(operation); }
  }

  private writeArtifact(dir: string, filename: string, value: unknown): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    const target = path.join(dir, filename); const temporary = `${target}.${process.pid}.${newId()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    try { fs.chmodSync(temporary, 0o600); } catch { /* best effort */ }
    fs.renameSync(temporary, target);
  }

  private writeRawArtifact(dir: string, filename: string, value: string): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    const target = path.join(dir, filename); const temporary = `${target}.${process.pid}.${newId()}.tmp`;
    fs.writeFileSync(temporary, value, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(temporary, 0o600); } catch { /* best effort */ }
    fs.renameSync(temporary, target);
  }

  /**
   * Check ownership immediately before a pipeline side effect.  Queue
   * terminal updates are fenced by the queue itself, but repository and
   * artifact writes need this check as well or a reclaimed worker could leave
   * stale business state behind.
   */
  private checkpoint(job: QueueJob, bugId: string): BugReport {
    let currentJob: QueueJob;
    try { currentJob = this.queue.getJob(job.id); }
    catch { throw new LeaseFencedError(job.id); }
    if (!currentJob) throw new LeaseFencedError(job.id);
    // A queue CANCELLED row is an explicit administrative outcome.  For every
    // other queue state ownership must be established first; a bug row left at
    // CANCELLED must never turn a reclaimed/new lease into a cancellation.
    if (currentJob.status === 'CANCELLED') throw new PipelineCancelledError();
    const expiry = currentJob.leaseExpiresAt == null ? null : Date.parse(currentJob.leaseExpiresAt);
    if (currentJob.status !== 'RUNNING' || currentJob.workerId !== job.workerId || currentJob.leaseToken !== job.leaseToken || (expiry !== null && (!Number.isFinite(expiry) || expiry <= Date.now()))) throw new LeaseFencedError(job.id);
    const row = this.repo.database.prepare('SELECT status FROM bug_reports WHERE id = ? OR bug_key = ?').get(bugId, bugId) as { status?: string } | undefined;
    // The old worker may honor a bug-level administrative cancellation only
    // while it still owns the original queue lease.
    if (row?.status === 'CANCELLED') throw new PipelineCancelledError();
    const current = this.repo.getBug(bugId);
    if (!current) throw new PipelineCancelledError();
    return current;
  }

  private fencedArtifact(job: QueueJob, bugId: string, dir: string, filename: string, value: unknown): void {
    this.checkpoint(job, bugId); this.writeArtifact(dir, filename, value);
  }

  private fencedRawArtifact(job: QueueJob, bugId: string, dir: string, filename: string, value: string): void {
    this.checkpoint(job, bugId); this.writeRawArtifact(dir, filename, value);
  }

  private isLeaseStillOwned(job: QueueJob, bugId: string): boolean {
    try { this.checkpoint(job, bugId); return true; } catch { return false; }
  }

  private isExplicitCancellation(job: QueueJob, bugId: string): boolean {
    try {
      const currentJob = this.queue.getJob(job.id);
      if (currentJob.status === 'CANCELLED') return true;
      const row = this.repo.database.prepare('SELECT status FROM bug_reports WHERE id = ? OR bug_key = ?').get(bugId, bugId) as { status?: string } | undefined;
      // A bug row marked CANCELLED is an administrative cancellation only
      // while this exact worker lease is still attached.  If the queue has
      // already been reclaimed/retried, the old worker is fenced instead.
      return currentJob.status === 'RUNNING' && currentJob.workerId === job.workerId && currentJob.leaseToken === job.leaseToken && row?.status === 'CANCELLED';
    } catch { return false; }
  }

  private async transition(job: QueueJob, bug: BugReport, status: Parameters<SQLiteBugRepository['changeBugStatus']>[1], payload: unknown = {}): Promise<void> {
    this.checkpoint(job, bug.id); this.repo.changeBugStatus(bug.bugKey, status, 'pipeline', payload);
  }

  private progressSink(job: QueueJob, jobId: string, bugId: string): (event: PiProgressEvent) => void {
    return (event) => {
      try { this.checkpoint(job, bugId); this.repo.appendWorkerEvent({ ...event, jobId, bugId }); }
      catch (error) { if (error instanceof LeaseFencedError || error instanceof PipelineCancelledError) throw error;
        logger.warn({ jobId, bugId, error: error instanceof Error ? error.message : String(error) }, 'Worker progress event persistence failed'); }
    };
  }

  private attachmentsFor(bug: BugReport): AttachmentRef[] {
    let persisted: AttachmentRef[] = [];
    try { persisted = this.repo.listAttachments(bug.id); } catch { try { persisted = this.repo.listAttachments(bug.bugKey); } catch { /* legacy repository without attachment rows */ } }
    const categories = ['logs', 'screenshots', 'videos', 'networkTraces', 'jsonFiles', 'otherFiles'] as const;
    const merged = [...persisted, ...categories.flatMap((category) => bug.evidence[category])]; const seen = new Set<string>();
    return merged.filter((attachment) => !seen.has(attachment.id) && (seen.add(attachment.id), true));
  }

  private taskFor(bug: BugReport, profile: EnvironmentProfile, attachments = this.attachmentsFor(bug)): CodingTask {
    const common = { bugKey: bug.bugKey, title: bug.title, executionTarget: profile.target, environmentProfileId: profile.id, dev_env_snapshot: bug.dev_env_snapshot, dev_env_special: bug.dev_env_special, environment: bug.environment.additionalInfo, attachments, reporterObservations: bug.observations, machineObservations: [], missingInformation: bug.intake.missingInformation, completenessScore: bug.intake.completenessScore };
    return CodingTaskSchema.parse(bug.taskType === 'development'
      ? { ...common, taskType: 'development', objective: bug.objective, requirements: bug.requirements, acceptanceCriteria: bug.acceptanceCriteria, nonGoals: bug.nonGoals, constraints: bug.constraints, referenceContext: bug.referenceContext }
      : { ...common, taskType: 'bugfix', actualBehavior: bug.actualBehavior, expectedBehavior: bug.expectedBehavior, reproductionSteps: bug.reproduction.steps, prerequisites: bug.reproduction.prerequisites, errorMessages: bug.evidence.errorMessages, stackTraces: bug.evidence.stackTraces, lastKnownGoodVersion: bug.regression.lastKnownGoodVersion, failingVersion: bug.regression.suspectedVersion, reporterHypotheses: bug.reporterHypotheses });
  }

  private routeRequest(job: QueueJob, role: Role, target: 'frontend' | 'backend', taskType: 'bugfix' | 'development', excludeBackendIds: string[] = []): any {
    return { role, taskType, executionTarget: target, requirements: job.routingRequirements ?? { priority: 'normal', capabilityHints: [], quality: 'standard' }, excludeBackendIds };
  }

  private runnerFor(backendId: string | undefined): AgentRunner { return backendId && this.options.runnerFactory ? this.options.runnerFactory.get(backendId) : this.agentRunner; }

  private async acquireRole(job: QueueJob, role: Role, task: CodingTask, signal: AbortSignal, exclude: string[]): Promise<{ lease: BackendLease | null; runner: AgentRunner; backendId: string }> {
    this.checkpoint(job, job.bugId);
    if (!this.options.dispatcher) return { lease: null, runner: this.agentRunner, backendId: this.agentRunner instanceof FakePiRunner ? (this.agentRunner.backendId ?? 'legacy') : 'legacy' };
    const lease = await this.options.dispatcher.acquire(this.routeRequest(job, role, task.executionTarget, task.taskType, exclude), { signal, jobId: job.id, taskId: job.bugId });
    try { return { lease, runner: this.runnerFor(lease.backendId), backendId: lease.backendId }; }
    catch (error) { this.options.dispatcher.release(lease); throw error; }
  }

  private finishAgentRun(job: QueueJob, bugId: string, id: string, status: 'COMPLETED' | 'FAILED' | 'CANCELLED', output: unknown, error: unknown, failureClass: BackendFailureClass | null): void {
    this.checkpoint(job, bugId);
    this.repo.database.prepare('UPDATE agent_runs SET status = ?, finished_at = ?, output = ?, error = ?, failure_class = ? WHERE id = ? AND status = \'RUNNING\'').run(status, now(), output == null ? null : JSON.stringify(output), error == null ? null : sanitizeDiagnostic(error instanceof Error ? error.message : String(error), 2048), failureClass, id);
  }

  /**
   * Cancellation deliberately clears the worker lease, so the normal
   * checkpoint cannot be used for this one permitted agent-run transition.
   * Re-check the exact cancelled row first; a queued/reclaimed retry must not
  * allow the old worker to mutate the run.
  */
  private finishCancelledAgentRun(job: QueueJob, bugId: string, id: string): void {
    let currentJob: QueueJob;
    try { currentJob = this.queue.getJob(job.id); } catch { return; }
    const row = this.repo.database.prepare('SELECT status FROM bug_reports WHERE id = ? OR bug_key = ?').get(bugId, bugId) as { status?: string } | undefined;
    const sameOwnedCancelled = currentJob.status === 'RUNNING' && currentJob.workerId === job.workerId && currentJob.leaseToken === job.leaseToken && row?.status === 'CANCELLED';
    if (currentJob.status !== 'CANCELLED' && !sameOwnedCancelled) return;
    this.repo.database.prepare('UPDATE agent_runs SET status = \'CANCELLED\', finished_at = ?, output = NULL, error = NULL, failure_class = NULL WHERE id = ? AND status = \'RUNNING\'').run(now(), id);
  }

  private beginAgentRun(bug: BugReport, job: QueueJob, role: Role, attempt: number, backendId: string, model: string | null, leaseToken: string | null, input: Record<string, unknown>): string {
    this.checkpoint(job, bug.id);
    const id = newId();
    this.repo.createAgentRun({ id, bugId: bug.id, jobId: job.id, agentType: role, status: 'RUNNING', sessionId: null, startedAt: now(), finishedAt: null, input, output: null, error: null, backendId, model, roleAttempt: attempt, failureClass: null, leaseToken });
    return id;
  }

  private async prepareTaskRepository(job: QueueJob, bug: BugReport, artifactDir: string): Promise<{ profile: EnvironmentProfile; resolved: ResolvedEnvironment; repositoryPath: string }> {
    const taskRepository = this.repo.getTaskRepository(bug.id);
    if (!taskRepository) {
      const resolved = this.envResolver.resolveProfile(bug.executionTarget, bug.environmentProfileId ?? undefined);
      return { profile: resolved.profile, resolved, repositoryPath: resolved.profile.repository };
    }
    let repositoryPath = taskRepository.repositoryPath;
    if (!repositoryPath || taskRepository.status !== 'READY') {
      const checkoutId = taskRepository.checkoutId ?? `bug-${bug.bugKey.toLowerCase()}-${Math.max(1, taskRepository.attempt + 1)}`;
      const startedAt = now();
      this.checkpoint(job, bug.id); this.repo.updateTaskRepository(taskRepository.id, { status: 'CLONING', checkoutId, attempt: taskRepository.attempt + 1, startedAt, heartbeatAt: startedAt, error: null, errorCode: null, finishedAt: null });
      try {
        repositoryPath = await this.repoManager.cloneRemoteRepository(taskRepository.cloneUrl, checkoutId);
        const finishedAt = now();
        this.checkpoint(job, bug.id); this.repo.updateTaskRepository(taskRepository.id, { status: 'READY', repositoryPath, finishedAt, heartbeatAt: finishedAt });
      } catch (error) {
        this.checkpoint(job, bug.id); this.repo.updateTaskRepository(taskRepository.id, { status: 'FAILED', error: sanitizeDiagnostic(error instanceof Error ? error.message : String(error), 2048), errorCode: 'CLONE_FAILED', finishedAt: now() });
        throw error;
      }
    }
    let resolved: ResolvedEnvironment;
    try { resolved = this.envResolver.resolveProfile(bug.executionTarget, bug.environmentProfileId ?? undefined); }
    catch {
      const target = bug.executionTarget === 'backend' ? 'backend' : 'frontend';
      const profile = EnvironmentProfileSchema.parse({ id: `external-${bug.bugKey.toLowerCase()}`, name: `External ${bug.bugKey}`, target, type: target, repository: repositoryPath!, repoUrl: taskRepository.cloneUrl, defaultBranch: taskRepository.baseBranch, baseBranch: taskRepository.baseBranch, instructions: [], markdown: [], skills: [], documentationPaths: [], skillPaths: [], setupCommands: [], validationCommands: [], setup: [], validation: [], runtime: { startupTimeoutSeconds: 120 } });
      resolved = { profile, context: [], markdown: [], skills: [], docsContent: '', skillContent: '' };
    }
    const profile = { ...resolved.profile, repository: repositoryPath!, repoUrl: taskRepository.cloneUrl, defaultBranch: taskRepository.baseBranch, baseBranch: taskRepository.baseBranch } as EnvironmentProfile;
    this.checkpoint(job, bug.id); this.repo.updateTaskRepository(taskRepository.id, { profileId: profile.id, repositoryPath });
    this.fencedArtifact(job, bug.id, artifactDir, 'repository.json', { checkoutId: taskRepository.checkoutId, profileId: profile.id, status: 'READY' });
    return { profile, resolved: { ...resolved, profile }, repositoryPath: repositoryPath! };
  }

  private classify(error: unknown): BackendFailureClass {
    const explicit = error && typeof error === 'object' ? (error as { failureClass?: unknown }).failureClass : undefined;
    if (typeof explicit === 'string' && BackendFailureClassSchema.safeParse(explicit).success) return explicit as BackendFailureClass;
    if (error instanceof PiAgentOutputFormatError) return 'contract';
    if (error instanceof Error && /no diff|no changed files/iu.test(error.message)) return 'no_diff';
    return classifyBackendFailure(error) as BackendFailureClass;
  }

  private async processFixerAttempt(job: QueueJob, bug: BugReport, task: CodingTask, profile: EnvironmentProfile, resolved: ResolvedEnvironment, worktreePath: string, cancellation: AbortSignal, artifactDir: string, attempt: number, tracker: BackendAttemptTracker, fixerBackendIds: string[]): Promise<{ result: FixResult; backendId: string; diff: string; files: string[] }> {
    const selected = await this.acquireRole(job, 'fixer', task, cancellation, tracker.attemptedBackendIds());
    let leaseReleased = false;
    let attemptDir: string;
    let input: { bugKey: string; role: string; backendId: string; model: string | null; attempt: number };
    let runId: string;
    try {
      // Backend capacity acquisition can wait; fence again before creating
      // any attempt directory or agent-run record.
      this.checkpoint(job, bug.id);
      tracker.record(selected.backendId); fixerBackendIds.push(selected.backendId);
      attemptDir = path.join(artifactDir, 'attempts', `run-${job.id}-${job.attempt}`, `fixer-${String(attempt).padStart(2, '0')}-${selected.backendId}`);
      fs.mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(attemptDir, 0o700); } catch { /* best effort */ }
      input = { bugKey: bug.bugKey, role: 'fixer', backendId: selected.backendId, model: selected.lease?.model ?? null, attempt };
      runId = this.beginAgentRun(bug, job, 'fixer', attempt, selected.backendId, selected.lease?.model ?? null, selected.lease?.leaseId ?? null, input);
    } catch (error) { if (selected.lease) { try { this.options.dispatcher!.release(selected.lease); } catch { /* release is best effort during fencing */ } } throw error; }
    const runnerInput = { worktreePath, task, profile, safety: 'No network, push, merge, deploy, production access, or dependency downloads.', docs: resolved.markdown.map((x) => ({ path: x.path, content: x.content })), skills: resolved.skills.map((x) => ({ path: x.path, content: x.content })), attachments: this.attachmentsFor(bug).map((x) => ({ id: x.id, text: x.extractedText ?? undefined, analysis: x.analysisResult ?? undefined })), signal: cancellation, progress: this.progressSink(job, job.id, bug.id), backendId: selected.backendId };
    try {
      this.checkpoint(job, bug.id);
      const raw = task.taskType === 'development' ? await selected.runner.runCoder!(runnerInput as never) : await selected.runner.runFixer({ ...runnerInput, task: BugFixTaskSchema.parse(task) });
      const result = task.taskType === 'development' ? AgentTaskResultSchema.parse(raw) : AgentFixResultSchema.strict().parse(raw);
      // Backend capacity covers only the live Pi session. Diff collection and
      // result persistence are local operations and must not hold the slot.
      this.checkpoint(job, bug.id);
      if (selected.lease) { this.options.dispatcher!.complete(selected.lease); leaseReleased = true; }
      const files = await this.repoManager.filesChanged(worktreePath); const diff = await this.repoManager.diff(worktreePath);
      if (!diff.trim() || !files.length) throw Object.assign(new Error('Fixer produced no diff'), { failureClass: 'no_diff' });
      this.fencedArtifact(job, bug.id, attemptDir, 'metadata.json', input); this.fencedArtifact(job, bug.id, attemptDir, 'result.json', result);
      this.finishAgentRun(job, bug.id, runId, 'COMPLETED', result, null, null);
      return { result, backendId: selected.backendId, diff, files };
    } catch (error) {
      const ownershipAbort = cancellation.aborted && !this.isLeaseStillOwned(job, bug.id);
      if (error instanceof LeaseFencedError || error instanceof PipelineCancelledError || ownershipAbort) {
        if (this.isExplicitCancellation(job, bug.id)) this.finishCancelledAgentRun(job, bug.id, runId);
        if (selected.lease && !leaseReleased) { try { this.options.dispatcher!.release(selected.lease); } catch { /* release is best effort during fencing */ } }
        throw error;
      }
      const failureClass = this.classify(error);
      if (error instanceof PiAgentOutputFormatError) this.fencedRawArtifact(job, bug.id, attemptDir, 'raw-output.txt', error.rawOutput);
      try { this.fencedRawArtifact(job, bug.id, attemptDir, 'diff.patch', await this.repoManager.diff(worktreePath)); } catch (e) { if (e instanceof LeaseFencedError || e instanceof PipelineCancelledError) throw e; /* evidence is best effort */ }
      this.fencedArtifact(job, bug.id, attemptDir, 'failure.json', { ...input, error: sanitizeDiagnostic(error instanceof Error ? error.message : String(error), 2048), failureClass });
      this.finishAgentRun(job, bug.id, runId, cancellation.aborted ? 'CANCELLED' : 'FAILED', null, error, failureClass);
      if (selected.lease && !leaseReleased) this.options.dispatcher!.fail(selected.lease, failureClass);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { failureClass, backendId: selected.backendId });
    } finally {
      // Fencing can happen while persisting failure evidence.  Keep backend
      // capacity from leaking even when that persistence throws first.
      if (selected.lease && !leaseReleased) { try { this.options.dispatcher!.release(selected.lease); } catch { /* best effort */ } }
    }
  }

  private async processReviewerAttempt(job: QueueJob, bug: BugReport, task: CodingTask, profile: EnvironmentProfile, worktreePath: string, cancellation: AbortSignal, artifactDir: string, attempt: number, tracker: BackendAttemptTracker, fixerBackendId: string, diff: string, files: string[], validation: DeterministicValidation): Promise<{ review: ReturnType<typeof ReviewResultSchema.parse>; backendId: string }> {
    const excluded = fixerBackendId ? [fixerBackendId, ...tracker.attemptedBackendIds()] : tracker.attemptedBackendIds();
    let selected: { lease: BackendLease | null; runner: AgentRunner; backendId: string };
    try { selected = await this.acquireRole(job, 'reviewer', task, cancellation, excluded); }
    catch (error) {
      if (!this.options.dispatcher || (error as { code?: string }).code !== 'NO_ELIGIBLE_BACKEND') throw error;
      selected = await this.acquireRole(job, 'reviewer', task, cancellation, tracker.attemptedBackendIds());
    }
    let leaseReleased = false;
    let attemptDir: string;
    let input: { bugKey: string; role: string; backendId: string; model: string | null; attempt: number };
    let runId: string;
    try {
      this.checkpoint(job, bug.id);
      tracker.record(selected.backendId);
      attemptDir = path.join(artifactDir, 'attempts', `run-${job.id}-${job.attempt}`, `reviewer-${String(attempt).padStart(2, '0')}-${selected.backendId}`);
      fs.mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(attemptDir, 0o700); } catch { /* best effort */ }
      input = { bugKey: bug.bugKey, role: 'reviewer', backendId: selected.backendId, model: selected.lease?.model ?? null, attempt };
      runId = this.beginAgentRun(bug, job, 'reviewer', attempt, selected.backendId, selected.lease?.model ?? null, selected.lease?.leaseId ?? null, input);
    } catch (error) { if (selected.lease) { try { this.options.dispatcher!.release(selected.lease); } catch { /* release is best effort during fencing */ } } throw error; }
    try {
      this.checkpoint(job, bug.id);
      const reviewSchema = task.taskType === 'development' ? DevelopmentReviewResultSchema.strict() : BugReviewResultSchema.strict();
      const review = reviewSchema.parse(await selected.runner.runReviewer({ worktreePath, task, profile, diff, filesChanged: files, validation, signal: cancellation, progress: this.progressSink(job, job.id, bug.id), backendId: selected.backendId }));
      this.checkpoint(job, bug.id);
      if (selected.lease) { this.options.dispatcher!.complete(selected.lease); leaseReleased = true; }
      this.fencedArtifact(job, bug.id, attemptDir, 'metadata.json', input); this.fencedArtifact(job, bug.id, attemptDir, 'result.json', review);
      this.finishAgentRun(job, bug.id, runId, 'COMPLETED', review, null, null);
      return { review, backendId: selected.backendId };
    } catch (error) {
      const ownershipAbort = cancellation.aborted && !this.isLeaseStillOwned(job, bug.id);
      if (error instanceof LeaseFencedError || error instanceof PipelineCancelledError || ownershipAbort) {
        if (this.isExplicitCancellation(job, bug.id)) this.finishCancelledAgentRun(job, bug.id, runId);
        if (selected.lease && !leaseReleased) { try { this.options.dispatcher!.release(selected.lease); } catch { /* release is best effort during fencing */ } }
        throw error;
      }
      const failureClass = this.classify(error);
      if (error instanceof PiAgentOutputFormatError) this.fencedRawArtifact(job, bug.id, attemptDir, 'raw-output.txt', error.rawOutput);
      this.fencedRawArtifact(job, bug.id, attemptDir, 'diff.patch', diff);
      this.fencedArtifact(job, bug.id, attemptDir, 'failure.json', { ...input, error: sanitizeDiagnostic(error instanceof Error ? error.message : String(error), 2048), failureClass });
      this.finishAgentRun(job, bug.id, runId, cancellation.aborted ? 'CANCELLED' : 'FAILED', null, error, failureClass);
      if (selected.lease && !leaseReleased) this.options.dispatcher!.fail(selected.lease, failureClass);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { failureClass, backendId: selected.backendId });
    } finally {
      if (selected.lease && !leaseReleased) { try { this.options.dispatcher!.release(selected.lease); } catch { /* best effort */ } }
    }
  }

  private async processJob(job: QueueJob): Promise<void> {
    const bug = this.repo.getBug(job.bugId);
    const workerId = job.workerId;
    const leaseToken = job.leaseToken;
    if (!workerId || !leaseToken) return;
    if (!bug) { try { this.queue.failJob(job.id, `Bug report not found: ${job.bugId}`, workerId, leaseToken); } catch { /* stale owner */ } return; }
    const artifactDir = path.join(this.options.artifactRoot, bug.bugKey);
    fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(artifactDir, 0o700); } catch { /* best effort */ }
    const pipeline: PipelineArtifact = { bugKey: bug.bugKey, status: 'RUNNING', startedAt: now() };
    const cancellation = new AbortController();
    let leaseLost = false;
    let terminalArtifactWritten = false;
    const markLeaseLost = (): void => { leaseLost = true; if (!cancellation.signal.aborted) cancellation.abort(); };
    const heartbeatTimer = setInterval(() => {
      try {
        this.queue.heartbeat(job.id, workerId, leaseToken);
        // A test/durable queue implementation may return a stale row instead
        // of throwing.  Verify the returned ownership as well.
        if (!this.isLeaseStillOwned(job, job.bugId) && !this.isExplicitCancellation(job, job.bugId)) markLeaseLost();
      } catch (error) {
        if (this.isExplicitCancellation(job, job.bugId)) cancellation.abort();
        else markLeaseLost();
        logger.warn({ jobId: job.id, error: error instanceof Error ? error.message : String(error) }, 'Job heartbeat failed');
      }
    }, this.options.heartbeatIntervalMs);
    heartbeatTimer.unref();
    const cancellationTimer = setInterval(() => {
      try {
        const current = this.queue.getJob(job.id); const row = this.repo.database.prepare('SELECT status FROM bug_reports WHERE id = ? OR bug_key = ?').get(job.bugId, job.bugId) as { status?: string } | undefined;
        if (current.status === 'CANCELLED' || row?.status === 'CANCELLED') cancellation.abort();
        else {
          const expiry = current.leaseExpiresAt == null ? null : Date.parse(current.leaseExpiresAt);
          if (current.status !== 'RUNNING' || current.workerId !== workerId || current.leaseToken !== leaseToken || (expiry !== null && (!Number.isFinite(expiry) || expiry <= Date.now()))) markLeaseLost();
        }
      } catch { markLeaseLost(); }
    }, 250);
    cancellationTimer.unref();
    let worktreePath: string | undefined; let profile: EnvironmentProfile | undefined; let resolved: ResolvedEnvironment | undefined; let environmentPrepared = false; let pushing = false; let branch: string | undefined; let baseCommit: string | undefined; let candidate: { diff: string; baseCommit: string; reason: FixCandidateMetadata['reason'] } | undefined; let fixerBackendId = '';
    const writeTerminalArtifact = (): void => { pipeline.finishedAt = now(); this.fencedArtifact(job, bug.id, artifactDir, 'pipeline.json', pipeline); terminalArtifactWritten = true; };
    const writeCancelledArtifact = (): void => {
      // A cancelled queue row is an explicit administrative outcome.  It no
      // longer has a worker lease, so only write while that exact cancelled
      // row still exists (never after a retry has been reclaimed).
      try {
        const current = this.queue.getJob(job.id);
        if (current.status !== 'CANCELLED' && !(current.status === 'RUNNING' && current.workerId === workerId && current.leaseToken === leaseToken)) return;
        pipeline.finishedAt = now(); this.writeArtifact(artifactDir, 'pipeline.json', pipeline); terminalArtifactWritten = true;
      } catch { /* stale cancellation artifact is intentionally discarded */ }
    };
    try {
      this.checkpoint(job, job.bugId); this.fencedArtifact(job, bug.id, artifactDir, 'pipeline.json', pipeline); this.queue.heartbeat(job.id, workerId, leaseToken); this.checkpoint(job, job.bugId); await this.transition(job, bug, 'PREPARING_ENV');
      const prepared = await this.prepareTaskRepository(job, bug, artifactDir); profile = prepared.profile; resolved = prepared.resolved;
      const task = this.taskFor(bug, profile);
      this.fencedArtifact(job, bug.id, artifactDir, 'bug.json', bug); this.fencedArtifact(job, bug.id, artifactDir, 'environment.json', { profile, markdown: resolved.markdown.map((x) => x.path), skills: resolved.skills.map((x) => x.path) }); this.fencedArtifact(job, bug.id, artifactDir, 'fix-task.json', task); this.fencedArtifact(job, bug.id, artifactDir, 'task.json', bug); this.fencedArtifact(job, bug.id, artifactDir, 'coding-task.json', task);
      branch = this.repoManager.createBranchName(bug.bugKey, bug.title);
      const candidateFile = path.join(artifactDir, 'candidate.json'); const candidateMetadata = fs.existsSync(candidateFile) ? FixCandidateMetadataSchema.parse(JSON.parse(fs.readFileSync(candidateFile, 'utf8'))) : undefined;
      if (candidateMetadata && candidateMetadata.bugKey !== bug.bugKey) throw new Error(`Candidate metadata bugKey mismatch: ${candidateMetadata.bugKey}`);
      if (candidateMetadata) worktreePath = await this.repoManager.setupWorktreeAtCommit(bug.bugKey, profile.repository, branch, candidateMetadata.baseCommit);
      else { await this.repoManager.cleanupWorktree(bug.bugKey, profile.repository, branch); worktreePath = await this.repoManager.setupWorktree(bug.bugKey, profile.repository, branch, profile.defaultBranch); }
      if (candidateMetadata) {
        const patchPath = path.join(artifactDir, candidateMetadata.patchFile);
        const patch = fs.readFileSync(patchPath, 'utf8');
        if (Buffer.byteLength(patch) !== candidateMetadata.patchBytes || createHash('sha256').update(patch).digest('hex').toLowerCase() !== candidateMetadata.patchSha256.toLowerCase()) throw new Error('Candidate patch metadata does not match artifact');
        await this.repoManager.applyPatch(worktreePath, patch, candidateMetadata.baseCommit);
      }
      baseCommit = await this.repoManager.headCommit(worktreePath); this.checkpoint(job, job.bugId);
      const environment = await this.envRunner.prepareEnvironment(worktreePath, profile, cancellation.signal); environmentPrepared = true; this.fencedArtifact(job, bug.id, artifactDir, 'environment-run.json', environment); this.checkpoint(job, job.bugId);
      if (environment.status !== 'ENV_READY') { await this.transition(job, bug, 'ENVIRONMENT_FAILED', environment); pipeline.status = 'ENVIRONMENT_FAILED'; pipeline.error = environment.error; writeTerminalArtifact(); this.queue.failJob(job.id, environment.error ?? 'Environment failed', workerId, leaseToken, 'unknown'); return; }
      await this.transition(job, bug, 'FIXING');
      const fixerTracker = new BackendAttemptTracker('fixer'); let fix: { result: FixResult; backendId: string; diff: string; files: string[] } | undefined; let lastFailure: unknown;
      if (candidateMetadata) {
        const candidateFiles = await this.repoManager.filesChanged(worktreePath); const candidateDiff = await this.repoManager.diff(worktreePath);
        if (!candidateFiles.length || !candidateDiff.trim()) throw new Error('Candidate patch produced no changed files');
        const recovered = task.taskType === 'development'
          ? AgentTaskResultSchema.parse({ bugKey: bug.bugKey, taskType: 'development', status: 'completed', confidence: 0, summary: 'Recovered coding candidate; completion report was unavailable.', filesChanged: candidateFiles, validationNotes: [], riskNotes: ['Recovered patch requires deterministic validation and reviewer approval.'], blockedReason: null, missingInformation: ['Original coder completion was unavailable.'], developmentDetails: { requirementsAddressed: [], acceptanceCriteriaAddressed: [], designNotes: ['Coverage must be established by validation and reviewer evidence.'] } })
          : AgentFixResultSchema.strict().parse({ bugKey: bug.bugKey, status: 'fixed', confidence: 0, summary: 'Recovered fixer candidate; completion report was unavailable.', rootCause: null, reproduced: false, regressionTestAdded: false, filesChanged: candidateFiles, riskNotes: ['Recovered patch requires deterministic validation and reviewer approval.'], blockedReason: null, missingInformation: ['Original fixer completion was unavailable.'] });
        fix = { result: recovered, backendId: '', diff: candidateDiff, files: candidateFiles };
      } else {
        for (let attempt = 1; attempt <= 2 && !fix; attempt += 1) {
          try { fix = await this.processFixerAttempt(job, bug, task, profile, resolved, worktreePath, cancellation.signal, artifactDir, attempt, fixerTracker, []); fixerBackendId = fix.backendId; }
          catch (error) {
            lastFailure = error; const failureClass = (error as { failureClass?: BackendFailureClass }).failureClass ?? this.classify(error);
            if (cancellation.signal.aborted) throw new PipelineCancelledError();
            if (isInfrastructureFailure(failureClass)) {
              try { const failedDiff = await this.repoManager.diff(worktreePath); if (failedDiff.trim() && baseCommit) candidate = { diff: failedDiff, baseCommit, reason: failureClass === 'timeout' ? 'fixer_timeout' : 'fixer_error' }; } catch { /* evidence is best effort */ }
            }
            if (isInfrastructureFailure(failureClass) && attempt < 2 && this.options.dispatcher) {
              if (environmentPrepared) { try { this.fencedArtifact(job, bug.id, artifactDir, 'environment-stop.json', await this.envRunner.stopEnvironment(worktreePath, profile)); } catch (error) { if (error instanceof LeaseFencedError || error instanceof PipelineCancelledError) throw error; /* cleanup */ } environmentPrepared = false; }
              try { await this.repoManager.cleanup(worktreePath, profile.repository, branch); } catch { /* recreation will report failure */ }
              worktreePath = await this.repoManager.setupWorktreeAtCommit(bug.bugKey, profile.repository, branch, baseCommit!);
              const retryEnvironment = await this.envRunner.prepareEnvironment(worktreePath, profile, cancellation.signal); environmentPrepared = true; this.fencedArtifact(job, bug.id, artifactDir, 'environment-retry.json', retryEnvironment);
              if (retryEnvironment.status !== 'ENV_READY') throw new Error(retryEnvironment.error ?? 'Environment failed while retrying fixer');
              continue;
            }
            break;
          }
        }
      }
      if (!fix) {
        if (candidate && baseCommit) {
          const metadata = FixCandidateMetadataSchema.parse({ bugKey: bug.bugKey, patchFile: 'diff.patch', patchSha256: createHash('sha256').update(candidate.diff).digest('hex'), patchBytes: Buffer.byteLength(candidate.diff), baseCommit, reason: candidate.reason, createdAt: now() });
          this.fencedRawArtifact(job, bug.id, artifactDir, 'diff.patch', candidate.diff); this.fencedArtifact(job, bug.id, artifactDir, 'candidate.json', metadata); await this.transition(job, bug, 'FIX_CANDIDATE', { ...metadata, error: sanitizeDiagnostic(lastFailure instanceof Error ? lastFailure.message : String(lastFailure ?? 'Fixer failed'), 2048) }); pipeline.status = 'FIX_CANDIDATE'; pipeline.error = 'Fixer backend failed; candidate requires manual retry'; writeTerminalArtifact(); this.queue.failJob(job.id, 'Fixer backend failed; candidate requires manual retry', workerId, leaseToken, (lastFailure as { failureClass?: string })?.failureClass);
        } else {
          const error = lastFailure instanceof Error ? lastFailure.message : 'Fixer failed'; await this.transition(job, bug, 'FIX_FAILED', { error: sanitizeDiagnostic(error, 2048) }); pipeline.status = 'FIX_FAILED'; pipeline.error = error; writeTerminalArtifact(); this.queue.failJob(job.id, error, workerId, leaseToken, (lastFailure as { failureClass?: string })?.failureClass);
        }
        return;
      }
      let fixResult = fix.result; this.fencedArtifact(job, bug.id, artifactDir, 'agent-result.json', fixResult); fixResult = task.taskType === 'development' ? AgentTaskResultSchema.parse({ ...fixResult, filesChanged: fix.files }) : AgentFixResultSchema.strict().parse({ ...fixResult, filesChanged: fix.files }); this.fencedArtifact(job, bug.id, artifactDir, 'agent-result.json', fixResult);
      const completed = task.taskType === 'development' ? fixResult.status === 'completed' : fixResult.status === 'fixed';
      if (!completed) { await this.transition(job, bug, 'FIX_FAILED', fixResult); pipeline.status = 'FIX_FAILED'; pipeline.error = fixResult.blockedReason; writeTerminalArtifact(); this.queue.failJob(job.id, fixResult.blockedReason ?? 'Coding agent failed', workerId, leaseToken, 'agent_failed'); return; }
      await this.transition(job, bug, 'VALIDATING'); const validationCommands = profile.validationCommands.length ? profile.validationCommands : profile.validation; const validation = DeterministicValidationSchema.parse(await this.validator.runValidation(worktreePath, validationCommands, { signal: cancellation.signal })); this.fencedArtifact(job, bug.id, artifactDir, 'validation.json', validation); this.checkpoint(job, job.bugId);
      if (!validation.passed) { await this.transition(job, bug, 'VALIDATION_FAILED', validation); pipeline.status = 'VALIDATION_FAILED'; pipeline.error = 'Deterministic validation failed'; writeTerminalArtifact(); this.queue.failJob(job.id, 'Deterministic validation failed', workerId, leaseToken, 'validation_failed'); return; }
      await this.transition(job, bug, 'REVIEWING'); const diff = await this.repoManager.diff(worktreePath); const files = await this.repoManager.filesChanged(worktreePath); this.fencedRawArtifact(job, bug.id, artifactDir, 'diff.patch', diff);
      const reviewerTracker = new BackendAttemptTracker('reviewer'); let reviewResult: ReturnType<typeof ReviewResultSchema.parse> | undefined; let reviewerLastFailure: unknown;
      for (let attempt = 1; attempt <= 2 && !reviewResult; attempt += 1) { try { reviewResult = (await this.processReviewerAttempt(job, bug, task, profile, worktreePath, cancellation.signal, artifactDir, attempt, reviewerTracker, fixerBackendId, diff, files, validation)).review; } catch (error) { reviewerLastFailure = error; if (cancellation.signal.aborted) throw new PipelineCancelledError(); const failureClass = (error as { failureClass?: BackendFailureClass }).failureClass ?? this.classify(error); const retryable = isInfrastructureFailure(failureClass) || failureClass === 'contract'; if (!retryable || attempt >= 2 || !this.options.dispatcher) break; } }
      if (!reviewResult) { const error = 'Reviewer backend failed'; await this.transition(job, bug, 'FIX_FAILED', { phase: 'reviewer', error: sanitizeDiagnostic(reviewerLastFailure instanceof Error ? reviewerLastFailure.message : String(reviewerLastFailure ?? 'Reviewer failed'), 2048) }); pipeline.status = 'FIX_FAILED'; pipeline.error = error; writeTerminalArtifact(); this.queue.failJob(job.id, error, workerId, leaseToken, (reviewerLastFailure as { failureClass?: string })?.failureClass); return; }
      this.fencedArtifact(job, bug.id, artifactDir, 'review.json', reviewResult); const acceptance = reviewResult.acceptanceCriteriaMet ?? []; const addressed = task.taskType === 'development' ? reviewResult.taskAddressed === true && acceptance.length === task.acceptanceCriteria.length && acceptance.every((item) => item.met) : reviewResult.bugAddressed === true;
      if (reviewResult.verdict !== 'approve' || !addressed || reviewResult.regressionRisk === 'high') { await this.transition(job, bug, 'REVIEW_REJECTED', reviewResult); pipeline.status = 'REVIEW_REJECTED'; pipeline.error = reviewResult.summary; writeTerminalArtifact(); this.queue.failJob(job.id, `Review gate rejected: ${reviewResult.summary}`, workerId, leaseToken, 'review_rejected'); return; }
      await this.transition(job, bug, 'FIX_READY', reviewResult); this.fencedArtifact(job, bug.id, artifactDir, 'git-result.json', GitResultSchema.parse({ success: false, branch, commitSha: null, mergeRequestUrl: null, pushed: false, error: this.options.dryRun ? 'DRY_RUN' : null })); if (candidateMetadata) { try { this.checkpoint(job, bug.id); fs.renameSync(candidateFile, path.join(artifactDir, 'candidate-used.json')); } catch (error) { if (error instanceof LeaseFencedError || error instanceof PipelineCancelledError) throw error; /* audit artifact cleanup is best effort */ } } this.checkpoint(job, job.bugId);
      if (this.options.dryRun) { pipeline.status = 'FIX_READY'; writeTerminalArtifact(); this.queue.completeJob(job.id, workerId, leaseToken); return; }
      pushing = true; await this.transition(job, bug, 'PUSHING'); const git = await this.repoManager.commitAndPush(worktreePath, branch!, `fix(${bug.bugKey}): ${bug.title}`, false); this.checkpoint(job, job.bugId); this.fencedArtifact(job, bug.id, artifactDir, 'git-result.json', GitResultSchema.parse({ success: git.pushed, branch, commitSha: git.commitSha, mergeRequestUrl: null, pushed: git.pushed, error: null })); await this.transition(job, bug, 'READY_FOR_HUMAN_REVIEW'); pipeline.status = 'READY_FOR_HUMAN_REVIEW'; writeTerminalArtifact(); this.queue.completeJob(job.id, workerId, leaseToken);
    } catch (error) {
      const explicitCancelled = this.isExplicitCancellation(job, bug.id);
      const fenced = leaseLost || error instanceof LeaseFencedError || (!explicitCancelled && cancellation.signal.aborted && !this.isLeaseStillOwned(job, bug.id));
      const cancelled = explicitCancelled || (error instanceof PipelineCancelledError && !fenced) || (cancellation.signal.aborted && !fenced);
      if (fenced) { pipeline.status = 'INTERRUPTED'; pipeline.error = 'Worker lease fenced'; return; }
      if (cancelled) { pipeline.status = 'CANCELLED'; pipeline.error = null; try { this.queue.cancelJob(job.id, workerId, leaseToken); } catch { /* administrative cancellation may have won */ } writeCancelledArtifact(); return; }
      const message = error instanceof Error ? error.message : String(error); logger.error({ bugKey: bug.bugKey, error: message }, 'Pipeline failed');
      try { await this.transition(job, bug, pushing ? 'PUSH_FAILED' : 'FIX_FAILED', { error: sanitizeDiagnostic(message, 2048) }); pipeline.status = pushing ? 'PUSH_FAILED' : 'FIX_FAILED'; pipeline.error = message; writeTerminalArtifact(); this.queue.failJob(job.id, message, workerId, leaseToken, (error as { failureClass?: string }).failureClass); } catch { /* preserve queue state and never report a stale failure */ }
    } finally {
      clearInterval(heartbeatTimer); clearInterval(cancellationTimer);
      if (worktreePath && profile && environmentPrepared) { try { this.fencedArtifact(job, bug.id, artifactDir, 'environment-stop.json', await this.envRunner.stopEnvironment(worktreePath, profile)); } catch { /* cleanup must not hide result */ } }
      if (worktreePath && profile) { try { await this.repoManager.cleanup(worktreePath, profile.repository, branch); } catch { /* cleanup must not hide result */ } }
      if (!terminalArtifactWritten) {
        if (pipeline.status === 'CANCELLED') writeCancelledArtifact();
        else if (this.isLeaseStillOwned(job, bug.id)) { try { pipeline.finishedAt = now(); this.fencedArtifact(job, bug.id, artifactDir, 'pipeline.json', pipeline); } catch { /* stale owner */ } }
      }
    }
  }
}
