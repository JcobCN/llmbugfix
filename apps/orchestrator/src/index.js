import fs from 'node:fs';
import path from 'node:path';
import { createLogger, now } from '@llmbugfix/shared';
import { FakePiRunner } from '@llmbugfix/pi-runner';
import { Validator, DeterministicValidationSchema } from '@llmbugfix/validator';
import { BugFixTaskSchema, AgentFixResultSchema, ReviewResultSchema, GitResultSchema } from '@llmbugfix/bug-domain';
const logger = createLogger('orchestrator');
export class Orchestrator {
    config;
    repo;
    queue;
    envResolver;
    repoManager;
    envRunner;
    agentRunner;
    validator;
    timer;
    isRunning = false;
    options;
    constructor(config, repo, queue, envResolver, repoManager, envRunner, agentRunner = new FakePiRunner(), validator = new Validator(), options = {}) {
        this.config = config;
        this.repo = repo;
        this.queue = queue;
        this.envResolver = envResolver;
        this.repoManager = repoManager;
        this.envRunner = envRunner;
        this.agentRunner = agentRunner;
        this.validator = validator;
        this.options = { dryRun: options.dryRun ?? Boolean(process.env.DRY_RUN === 'true'), workerId: options.workerId ?? `worker-${process.pid}`, artifactRoot: options.artifactRoot ?? path.join(config.DATA_ROOT, 'agent-results') };
    }
    start(pollIntervalMs = 2_000) { this.isRunning = true; this.timer = setInterval(() => { void this.tick(); }, pollIntervalMs); }
    stop() { this.isRunning = false; if (this.timer)
        clearInterval(this.timer); }
    async tick() { if (!this.isRunning && this.timer)
        return false; this.queue.recoverStaleJobs(); const job = this.queue.claimNextJob(this.options.workerId); if (!job)
        return false; await this.processJob(job.id, job.bugId, this.options.workerId); return true; }
    async runJob(job) { await this.processJob(job.id, job.bugId, job.workerId ?? this.options.workerId); }
    writeArtifact(dir, filename, value) { fs.writeFileSync(path.join(dir, filename), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
    writeRawArtifact(dir, filename, value) { fs.writeFileSync(path.join(dir, filename), value, { mode: 0o600 }); }
    async transition(bug, status, payload = {}) { this.repo.changeBugStatus(bug.bugKey, status, 'pipeline', payload); }
    taskFor(bug, profile) { return BugFixTaskSchema.parse({ bugKey: bug.bugKey, title: bug.title, executionTarget: bug.executionTarget, environmentProfileId: profile.id, actualBehavior: bug.actualBehavior, expectedBehavior: bug.expectedBehavior, reproductionSteps: bug.reproduction.steps, prerequisites: bug.reproduction.prerequisites, environment: bug.environment.additionalInfo, errorMessages: bug.evidence.errorMessages, stackTraces: bug.evidence.stackTraces, attachments: bug.evidence.logs, lastKnownGoodVersion: bug.regression.lastKnownGoodVersion, failingVersion: bug.regression.suspectedVersion, reporterObservations: bug.observations, reporterHypotheses: bug.reporterHypotheses, machineObservations: [], missingInformation: bug.intake.missingInformation, completenessScore: bug.intake.completenessScore }); }
    async processJob(jobId, bugId, workerId) {
        const bug = this.repo.getBug(bugId);
        if (!bug) {
            this.queue.failJob(jobId, `Bug report not found: ${bugId}`, workerId);
            return;
        }
        const artifactDir = path.join(this.options.artifactRoot, bug.bugKey);
        fs.mkdirSync(artifactDir, { recursive: true });
        const pipeline = { bugKey: bug.bugKey, status: 'RUNNING', startedAt: now() };
        this.writeArtifact(artifactDir, 'pipeline.json', pipeline);
        let worktreePath;
        let profile;
        let environmentStarted = false;
        let pushing = false;
        try {
            this.queue.heartbeat(jobId, workerId);
            await this.transition(bug, 'PREPARING_ENV');
            const resolved = this.envResolver.resolveProfile(bug.executionTarget, bug.environmentProfileId ?? undefined);
            profile = resolved.profile;
            this.writeArtifact(artifactDir, 'bug.json', bug);
            this.writeArtifact(artifactDir, 'environment.json', { profile, markdown: resolved.markdown.map((x) => x.path), skills: resolved.skills.map((x) => x.path) });
            this.writeArtifact(artifactDir, 'fix-task.json', this.taskFor(bug, profile));
            const branch = this.repoManager.createBranchName(bug.bugKey, bug.title);
            worktreePath = await this.repoManager.setupWorktree(bug.bugKey, profile.repository, branch, profile.defaultBranch);
            const environment = await this.envRunner.prepareEnvironment(worktreePath, profile);
            this.writeArtifact(artifactDir, 'environment-run.json', environment);
            if (environment.status !== 'ENV_READY') {
                await this.transition(bug, 'ENVIRONMENT_FAILED', environment);
                this.queue.failJob(jobId, environment.error ?? 'Environment failed', workerId);
                pipeline.status = 'ENVIRONMENT_FAILED';
                pipeline.error = environment.error;
                return;
            }
            environmentStarted = true;
            this.queue.heartbeat(jobId, workerId);
            await this.transition(bug, 'FIXING');
            const task = this.taskFor(bug, profile);
            const fixResult = await this.agentRunner.runFixer({ worktreePath, task, profile, safety: 'No network, push, merge, deploy, production access, or dependency downloads.', docs: resolved.markdown.map((x) => ({ path: x.path, content: x.content })), skills: resolved.skills.map((x) => ({ path: x.path, content: x.content })), attachments: bug.evidence.logs.map((x) => ({ id: x.id, text: x.extractedText ?? undefined, analysis: x.analysisResult ?? undefined })) });
            this.writeArtifact(artifactDir, 'agent-result.json', AgentFixResultSchema.strict().parse(fixResult));
            if (fixResult.status !== 'fixed') {
                await this.transition(bug, 'FIX_FAILED', fixResult);
                this.queue.failJob(jobId, fixResult.blockedReason ?? 'Fixer failed', workerId);
                pipeline.status = 'FIX_FAILED';
                pipeline.error = fixResult.blockedReason;
                return;
            }
            await this.transition(bug, 'VALIDATING');
            const validationCommands = profile.validationCommands.length ? profile.validationCommands : profile.validation;
            const validation = await this.validator.runValidation(worktreePath, validationCommands);
            const checkedValidation = DeterministicValidationSchema.parse({ ...validation, results: validation.results });
            this.writeArtifact(artifactDir, 'validation.json', checkedValidation);
            if (!checkedValidation.passed) {
                await this.transition(bug, 'VALIDATION_FAILED', checkedValidation);
                this.queue.failJob(jobId, 'Deterministic validation failed', workerId);
                pipeline.status = 'VALIDATION_FAILED';
                pipeline.error = 'Deterministic validation failed';
                return;
            }
            await this.transition(bug, 'REVIEWING');
            const diff = await this.repoManager.diff(worktreePath);
            this.writeRawArtifact(artifactDir, 'diff.patch', diff);
            const review = await this.agentRunner.runReviewer({ worktreePath, task, profile, diff, filesChanged: fixResult.filesChanged, validation: checkedValidation });
            this.writeArtifact(artifactDir, 'review.json', ReviewResultSchema.strict().parse(review));
            if (review.verdict !== 'approve' || !review.bugAddressed || review.regressionRisk === 'high') {
                await this.transition(bug, 'REVIEW_REJECTED', review);
                this.queue.failJob(jobId, `Review gate rejected: ${review.summary}`, workerId);
                pipeline.status = 'REVIEW_REJECTED';
                pipeline.error = review.summary;
                return;
            }
            await this.transition(bug, 'FIX_READY', review);
            this.writeArtifact(artifactDir, 'git-result.json', GitResultSchema.parse({ success: false, branch, commitSha: null, mergeRequestUrl: null, pushed: false, error: this.options.dryRun ? 'DRY_RUN' : null }));
            if (this.options.dryRun) {
                pipeline.status = 'FIX_READY';
                this.queue.completeJob(jobId, workerId);
                return;
            }
            pushing = true;
            await this.transition(bug, 'PUSHING');
            const git = await this.repoManager.commitAndPush(worktreePath, branch, `fix(${bug.bugKey}): ${bug.title}`, false);
            this.writeArtifact(artifactDir, 'git-result.json', GitResultSchema.parse({ success: git.pushed, branch, commitSha: git.commitSha, mergeRequestUrl: null, pushed: git.pushed, error: null }));
            await this.transition(bug, 'READY_FOR_HUMAN_REVIEW');
            pipeline.status = 'READY_FOR_HUMAN_REVIEW';
            this.queue.completeJob(jobId, workerId);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error({ bugKey: bug.bugKey, error: message }, 'Pipeline failed');
            try {
                await this.transition(bug, pushing ? 'PUSH_FAILED' : 'FIX_FAILED', { error: message });
            }
            catch { /* preserve original error */ }
            this.queue.failJob(jobId, message, workerId);
            pipeline.status = pushing ? 'PUSH_FAILED' : 'FAILED';
            pipeline.error = message;
        }
        finally {
            if (worktreePath && environmentStarted && profile) {
                try {
                    const stop = await this.envRunner.stopEnvironment(worktreePath, profile);
                    this.writeArtifact(artifactDir, 'environment-stop.json', stop);
                }
                catch { /* cleanup must not hide pipeline result */ }
            }
            pipeline.finishedAt = now();
            this.writeArtifact(artifactDir, 'pipeline.json', pipeline);
        }
    }
}
//# sourceMappingURL=index.js.map