import fs from 'node:fs';
import path from 'node:path';
import { createLogger, now } from '@llmbugfix/shared';
import { FakePiRunner, PiAgentOutputFormatError } from '@llmbugfix/pi-runner';
import { Validator, DeterministicValidationSchema } from '@llmbugfix/validator';
import { BugFixTaskSchema, AgentFixResultSchema, ReviewResultSchema, GitResultSchema } from '@llmbugfix/bug-domain';
const logger = createLogger('orchestrator');
class PipelineCancelledError extends Error {
    constructor() { super('Pipeline cancelled'); this.name = 'PipelineCancelledError'; }
}
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
    activeJobs = new Set();
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
        // Safe by default: only the explicit string DRY_RUN=false enables pushes.
        this.options = { dryRun: options.dryRun ?? (process.env.DRY_RUN !== 'false'), workerId: options.workerId ?? `worker-${process.pid}`, artifactRoot: options.artifactRoot ?? path.join(config.DATA_ROOT, 'agent-results') };
    }
    start(pollIntervalMs = 2_000) { this.isRunning = true; this.timer = setInterval(() => { void this.tick(); }, pollIntervalMs); }
    async stop() { this.isRunning = false; if (this.timer)
        clearInterval(this.timer); this.timer = undefined; await Promise.allSettled([...this.activeJobs]); }
    async track(operation) { this.activeJobs.add(operation); try {
        await operation;
    }
    finally {
        this.activeJobs.delete(operation);
    } }
    async tick() { if (!this.isRunning && this.timer)
        return false; this.queue.recoverStaleJobs(); const job = this.queue.claimNextJob(this.options.workerId); if (!job)
        return false; await this.track(this.processJob(job.id, job.bugId, this.options.workerId)); return true; }
    async runJob(job) { await this.track(this.processJob(job.id, job.bugId, job.workerId ?? this.options.workerId)); }
    writeArtifact(dir, filename, value) { fs.writeFileSync(path.join(dir, filename), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }
    writeRawArtifact(dir, filename, value) { fs.writeFileSync(path.join(dir, filename), value, { mode: 0o600 }); }
    async transition(bug, status, payload = {}) { this.repo.changeBugStatus(bug.bugKey, status, 'pipeline', payload); }
    attachmentsFor(bug) {
        // The repository table is authoritative for uploads; the report projection
        // may contain attachments from before that table was introduced.
        let persisted = [];
        try {
            persisted = this.repo.listAttachments(bug.id);
        }
        catch {
            try {
                persisted = this.repo.listAttachments(bug.bugKey);
            }
            catch { /* legacy repository without attachment rows */ }
        }
        const categories = ['logs', 'screenshots', 'videos', 'networkTraces', 'jsonFiles', 'otherFiles'];
        const merged = [...persisted, ...categories.flatMap((category) => bug.evidence[category])];
        const seen = new Set();
        return merged.filter((attachment) => !seen.has(attachment.id) && (seen.add(attachment.id), true));
    }
    taskFor(bug, profile, attachments = this.attachmentsFor(bug)) { return BugFixTaskSchema.parse({ bugKey: bug.bugKey, title: bug.title, executionTarget: profile.target, environmentProfileId: profile.id, actualBehavior: bug.actualBehavior, expectedBehavior: bug.expectedBehavior, reproductionSteps: bug.reproduction.steps, prerequisites: bug.reproduction.prerequisites, environment: bug.environment.additionalInfo, errorMessages: bug.evidence.errorMessages, stackTraces: bug.evidence.stackTraces, attachments, lastKnownGoodVersion: bug.regression.lastKnownGoodVersion, failingVersion: bug.regression.suspectedVersion, reporterObservations: bug.observations, reporterHypotheses: bug.reporterHypotheses, machineObservations: [], missingInformation: bug.intake.missingInformation, completenessScore: bug.intake.completenessScore }); }
    checkpoint(jobId, bugId) {
        const job = this.queue.getJob(jobId);
        const current = this.repo.getBug(bugId);
        if (!current)
            throw new PipelineCancelledError();
        const row = this.repo.database.prepare('SELECT status FROM bug_reports WHERE id = ? OR bug_key = ?').get(bugId, bugId);
        if (job.status === 'CANCELLED' || row?.status === 'CANCELLED')
            throw new PipelineCancelledError();
        return current;
    }
    async processJob(jobId, bugId, workerId) {
        const bug = this.repo.getBug(bugId);
        if (!bug) {
            this.queue.failJob(jobId, `Bug report not found: ${bugId}`, workerId);
            return;
        }
        const heartbeatTimer = setInterval(() => { try {
            const job = this.queue.getJob(jobId);
            if (job.status === 'RUNNING' && job.workerId === workerId)
                this.queue.heartbeat(jobId, workerId);
        }
        catch (error) {
            logger.warn({ bugKey: bug.bugKey, error: error instanceof Error ? error.message : String(error) }, 'Job heartbeat failed');
        } }, 15_000);
        heartbeatTimer.unref();
        const artifactDir = path.join(this.options.artifactRoot, bug.bugKey);
        fs.mkdirSync(artifactDir, { recursive: true });
        const pipeline = { bugKey: bug.bugKey, status: 'RUNNING', startedAt: now() };
        this.writeArtifact(artifactDir, 'pipeline.json', pipeline);
        const cancellation = new AbortController();
        const cancellationTimer = setInterval(() => { try {
            const current = this.queue.getJob(jobId);
            const row = this.repo.database.prepare('SELECT status FROM bug_reports WHERE id = ? OR bug_key = ?').get(bugId, bugId);
            if (current.status === 'CANCELLED' || row?.status === 'CANCELLED')
                cancellation.abort();
        }
        catch { /* final checkpoint handles missing jobs */ } }, 250);
        cancellationTimer.unref();
        let worktreePath;
        let profile;
        let environmentPrepared = false;
        let pushing = false;
        let branch;
        let keepWorktree = false;
        try {
            this.checkpoint(jobId, bugId);
            this.queue.heartbeat(jobId, workerId);
            await this.transition(bug, 'PREPARING_ENV');
            this.checkpoint(jobId, bugId);
            const resolved = this.envResolver.resolveProfile(bug.executionTarget, bug.environmentProfileId ?? undefined);
            profile = resolved.profile;
            const attachments = this.attachmentsFor(bug);
            const task = this.taskFor(bug, profile, attachments);
            this.writeArtifact(artifactDir, 'bug.json', bug);
            this.writeArtifact(artifactDir, 'environment.json', { profile, markdown: resolved.markdown.map((x) => x.path), skills: resolved.skills.map((x) => x.path) });
            this.writeArtifact(artifactDir, 'fix-task.json', task);
            branch = this.repoManager.createBranchName(bug.bugKey, bug.title);
            this.checkpoint(jobId, bugId);
            // A retry may leave a registered worktree (or just its directory). Ask
            // Git to unregister this exact BUG target before creating it again.
            await this.repoManager.cleanupWorktree(bug.bugKey, profile.repository, branch);
            worktreePath = await this.repoManager.setupWorktree(bug.bugKey, profile.repository, branch, profile.defaultBranch);
            this.checkpoint(jobId, bugId);
            const environment = await this.envRunner.prepareEnvironment(worktreePath, profile, cancellation.signal);
            environmentPrepared = true;
            this.writeArtifact(artifactDir, 'environment-run.json', environment);
            this.checkpoint(jobId, bugId);
            if (environment.status !== 'ENV_READY') {
                await this.transition(bug, 'ENVIRONMENT_FAILED', environment);
                this.queue.failJob(jobId, environment.error ?? 'Environment failed', workerId);
                pipeline.status = 'ENVIRONMENT_FAILED';
                pipeline.error = environment.error;
                return;
            }
            this.queue.heartbeat(jobId, workerId);
            await this.transition(bug, 'FIXING');
            this.checkpoint(jobId, bugId);
            const fixResult = await this.agentRunner.runFixer({ worktreePath, task, profile, safety: 'No network, push, merge, deploy, production access, or dependency downloads.', docs: resolved.markdown.map((x) => ({ path: x.path, content: x.content })), skills: resolved.skills.map((x) => ({ path: x.path, content: x.content })), attachments: attachments.map((x) => ({ id: x.id, text: x.extractedText ?? undefined, analysis: x.analysisResult ?? undefined })), signal: cancellation.signal });
            this.checkpoint(jobId, bugId);
            this.writeArtifact(artifactDir, 'agent-result.json', AgentFixResultSchema.strict().parse(fixResult));
            if (fixResult.status !== 'fixed') {
                await this.transition(bug, 'FIX_FAILED', fixResult);
                this.queue.failJob(jobId, fixResult.blockedReason ?? 'Fixer failed', workerId);
                pipeline.status = 'FIX_FAILED';
                pipeline.error = fixResult.blockedReason;
                return;
            }
            await this.transition(bug, 'VALIDATING');
            this.checkpoint(jobId, bugId);
            const validationCommands = profile.validationCommands.length ? profile.validationCommands : profile.validation;
            const validation = await this.validator.runValidation(worktreePath, validationCommands, { signal: cancellation.signal });
            const checkedValidation = DeterministicValidationSchema.parse({ ...validation, results: validation.results });
            this.writeArtifact(artifactDir, 'validation.json', checkedValidation);
            this.checkpoint(jobId, bugId);
            if (!checkedValidation.passed) {
                await this.transition(bug, 'VALIDATION_FAILED', checkedValidation);
                this.queue.failJob(jobId, 'Deterministic validation failed', workerId);
                pipeline.status = 'VALIDATION_FAILED';
                pipeline.error = 'Deterministic validation failed';
                return;
            }
            await this.transition(bug, 'REVIEWING');
            this.checkpoint(jobId, bugId);
            const diff = await this.repoManager.diff(worktreePath);
            this.writeRawArtifact(artifactDir, 'diff.patch', diff);
            this.checkpoint(jobId, bugId);
            const review = await this.agentRunner.runReviewer({ worktreePath, task, profile, diff, filesChanged: fixResult.filesChanged, validation: checkedValidation, signal: cancellation.signal });
            this.checkpoint(jobId, bugId);
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
            this.checkpoint(jobId, bugId);
            if (this.options.dryRun) {
                pipeline.status = 'FIX_READY';
                this.queue.completeJob(jobId, workerId);
                return;
            }
            pushing = true;
            await this.transition(bug, 'PUSHING');
            this.checkpoint(jobId, bugId);
            const git = await this.repoManager.commitAndPush(worktreePath, branch, `fix(${bug.bugKey}): ${bug.title}`, false);
            this.checkpoint(jobId, bugId);
            this.writeArtifact(artifactDir, 'git-result.json', GitResultSchema.parse({ success: git.pushed, branch, commitSha: git.commitSha, mergeRequestUrl: null, pushed: git.pushed, error: null }));
            await this.transition(bug, 'READY_FOR_HUMAN_REVIEW');
            pipeline.status = 'READY_FOR_HUMAN_REVIEW';
            this.queue.completeJob(jobId, workerId);
        }
        catch (error) {
            const cancelled = error instanceof PipelineCancelledError || cancellation.signal.aborted || (() => { try {
                const row = this.repo.database.prepare('SELECT status FROM bug_reports WHERE id = ? OR bug_key = ?').get(bugId, bugId);
                return this.queue.getJob(jobId).status === 'CANCELLED' || row?.status === 'CANCELLED';
            }
            catch {
                return true;
            } })();
            if (cancelled) {
                pipeline.status = 'CANCELLED';
                pipeline.error = null;
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            logger.error({ bugKey: bug.bugKey, error: message }, 'Pipeline failed');
            // Preserve evidence before the failure is reported: the agent may have
            // produced real work whose final report alone was malformed. A retry
            // unregisters and recreates this worktree, so keeping it is safe.
            if (worktreePath && profile) {
                if (error instanceof PiAgentOutputFormatError)
                    this.writeRawArtifact(artifactDir, 'agent-raw-output.txt', error.rawOutput);
                try {
                    const failureDiff = await this.repoManager.diff(worktreePath);
                    if (failureDiff.trim()) {
                        this.writeRawArtifact(artifactDir, 'diff.patch', failureDiff);
                        keepWorktree = true;
                    }
                }
                catch { /* best-effort evidence capture must not mask the failure */ }
            }
            try {
                await this.transition(bug, pushing ? 'PUSH_FAILED' : 'FIX_FAILED', { error: message });
            }
            catch { /* preserve original error */ }
            try {
                this.queue.failJob(jobId, message, workerId);
            }
            catch { /* a concurrent cancellation owns the terminal state */ }
            pipeline.status = pushing ? 'PUSH_FAILED' : 'FAILED';
            pipeline.error = message;
        }
        finally {
            clearInterval(heartbeatTimer);
            clearInterval(cancellationTimer);
            if (worktreePath && profile && environmentPrepared) {
                try {
                    const stop = await this.envRunner.stopEnvironment(worktreePath, profile);
                    this.writeArtifact(artifactDir, 'environment-stop.json', stop);
                }
                catch { /* cleanup must not hide pipeline result */ }
            }
            if (worktreePath && profile && !keepWorktree) {
                try {
                    await this.repoManager.cleanup(worktreePath, profile.repository, branch);
                }
                catch { /* cleanup must not hide pipeline result */ }
            }
            pipeline.finishedAt = now();
            this.writeArtifact(artifactDir, 'pipeline.json', pipeline);
        }
    }
}
//# sourceMappingURL=index.js.map