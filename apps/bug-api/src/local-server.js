/** Local bootstrap. With LLM/profile configuration it also runs the repair worker. */
import fs from 'node:fs';
import path from 'node:path';
import { AttachmentService } from '@llmbugfix/attachment-service';
import { openDatabase, SQLiteBugRepository } from '@llmbugfix/bug-repository';
import { EnvironmentResolver } from '@llmbugfix/environment-resolver';
import { EnvironmentRunner } from '@llmbugfix/environment-runner';
import { IntakeService, OpenAICompatibleDocumentReconciler, OpenAICompatibleIntakeModel } from '@llmbugfix/intake-agent';
import { JobQueue } from '@llmbugfix/job-queue';
import { PiAgentRunner } from '@llmbugfix/pi-runner';
import { RepoManager } from '@llmbugfix/repo-manager';
import { parseConfig } from '@llmbugfix/shared';
import { CommandRunner, Validator } from '@llmbugfix/validator';
import { Orchestrator } from '@llmbugfix/orchestrator';
import { renderDashboardHtml, renderDetailHtml, renderIndexHtml } from '../../bug-web/src/index.js';
import { BugApiServer } from './index.js';
function loadDotEnv(filename = '.env') {
    if (!fs.existsSync(filename))
        return;
    for (const sourceLine of fs.readFileSync(filename, 'utf8').split(/\r?\n/u)) {
        const line = sourceLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
        if (!match || process.env[match[1]] !== undefined)
            continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
            value = value.slice(1, -1);
        process.env[match[1]] = value;
    }
}
function portFromEnv(value) {
    if (value === undefined || value === '')
        return 8033;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('PORT must be an integer between 1 and 65535');
    return port;
}
function positiveInteger(value, fallback, name) {
    if (!value)
        return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0)
        throw new Error(`${name} must be a positive integer`);
    return parsed;
}
function loadIntakeInstructions(filename) {
    const root = fs.realpathSync.native(process.cwd());
    const candidate = path.resolve(root, filename);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`))
        throw new Error('INTAKE_CONFIG_PATH must stay inside the application root');
    if (!fs.existsSync(candidate))
        throw new Error(`Intake config file not found: ${filename}`);
    const real = fs.realpathSync.native(candidate);
    if (real !== root && !real.startsWith(`${root}${path.sep}`))
        throw new Error('INTAKE_CONFIG_PATH resolves outside the application root');
    const stat = fs.statSync(real);
    if (!stat.isFile())
        throw new Error('INTAKE_CONFIG_PATH must identify a regular file');
    if (stat.size > 128 * 1024)
        throw new Error('INTAKE_CONFIG_PATH exceeds 128 KiB');
    return fs.readFileSync(real, 'utf8');
}
loadDotEnv();
const config = parseConfig();
const db = openDatabase(config.DATABASE_PATH);
const repo = new SQLiteBugRepository(db);
const queue = new JobQueue(repo, path.join(config.DATA_ROOT, 'queue'), { autoAcquireLock: true });
const attachments = new AttachmentService(path.join(config.DATA_ROOT, 'attachments'), { maxBytes: config.MAX_ATTACHMENT_BYTES });
const endpointUrl = process.env.LLM_ENDPOINT_URL?.trim();
const model = process.env.LLM_MODEL?.trim();
if (Boolean(endpointUrl) !== Boolean(model))
    throw new Error('LLM_ENDPOINT_URL and LLM_MODEL must be configured together');
// Pi's bash tool is not a sandbox. Require an explicit host-level sandbox
// profile before starting any real intake/fixer worker.
const sandboxProfile = process.env.PI_SANDBOX_PROFILE?.trim();
const workerEnabled = Boolean(endpointUrl && model && sandboxProfile);
let environmentResolver;
let intake;
let orchestrator;
if (workerEnabled) {
    environmentResolver = new EnvironmentResolver(process.env.ENVIRONMENT_CONFIG_PATH ?? 'config/environments.yaml', process.cwd(), { env: process.env });
    const profiles = environmentResolver.listProfiles();
    const intakeRequirements = loadIntakeInstructions(process.env.INTAKE_CONFIG_PATH ?? 'config/bug-intake.md');
    const allowedProjects = profiles.map(({ id, name, target }) => ({ id, name, target }));
    const instructions = `${intakeRequirements}\n\nAllowed project/module profiles (use the exact id as environmentProfileId):\n${JSON.stringify(allowedProjects, null, 2)}`;
    const llmOptions = { baseUrl: endpointUrl, model: model, ...(process.env.LLM_API_KEY?.trim() ? { apiKey: process.env.LLM_API_KEY.trim() } : {}), intakeInstructions: instructions };
    intake = new IntakeService(new OpenAICompatibleIntakeModel(llmOptions), new OpenAICompatibleDocumentReconciler(llmOptions));
    const worktreesRoot = path.resolve(config.DATA_ROOT, 'worktrees');
    const repositories = profiles.map((profile) => profile.repository);
    const repoManager = new RepoManager({ worktreesRoot, repositoryRoots: repositories });
    for (const repository of repositories)
        repoManager.validateRepoUrl(repository);
    const commandRunner = new CommandRunner({ allowedCwdRoots: [worktreesRoot] });
    const environmentRunner = new EnvironmentRunner({ commandRunner, commandTimeoutMs: positiveInteger(process.env.ENVIRONMENT_TIMEOUT_MS, 600_000, 'ENVIRONMENT_TIMEOUT_MS') });
    const agentRunner = new PiAgentRunner({
        endpointUrl: endpointUrl, model: model, apiKey: process.env.LLM_API_KEY?.trim() || undefined,
        fixerTimeoutMs: positiveInteger(process.env.FIXER_TIMEOUT_MS, 2_700_000, 'FIXER_TIMEOUT_MS'),
        reviewerTimeoutMs: positiveInteger(process.env.REVIEWER_TIMEOUT_MS, 900_000, 'REVIEWER_TIMEOUT_MS'),
        requireSandbox: true,
        sandboxProfile,
    });
    orchestrator = new Orchestrator(config, repo, queue, environmentResolver, repoManager, environmentRunner, agentRunner, new Validator(commandRunner), { dryRun: process.env.DRY_RUN !== 'false' });
}
const pageRenderer = (pathname) => {
    if (pathname === '/')
        return renderIndexHtml();
    if (pathname === '/dashboard')
        return renderDashboardHtml();
    const detail = pathname.match(/^\/bugs\/([^/]+)$/u);
    return detail ? renderDetailHtml(decodeURIComponent(detail[1])) : undefined;
};
const api = new BugApiServer({ ...process.env, ...config, DRY_RUN: process.env.DRY_RUN ?? true }, { repo, intake, queue, attachments, environments: environmentResolver, pageRenderer });
const host = process.env.BUGFIX_LISTEN_HOST ?? '127.0.0.1';
const port = await api.listen(portFromEnv(process.env.PORT), host);
orchestrator?.start();
console.log(`LLM Bugfix local verification server is ready at http://${host}:${port}`);
console.log(workerEnabled ? `Real Intake and Pi repair worker are enabled with model ${model}.` : endpointUrl && model ? 'LLM and repair worker are disabled; submitted reports stay in the local queue. Configure PI_SANDBOX_PROFILE to enable the externally isolated worker.' : 'LLM and repair worker are disabled; submitted reports stay in the local queue. Configure LLM_ENDPOINT_URL and LLM_MODEL to enable them.');
if (endpointUrl && model && !sandboxProfile)
    console.warn('WARNING: real repair worker disabled; set PI_SANDBOX_PROFILE to an externally enforced sandbox profile before enabling Pi bash.');
let closing = false;
const shutdown = async (signal) => {
    if (closing)
        return;
    closing = true;
    console.log(`Received ${signal}; closing local server.`);
    const workerStopped = orchestrator?.stop();
    await api.close();
    await workerStopped;
    queue.close();
    db.close();
};
process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
//# sourceMappingURL=local-server.js.map