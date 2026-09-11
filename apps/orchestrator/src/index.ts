import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger, type AppConfig, now } from '@llmbugfix/shared';
import { SQLiteBugRepository } from '@llmbugfix/bug-repository';
import { JobQueue, type QueueJob } from '@llmbugfix/job-queue';
import { EnvironmentResolver, type EnvironmentProfile } from '@llmbugfix/environment-resolver';
import { RepoManager } from '@llmbugfix/repo-manager';
import { EnvironmentRunner } from '@llmbugfix/environment-runner';
import { FakePiRunner, PiAgentOutputFormatError, PiAgentRunnerTimeoutError, PiAgentLoopBudgetError, type AgentRunner } from '@llmbugfix/pi-runner';
import { Validator, DeterministicValidationSchema, type DeterministicValidation } from '@llmbugfix/validator';
import { BugFixTaskSchema, AgentFixResultSchema, FixCandidateMetadataSchema, ReviewResultSchema, GitResultSchema, type AttachmentRef, type BugFixTask, type BugReport, type FixCandidateMetadata } from '@llmbugfix/bug-domain';

const logger = createLogger('orchestrator');
export interface OrchestratorOptions { dryRun?: boolean; workerId?: string; artifactRoot?: string; }
export interface PipelineArtifact { bugKey: string; status: string; startedAt: string; finishedAt?: string; error?: string | null; }
class PipelineCancelledError extends Error { constructor() { super('Pipeline cancelled'); this.name = 'PipelineCancelledError'; } }

export class Orchestrator {
  private timer?: NodeJS.Timeout; private isRunning = false;
  private readonly activeJobs = new Set<Promise<void>>();
  private readonly options: Required<OrchestratorOptions>;
  constructor(private readonly config: AppConfig, private readonly repo: SQLiteBugRepository, private readonly queue: JobQueue, private readonly envResolver: EnvironmentResolver, private readonly repoManager: RepoManager, private readonly envRunner: EnvironmentRunner, private readonly agentRunner: AgentRunner = new FakePiRunner(), private readonly validator: Validator = new Validator(), options: OrchestratorOptions = {}) {
    // Safe by default: only the explicit string DRY_RUN=false enables pushes.
    this.options = { dryRun: options.dryRun ?? ((process.env as Record<string, string | undefined>).DRY_RUN !== 'false'), workerId: options.workerId ?? `worker-${process.pid}`, artifactRoot: options.artifactRoot ?? path.join(config.DATA_ROOT, 'agent-results') };
  }
  start(pollIntervalMs = 2_000): void { this.isRunning = true; this.timer = setInterval(() => { void this.tick(); }, pollIntervalMs); }
  async stop(): Promise<void> { this.isRunning = false; if (this.timer) clearInterval(this.timer); this.timer = undefined; await Promise.allSettled([...this.activeJobs]); }
  private async track(operation: Promise<void>): Promise<void> { this.activeJobs.add(operation); try { await operation; } finally { this.activeJobs.delete(operation); } }
  async tick(): Promise<boolean> { if (!this.isRunning && this.timer) return false; this.queue.recoverStaleJobs(); const job = this.queue.claimNextJob(this.options.workerId); if (!job) return false; await this.track(this.processJob(job.id, job.bugId, this.options.workerId)); return true; }
  async runJob(job: QueueJob): Promise<void> { await this.track(this.processJob(job.id, job.bugId, job.workerId ?? this.options.workerId)); }
  private writeArtifact(dir: string, filename: string, value: unknown): void { fs.writeFileSync(path.join(dir, filename), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
  private writeRawArtifact(dir: string, filename: string, value: string): void { fs.writeFileSync(path.join(dir, filename), value, { mode: 0o600 }); }
  private async transition(bug: BugReport, status: Parameters<SQLiteBugRepository['changeBugStatus']>[1], payload: unknown = {}): Promise<void> { this.repo.changeBugStatus(bug.bugKey, status, 'pipeline', payload); }
  private attachmentsFor(bug: BugReport): AttachmentRef[] {
    // The repository table is authoritative for uploads; the report projection
    // may contain attachments from before that table was introduced.
    let persisted: AttachmentRef[] = [];
    try { persisted = this.repo.listAttachments(bug.id); } catch { try { persisted = this.repo.listAttachments(bug.bugKey); } catch { /* legacy repository without attachment rows */ } }
    const categories = ['logs', 'screenshots', 'videos', 'networkTraces', 'jsonFiles', 'otherFiles'] as const;
    const merged = [...persisted, ...categories.flatMap((category) => bug.evidence[category])]; const seen = new Set<string>();
    return merged.filter((attachment) => !seen.has(attachment.id) && (seen.add(attachment.id), true));
  }
  private taskFor(bug: BugReport, profile: EnvironmentProfile, attachments = this.attachmentsFor(bug)): BugFixTask { return BugFixTaskSchema.parse({ bugKey: bug.bugKey, title: bug.title, executionTarget: profile.target, environmentProfileId: profile.id, actualBehavior: bug.actualBehavior, expectedBehavior: bug.expectedBehavior, reproductionSteps: bug.reproduction.steps, prerequisites: bug.reproduction.prerequisites, environment: bug.environment.additionalInfo, errorMessages: bug.evidence.errorMessages, stackTraces: bug.evidence.stackTraces, attachments, lastKnownGoodVersion: bug.regression.lastKnownGoodVersion, failingVersion: bug.regression.suspectedVersion, reporterObservations: bug.observations, reporterHypotheses: bug.reporterHypotheses, machineObservations: [], missingInformation: bug.intake.missingInformation, completenessScore: bug.intake.completenessScore }); }
  private checkpoint(jobId: string, bugId: string): BugReport {
    const job = this.queue.getJob(jobId); const current = this.repo.getBug(bugId);
    if (!current) throw new PipelineCancelledError();
    const row = this.repo.database.prepare('SELECT status FROM bug_reports WHERE id = ? OR bug_key = ?').get(bugId, bugId) as { status?: string } | undefined;
    if (job.status === 'CANCELLED' || row?.status === 'CANCELLED') throw new PipelineCancelledError();
    return current;
  }
  private async processJob(jobId: string, bugId: string, workerId: string): Promise<void> {
    const bug = this.repo.getBug(bugId); if (!bug) { this.queue.failJob(jobId, `Bug report not found: ${bugId}`, workerId); return; }
    const heartbeatTimer = setInterval(() => { try { const job = this.queue.getJob(jobId); if (job.status === 'RUNNING' && job.workerId === workerId) this.queue.heartbeat(jobId, workerId); } catch (error) { logger.warn({ bugKey: bug.bugKey, error: error instanceof Error ? error.message : String(error) }, 'Job heartbeat failed'); } }, 15_000); heartbeatTimer.unref();
    const artifactDir = path.join(this.options.artifactRoot, bug.bugKey); fs.mkdirSync(artifactDir, { recursive: true }); const pipeline: PipelineArtifact = { bugKey: bug.bugKey, status: 'RUNNING', startedAt: now() }; this.writeArtifact(artifactDir, 'pipeline.json', pipeline);
    const cancellation = new AbortController(); const cancellationTimer = setInterval(() => { try { const current = this.queue.getJob(jobId); const row = this.repo.database.prepare('SELECT status FROM bug_reports WHERE id = ? OR bug_key = ?').get(bugId, bugId) as { status?: string } | undefined; if (current.status === 'CANCELLED' || row?.status === 'CANCELLED') cancellation.abort(); } catch { /* final checkpoint handles missing jobs */ } }, 250); cancellationTimer.unref();
    let worktreePath: string | undefined; let profile: EnvironmentProfile | undefined; let environmentPrepared = false; let pushing = false; let branch: string | undefined; let baseCommit: string | undefined;
    let fixerInFlight = false;
    let candidateMetadata: FixCandidateMetadata | undefined;
    try {
      this.checkpoint(jobId, bugId); this.queue.heartbeat(jobId, workerId);
      await this.transition(bug, 'PREPARING_ENV'); this.checkpoint(jobId, bugId);
      const candidatePath = path.join(artifactDir, 'candidate.json');
      if (fs.existsSync(candidatePath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
          candidateMetadata = FixCandidateMetadataSchema.parse(parsed);
          if (candidateMetadata.bugKey !== bug.bugKey) throw new Error(`Candidate bugKey mismatch: ${candidateMetadata.bugKey}`);
        } catch (error) { throw new Error(`Candidate metadata is invalid: ${error instanceof Error ? error.message : String(error)}`); }
      }
      const resolved = this.envResolver.resolveProfile(bug.executionTarget, bug.environmentProfileId ?? undefined); profile = resolved.profile; const attachments = this.attachmentsFor(bug); const task = this.taskFor(bug, profile, attachments);
      this.writeArtifact(artifactDir, 'bug.json', bug); this.writeArtifact(artifactDir, 'environment.json', { profile, markdown: resolved.markdown.map((x) => x.path), skills: resolved.skills.map((x) => x.path) }); this.writeArtifact(artifactDir, 'fix-task.json', task);
      branch = this.repoManager.createBranchName(bug.bugKey, bug.title); this.checkpoint(jobId, bugId);
      // A retry may leave a registered worktree (or just its directory). Ask
      // Git to unregister this exact BUG target before creating it again.
      if (candidateMetadata) worktreePath = await this.repoManager.setupWorktreeAtCommit(bug.bugKey, profile.repository, branch, candidateMetadata.baseCommit);
      else { await this.repoManager.cleanupWorktree(bug.bugKey, profile.repository, branch); worktreePath = await this.repoManager.setupWorktree(bug.bugKey, profile.repository, branch, profile.defaultBranch); }
      baseCommit = await this.repoManager.headCommit(worktreePath); this.checkpoint(jobId, bugId);
      const environment = await this.envRunner.prepareEnvironment(worktreePath, profile, cancellation.signal); environmentPrepared = true; this.writeArtifact(artifactDir, 'environment-run.json', environment); this.checkpoint(jobId, bugId);
      if (environment.status !== 'ENV_READY') { await this.transition(bug, 'ENVIRONMENT_FAILED', environment); this.queue.failJob(jobId, environment.error ?? 'Environment failed', workerId); pipeline.status = 'ENVIRONMENT_FAILED'; pipeline.error = environment.error; return; }
      this.queue.heartbeat(jobId, workerId); await this.transition(bug, 'FIXING'); this.checkpoint(jobId, bugId);
      let fixResult: ReturnType<typeof AgentFixResultSchema.parse>;
      if (candidateMetadata) {
        const patchFile = path.join(artifactDir, candidateMetadata.patchFile);
        const stat = fs.statSync(patchFile);
        const patch = fs.readFileSync(patchFile, 'utf8');
        const patchBytes = Buffer.byteLength(patch, 'utf8');
        const patchSha256 = createHash('sha256').update(patch).digest('hex');
        if (!stat.isFile() || patchBytes !== candidateMetadata.patchBytes || patchSha256.toLowerCase() !== candidateMetadata.patchSha256.toLowerCase()) throw new Error('Candidate patch metadata does not match artifact');
        await this.repoManager.applyPatch(worktreePath, patch, candidateMetadata.baseCommit);
        const candidateFiles = await this.repoManager.filesChanged(worktreePath);
        if (!candidateFiles.length) throw new Error('Candidate patch produced no changed files');
        fixResult = AgentFixResultSchema.strict().parse({ bugKey: bug.bugKey, status: 'fixed', confidence: 0, summary: 'Recovered fixer candidate; completion report was unavailable.', rootCause: null, reproduced: false, regressionTestAdded: false, filesChanged: candidateFiles, riskNotes: ['Recovered patch requires deterministic validation and reviewer approval.'], blockedReason: null, missingInformation: ['Original fixer completion was unavailable.'] });
        this.writeArtifact(artifactDir, 'agent-result.json', fixResult);
      } else {
        fixerInFlight = true;
        const fixerStartedAt = now();
        const result = await this.agentRunner.runFixer({ worktreePath, task, profile, safety: 'No network, push, merge, deploy, production access, or dependency downloads.', docs: resolved.markdown.map((x) => ({ path: x.path, content: x.content })), skills: resolved.skills.map((x) => ({ path: x.path, content: x.content })), attachments: attachments.map((x) => ({ id: x.id, text: x.extractedText ?? undefined, analysis: x.analysisResult ?? undefined })), signal: cancellation.signal });
        fixerInFlight = false;
        this.checkpoint(jobId, bugId); fixResult = AgentFixResultSchema.strict().parse(result); this.writeArtifact(artifactDir, 'agent-result.json', fixResult);
        this.repo.createAgentRun({ bugId: bug.id, jobId, agentType: 'fixer', status: 'COMPLETED', sessionId: null, startedAt: fixerStartedAt, finishedAt: now(), input: { bugKey: bug.bugKey }, output: fixResult, error: null });
        const actualFiles = await this.repoManager.filesChanged(worktreePath);
        const actualDiff = await this.repoManager.diff(worktreePath);
        if (!actualDiff.trim() || !actualFiles.length) throw new Error('Fixer reported fixed but produced no diff');
        fixResult = AgentFixResultSchema.strict().parse({ ...fixResult, filesChanged: actualFiles }); this.writeArtifact(artifactDir, 'agent-result.json', fixResult);
      }
      if (fixResult.status !== 'fixed') { await this.transition(bug, 'FIX_FAILED', fixResult); this.queue.failJob(jobId, fixResult.blockedReason ?? 'Fixer failed', workerId); pipeline.status = 'FIX_FAILED'; pipeline.error = fixResult.blockedReason; return; }
      await this.transition(bug, 'VALIDATING'); this.checkpoint(jobId, bugId); const validationCommands = profile.validationCommands.length ? profile.validationCommands : profile.validation; const validation = await this.validator.runValidation(worktreePath, validationCommands, { signal: cancellation.signal }); const checkedValidation = DeterministicValidationSchema.parse({ ...validation, results: validation.results }); this.writeArtifact(artifactDir, 'validation.json', checkedValidation); this.checkpoint(jobId, bugId);
      if (!checkedValidation.passed) { await this.transition(bug, 'VALIDATION_FAILED', checkedValidation); this.queue.failJob(jobId, 'Deterministic validation failed', workerId); pipeline.status = 'VALIDATION_FAILED'; pipeline.error = 'Deterministic validation failed'; return; }
      await this.transition(bug, 'REVIEWING'); this.checkpoint(jobId, bugId); const diff = await this.repoManager.diff(worktreePath); this.writeRawArtifact(artifactDir, 'diff.patch', diff); const actualFiles = await this.repoManager.filesChanged(worktreePath); this.checkpoint(jobId, bugId); const review = await this.agentRunner.runReviewer({ worktreePath, task, profile, diff, filesChanged: actualFiles, validation: checkedValidation, signal: cancellation.signal }); this.checkpoint(jobId, bugId); this.writeArtifact(artifactDir, 'review.json', ReviewResultSchema.strict().parse(review));
      if (review.verdict !== 'approve' || !review.bugAddressed || review.regressionRisk === 'high') { await this.transition(bug, 'REVIEW_REJECTED', review); this.queue.failJob(jobId, `Review gate rejected: ${review.summary}`, workerId); pipeline.status = 'REVIEW_REJECTED'; pipeline.error = review.summary; return; }
      await this.transition(bug, 'FIX_READY', review); this.writeArtifact(artifactDir, 'git-result.json', GitResultSchema.parse({ success: false, branch, commitSha: null, mergeRequestUrl: null, pushed: false, error: this.options.dryRun ? 'DRY_RUN' : null }));
      if (candidateMetadata) { try { fs.renameSync(path.join(artifactDir, 'candidate.json'), path.join(artifactDir, 'candidate-used.json')); } catch { /* audit artifact cleanup is best effort */ } }
      this.checkpoint(jobId, bugId);
      if (this.options.dryRun) { pipeline.status = 'FIX_READY'; this.queue.completeJob(jobId, workerId); return; }
      pushing = true; await this.transition(bug, 'PUSHING'); this.checkpoint(jobId, bugId); const git = await this.repoManager.commitAndPush(worktreePath, branch!, `fix(${bug.bugKey}): ${bug.title}`, false); this.checkpoint(jobId, bugId); this.writeArtifact(artifactDir, 'git-result.json', GitResultSchema.parse({ success: git.pushed, branch, commitSha: git.commitSha, mergeRequestUrl: null, pushed: git.pushed, error: null })); await this.transition(bug, 'READY_FOR_HUMAN_REVIEW'); pipeline.status = 'READY_FOR_HUMAN_REVIEW'; this.queue.completeJob(jobId, workerId);
    } catch (error) {
      const cancelled = error instanceof PipelineCancelledError || cancellation.signal.aborted || (() => { try { const row = this.repo.database.prepare('SELECT status FROM bug_reports WHERE id = ? OR bug_key = ?').get(bugId, bugId) as { status?: string } | undefined; return this.queue.getJob(jobId).status === 'CANCELLED' || row?.status === 'CANCELLED'; } catch { return true; } })();
      if (cancelled) { pipeline.status = 'CANCELLED'; pipeline.error = null; return; }
      const message = error instanceof Error ? error.message : String(error); logger.error({ bugKey: bug.bugKey, error: message }, 'Pipeline failed');
      let candidateSaved = false;
      if (worktreePath && profile) {
        if (error instanceof PiAgentOutputFormatError) this.writeRawArtifact(artifactDir, 'agent-raw-output.txt', error.rawOutput);
        try {
          const failureDiff = await this.repoManager.diff(worktreePath);
          // A malformed completion or timeout must not discard a non-empty
          // patch. It is a candidate only: no validation/review/push is
          // skipped, and a later retry re-applies it to a freshly checked base.
          if (fixerInFlight && failureDiff.trim() && baseCommit) {
            const patchBytes = Buffer.byteLength(failureDiff, 'utf8');
            const patchSha256 = createHash('sha256').update(failureDiff).digest('hex');
            // Keep classification stable across package-boundary copies of the
            // error classes (tests and bundled workers can load the same
            // source through different module URLs).
            const errorName = error instanceof Error ? error.name : '';
            const reason: FixCandidateMetadata['reason'] = error instanceof PiAgentOutputFormatError || errorName === 'PiAgentOutputFormatError' ? 'completion_format_failed' : error instanceof PiAgentRunnerTimeoutError || errorName === 'PiAgentRunnerTimeoutError' ? 'fixer_timeout' : error instanceof PiAgentLoopBudgetError || errorName === 'PiAgentLoopBudgetError' ? 'fixer_aborted' : cancellation.signal.aborted ? 'fixer_aborted' : 'fixer_error';
            const candidate = FixCandidateMetadataSchema.parse({ bugKey: bug.bugKey, patchFile: 'diff.patch', patchSha256, patchBytes, baseCommit, reason, createdAt: now() });
            this.writeRawArtifact(artifactDir, 'diff.patch', failureDiff); this.writeArtifact(artifactDir, 'candidate.json', candidate); candidateMetadata = candidate; candidateSaved = true;
          }
        } catch { /* evidence capture is best effort; failure remains fail-closed */ }
      }
      if (candidateSaved) {
        try { await this.transition(bug, 'FIX_CANDIDATE', { ...candidateMetadata, error: message }); } catch { /* preserve queue failure if a concurrent cancellation owns state */ }
        try { this.queue.failJob(jobId, message, workerId); } catch { /* a concurrent cancellation owns the terminal state */ }
        pipeline.status = 'FIX_CANDIDATE'; pipeline.error = message;
      } else {
        try { await this.transition(bug, pushing ? 'PUSH_FAILED' : 'FIX_FAILED', { error: message }); } catch { /* preserve original error */ }
        try { this.queue.failJob(jobId, message, workerId); } catch { /* a concurrent cancellation owns the terminal state */ }
        pipeline.status = pushing ? 'PUSH_FAILED' : 'FAILED'; pipeline.error = message;
      }
    } finally {
      clearInterval(heartbeatTimer); clearInterval(cancellationTimer);
      if (worktreePath && profile && environmentPrepared) { try { const stop = await this.envRunner.stopEnvironment(worktreePath, profile); this.writeArtifact(artifactDir, 'environment-stop.json', stop); } catch { /* cleanup must not hide pipeline result */ } }
      if (worktreePath && profile) { try { await this.repoManager.cleanup(worktreePath, profile.repository, branch); } catch { /* cleanup must not hide pipeline result */ } }
      pipeline.finishedAt = now(); this.writeArtifact(artifactDir, 'pipeline.json', pipeline);
    }
  }
}
