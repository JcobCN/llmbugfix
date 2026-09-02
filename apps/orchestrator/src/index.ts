import fs from 'node:fs';
import path from 'node:path';
import { createLogger, type AppConfig, now } from '@llmbugfix/shared';
import { SQLiteBugRepository } from '@llmbugfix/bug-repository';
import { JobQueue, type QueueJob } from '@llmbugfix/job-queue';
import { EnvironmentResolver, type EnvironmentProfile } from '@llmbugfix/environment-resolver';
import { RepoManager } from '@llmbugfix/repo-manager';
import { EnvironmentRunner } from '@llmbugfix/environment-runner';
import { FakePiRunner, type AgentRunner } from '@llmbugfix/pi-runner';
import { Validator, DeterministicValidationSchema, type DeterministicValidation } from '@llmbugfix/validator';
import { BugFixTaskSchema, AgentFixResultSchema, ReviewResultSchema, GitResultSchema, type BugFixTask, type BugReport } from '@llmbugfix/bug-domain';

const logger = createLogger('orchestrator');
export interface OrchestratorOptions { dryRun?: boolean; workerId?: string; artifactRoot?: string; }
export interface PipelineArtifact { bugKey: string; status: string; startedAt: string; finishedAt?: string; error?: string | null; }

export class Orchestrator {
  private timer?: NodeJS.Timeout; private isRunning = false;
  private readonly options: Required<OrchestratorOptions>;
  constructor(private readonly config: AppConfig, private readonly repo: SQLiteBugRepository, private readonly queue: JobQueue, private readonly envResolver: EnvironmentResolver, private readonly repoManager: RepoManager, private readonly envRunner: EnvironmentRunner, private readonly agentRunner: AgentRunner = new FakePiRunner(), private readonly validator: Validator = new Validator(), options: OrchestratorOptions = {}) {
    this.options = { dryRun: options.dryRun ?? Boolean((process.env as Record<string, string | undefined>).DRY_RUN === 'true'), workerId: options.workerId ?? `worker-${process.pid}`, artifactRoot: options.artifactRoot ?? path.join(config.DATA_ROOT, 'agent-results') };
  }
  start(pollIntervalMs = 2_000): void { this.isRunning = true; this.timer = setInterval(() => { void this.tick(); }, pollIntervalMs); }
  stop(): void { this.isRunning = false; if (this.timer) clearInterval(this.timer); }
  async tick(): Promise<boolean> { if (!this.isRunning && this.timer) return false; this.queue.recoverStaleJobs(); const job = this.queue.claimNextJob(this.options.workerId); if (!job) return false; await this.processJob(job.id, job.bugId, this.options.workerId); return true; }
  async runJob(job: QueueJob): Promise<void> { await this.processJob(job.id, job.bugId, job.workerId ?? this.options.workerId); }
  private writeArtifact(dir: string, filename: string, value: unknown): void { fs.writeFileSync(path.join(dir, filename), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
  private writeRawArtifact(dir: string, filename: string, value: string): void { fs.writeFileSync(path.join(dir, filename), value, { mode: 0o600 }); }
  private async transition(bug: BugReport, status: Parameters<SQLiteBugRepository['changeBugStatus']>[1], payload: unknown = {}): Promise<void> { this.repo.changeBugStatus(bug.bugKey, status, 'pipeline', payload); }
  private taskFor(bug: BugReport, profile: EnvironmentProfile): BugFixTask { return BugFixTaskSchema.parse({ bugKey: bug.bugKey, title: bug.title, executionTarget: bug.executionTarget, environmentProfileId: profile.id, actualBehavior: bug.actualBehavior, expectedBehavior: bug.expectedBehavior, reproductionSteps: bug.reproduction.steps, prerequisites: bug.reproduction.prerequisites, environment: bug.environment.additionalInfo, errorMessages: bug.evidence.errorMessages, stackTraces: bug.evidence.stackTraces, attachments: bug.evidence.logs, lastKnownGoodVersion: bug.regression.lastKnownGoodVersion, failingVersion: bug.regression.suspectedVersion, reporterObservations: bug.observations, reporterHypotheses: bug.reporterHypotheses, machineObservations: [], missingInformation: bug.intake.missingInformation, completenessScore: bug.intake.completenessScore }); }
  private async processJob(jobId: string, bugId: string, workerId: string): Promise<void> {
    const bug = this.repo.getBug(bugId); if (!bug) { this.queue.failJob(jobId, `Bug report not found: ${bugId}`, workerId); return; }
    const artifactDir = path.join(this.options.artifactRoot, bug.bugKey); fs.mkdirSync(artifactDir, { recursive: true }); const pipeline: PipelineArtifact = { bugKey: bug.bugKey, status: 'RUNNING', startedAt: now() }; this.writeArtifact(artifactDir, 'pipeline.json', pipeline);
    let worktreePath: string | undefined; let profile: EnvironmentProfile | undefined; let environmentStarted = false; let pushing = false;
    try {
      this.queue.heartbeat(jobId, workerId); await this.transition(bug, 'PREPARING_ENV');
      const resolved = this.envResolver.resolveProfile(bug.executionTarget, bug.environmentProfileId ?? undefined); profile = resolved.profile;
      this.writeArtifact(artifactDir, 'bug.json', bug); this.writeArtifact(artifactDir, 'environment.json', { profile, markdown: resolved.markdown.map((x) => x.path), skills: resolved.skills.map((x) => x.path) });
      this.writeArtifact(artifactDir, 'fix-task.json', this.taskFor(bug, profile));
      const branch = this.repoManager.createBranchName(bug.bugKey, bug.title); worktreePath = await this.repoManager.setupWorktree(bug.bugKey, profile.repository, branch, profile.defaultBranch); const environment = await this.envRunner.prepareEnvironment(worktreePath, profile); this.writeArtifact(artifactDir, 'environment-run.json', environment);
      if (environment.status !== 'ENV_READY') { await this.transition(bug, 'ENVIRONMENT_FAILED', environment); this.queue.failJob(jobId, environment.error ?? 'Environment failed', workerId); pipeline.status = 'ENVIRONMENT_FAILED'; pipeline.error = environment.error; return; } environmentStarted = true;
      this.queue.heartbeat(jobId, workerId); await this.transition(bug, 'FIXING'); const task = this.taskFor(bug, profile);
      const fixResult = await this.agentRunner.runFixer({ worktreePath, task, profile, safety: 'No network, push, merge, deploy, production access, or dependency downloads.', docs: resolved.markdown.map((x) => ({ path: x.path, content: x.content })), skills: resolved.skills.map((x) => ({ path: x.path, content: x.content })), attachments: bug.evidence.logs.map((x) => ({ id: x.id, text: x.extractedText ?? undefined, analysis: x.analysisResult ?? undefined })) }); this.writeArtifact(artifactDir, 'agent-result.json', AgentFixResultSchema.strict().parse(fixResult));
      if (fixResult.status !== 'fixed') { await this.transition(bug, 'FIX_FAILED', fixResult); this.queue.failJob(jobId, fixResult.blockedReason ?? 'Fixer failed', workerId); pipeline.status = 'FIX_FAILED'; pipeline.error = fixResult.blockedReason; return; }
      await this.transition(bug, 'VALIDATING'); const validationCommands = profile.validationCommands.length ? profile.validationCommands : profile.validation; const validation = await this.validator.runValidation(worktreePath, validationCommands); const checkedValidation = DeterministicValidationSchema.parse({ ...validation, results: validation.results }); this.writeArtifact(artifactDir, 'validation.json', checkedValidation);
      if (!checkedValidation.passed) { await this.transition(bug, 'VALIDATION_FAILED', checkedValidation); this.queue.failJob(jobId, 'Deterministic validation failed', workerId); pipeline.status = 'VALIDATION_FAILED'; pipeline.error = 'Deterministic validation failed'; return; }
      await this.transition(bug, 'REVIEWING'); const diff = await this.repoManager.diff(worktreePath); this.writeRawArtifact(artifactDir, 'diff.patch', diff); const review = await this.agentRunner.runReviewer({ worktreePath, task, profile, diff, filesChanged: fixResult.filesChanged, validation: checkedValidation }); this.writeArtifact(artifactDir, 'review.json', ReviewResultSchema.strict().parse(review));
      if (review.verdict !== 'approve' || !review.bugAddressed || review.regressionRisk === 'high') { await this.transition(bug, 'REVIEW_REJECTED', review); this.queue.failJob(jobId, `Review gate rejected: ${review.summary}`, workerId); pipeline.status = 'REVIEW_REJECTED'; pipeline.error = review.summary; return; }
      await this.transition(bug, 'FIX_READY', review); this.writeArtifact(artifactDir, 'git-result.json', GitResultSchema.parse({ success: false, branch, commitSha: null, mergeRequestUrl: null, pushed: false, error: this.options.dryRun ? 'DRY_RUN' : null }));
      if (this.options.dryRun) { pipeline.status = 'FIX_READY'; this.queue.completeJob(jobId, workerId); return; }
      pushing = true; await this.transition(bug, 'PUSHING'); const git = await this.repoManager.commitAndPush(worktreePath, branch, `fix(${bug.bugKey}): ${bug.title}`, false); this.writeArtifact(artifactDir, 'git-result.json', GitResultSchema.parse({ success: git.pushed, branch, commitSha: git.commitSha, mergeRequestUrl: null, pushed: git.pushed, error: null })); await this.transition(bug, 'READY_FOR_HUMAN_REVIEW'); pipeline.status = 'READY_FOR_HUMAN_REVIEW'; this.queue.completeJob(jobId, workerId);
    } catch (error) { const message = error instanceof Error ? error.message : String(error); logger.error({ bugKey: bug.bugKey, error: message }, 'Pipeline failed'); try { await this.transition(bug, pushing ? 'PUSH_FAILED' : 'FIX_FAILED', { error: message }); } catch { /* preserve original error */ } this.queue.failJob(jobId, message, workerId); pipeline.status = pushing ? 'PUSH_FAILED' : 'FAILED'; pipeline.error = message;
    } finally { if (worktreePath && environmentStarted && profile) { try { const stop = await this.envRunner.stopEnvironment(worktreePath, profile); this.writeArtifact(artifactDir, 'environment-stop.json', stop); } catch { /* cleanup must not hide pipeline result */ } } pipeline.finishedAt = now(); this.writeArtifact(artifactDir, 'pipeline.json', pipeline); }
  }
}
