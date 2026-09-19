/** Local bootstrap. With LLM/profile configuration it also runs the repair worker. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AttachmentService } from '@llmbugfix/attachment-service';
import { openDatabase, SQLiteBugRepository, SQLiteWeeklyReportDataSource, SQLiteWeeklyReportDeliveryRepository } from '@llmbugfix/bug-repository';
import { EnvironmentResolver } from '@llmbugfix/environment-resolver';
import { EnvironmentRunner } from '@llmbugfix/environment-runner';
import { IntakeService, OpenAICompatibleDocumentReconciler, OpenAICompatibleIntakeModel } from '@llmbugfix/intake-agent';
import { JobQueue } from '@llmbugfix/job-queue';
import { createPiAgentRunnerFactory, type PiBackendDefinition } from '@llmbugfix/pi-runner';
import { loadBackendRegistry, resolveBackendApiKey } from '@llmbugfix/llm-dispatcher';
import { RepoManager, GitLabPushTarget } from '@llmbugfix/repo-manager';
import { createLogger, parseConfig, parseWeeklyEmailConfig } from '@llmbugfix/shared';
import { CommandRunner, Validator } from '@llmbugfix/validator';
import { Orchestrator } from '@llmbugfix/orchestrator';
import { resolveWebRoute } from '../../bug-web/src/index.js';
import { BugApiServer } from './index.js';
import { DefaultWeeklyReportService, NodemailerSMTPMailSender, WeeklyReportScheduler } from '@llmbugfix/weekly-email-report';

function loadDotEnv(filename = '.env'): void {
  if (!fs.existsSync(filename)) return;
  for (const sourceLine of fs.readFileSync(filename, 'utf8').split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function portFromEnv(value: string | undefined): number {
  if (value === undefined || value === '') return 8033;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  return port;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function loadIntakeInstructions(filename: string): string {
  const root = fs.realpathSync.native(process.cwd());
  const candidate = path.resolve(root, filename);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error('INTAKE_CONFIG_PATH must stay inside the application root');
  if (!fs.existsSync(candidate)) throw new Error(`Intake config file not found: ${filename}`);
  const real = fs.realpathSync.native(candidate);
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error('INTAKE_CONFIG_PATH resolves outside the application root');
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error('INTAKE_CONFIG_PATH must identify a regular file');
  if (stat.size > 128 * 1024) throw new Error('INTAKE_CONFIG_PATH exceeds 128 KiB');
  return fs.readFileSync(real, 'utf8');
}

loadDotEnv();
const config = parseConfig();
const weeklyEmailConfig = parseWeeklyEmailConfig();
const db = openDatabase(config.DATABASE_PATH);
const repo = new SQLiteBugRepository(db);
const leaseTimeoutMs = positiveInteger(process.env.JOB_LEASE_TIMEOUT_MS, 300_000, 'JOB_LEASE_TIMEOUT_MS');
const heartbeatIntervalMs = positiveInteger(process.env.JOB_HEARTBEAT_INTERVAL_MS, 15_000, 'JOB_HEARTBEAT_INTERVAL_MS');
if (heartbeatIntervalMs >= leaseTimeoutMs) throw new Error('JOB_HEARTBEAT_INTERVAL_MS must be less than JOB_LEASE_TIMEOUT_MS');
const maxConcurrentJobs = positiveInteger(process.env.DISPATCHER_MAX_CONCURRENT_JOBS, 1, 'DISPATCHER_MAX_CONCURRENT_JOBS');
const queue = new JobQueue(repo, path.join(config.DATA_ROOT, 'queue'), { autoAcquireLock: true, leaseTimeoutMs });
const attachments = new AttachmentService(path.join(config.DATA_ROOT, 'attachments'), { maxBytes: config.MAX_ATTACHMENT_BYTES });
// The registry is the one bootstrap source for all LLM roles.  With no
// registry or legacy endpoint configured it intentionally yields an empty
// pool, preserving the queue-only/UI-only startup mode.
const backendRegistry = loadBackendRegistry({ env: process.env });
const configuredBackends = backendRegistry.listBackends();
const intakeBackend = backendRegistry.getIntakeBackend();
const endpointUrl = intakeBackend?.endpointUrl;
const model = intakeBackend?.model;
// Pi's bash tool is not a sandbox. Require an explicit host-level sandbox
// profile before starting the real Pi repair worker.
const sandboxProfile = process.env.PI_SANDBOX_PROFILE?.trim();
const llmEnabled = configuredBackends.length > 0;
const intakeEnabled = Boolean(intakeBackend);
const workerBackends = configuredBackends.filter((backend) => backend.enabled && !backend.draining && (backend.roles.includes('fixer') || backend.roles.includes('reviewer')));
const workerEnabled = Boolean(workerBackends.length && sandboxProfile);
let environmentResolver: EnvironmentResolver | undefined;
let intake: IntakeService | undefined;
let orchestrator: Orchestrator | undefined;
let piRunnerFactory: ReturnType<typeof createPiAgentRunnerFactory> | undefined;
let environments: { listProfiles: () => unknown[]; resolveProfile: (target: string, requestedProfileId?: string) => unknown; provisionProfile: (proposal: { name?: string; repositoryUrl?: string; defaultBranch?: string; target: 'frontend' | 'backend'; setupCommands?: string[]; validationCommands?: string[] }) => Promise<{ id: string; target: 'frontend' | 'backend' }> } | undefined;

// Real intake is useful on its own: it can interview the tester and create a
// local checkout/profile while the actual Pi repair worker remains fail-closed
// until the host declares an external sandbox.
if (llmEnabled) {
  // A checked-in catalog remains supported when explicitly configured, but is
  // no longer required. Confirmed intake conversations are persisted here.
  const generatedProfilesPath = path.resolve(config.DATA_ROOT, 'generated-environments.yaml');
  const configuredCatalog = process.env.ENVIRONMENT_CONFIG_PATH?.trim() || path.resolve(config.DATA_ROOT, 'environment-catalog.yaml');
  environmentResolver = new EnvironmentResolver(configuredCatalog, process.cwd(), { env: process.env, allowMissingConfig: true, profileStorePath: generatedProfilesPath });
  const profiles = environmentResolver.listProfiles();
  const intakeLlmLogger = process.env.INTAKE_LLM_LOG === '1' ? createLogger('intake-llm') : undefined;
  if (intakeBackend) {
    const intakeRequirements = loadIntakeInstructions(process.env.INTAKE_CONFIG_PATH ?? 'config/bug-intake.md');
    const allowedProjects = profiles.map(({ id, name, target }) => ({ id, name, target }));
    const instructions = `${intakeRequirements}\n\nExisting project profiles (when applicable, use the exact id as environmentProfileId):\n${JSON.stringify(allowedProjects, null, 2)}\n\nFor every report, an explicit remote Git clone address is required in the current draft, including when an existing profile is selected. A profile id never replaces it. Ask the tester for the remote when absent and return it in environmentProfile.repositoryUrl so the server can clone or verify it locally after confirmation.`;
    const intakeTimeoutMs = positiveInteger(process.env.INTAKE_LLM_TIMEOUT_MS, 60_000, 'INTAKE_LLM_TIMEOUT_MS');
    const intakeApiKey = resolveBackendApiKey(intakeBackend, process.env);
    const llmOptions = { baseUrl: endpointUrl!, model: model!, ...(intakeApiKey ? { apiKey: intakeApiKey } : {}), intakeInstructions: instructions, timeoutMs: intakeTimeoutMs, ...(intakeLlmLogger ? { logger: intakeLlmLogger } : {}) };
    intake = new IntakeService(new OpenAICompatibleIntakeModel(llmOptions), new OpenAICompatibleDocumentReconciler(llmOptions));
  }

  const worktreesRoot = path.resolve(config.DATA_ROOT, 'worktrees');
  const repositoriesRoot = path.resolve(config.DATA_ROOT, 'repositories');
  const repositories = profiles.map((profile) => profile.repository);
  const allowedRemoteHosts = (process.env.GIT_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  // ai/* fix branches are mirrored into a public project under the own
  // GitLab account (docs/gitlab-private-repo-api.md). GITLAB_URL defaults to
  // the internal instance; set it to an empty string to push to origin instead.
  const gitlabUrl = process.env.GITLAB_URL !== undefined ? process.env.GITLAB_URL.trim() : 'http://172.29.100.126';
  const gitlabToken = process.env.GITLAB_TOKEN?.trim();
  const gitlabPassword = process.env.GITLAB_PASSWORD?.trim();
  const gitlabTarget = gitlabUrl ? new GitLabPushTarget({
    baseUrl: gitlabUrl,
    account: process.env.GITLAB_ACCOUNT?.trim() || 'codigger-llm',
    ...(gitlabToken ? { token: gitlabToken } : {}),
    ...(gitlabPassword ? { password: gitlabPassword } : {}),
  }) : undefined;
  // Keep GitLab secrets only in the target's private in-memory state. Networked
  // Git commands receive a short-lived per-operation credential environment.
  delete process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_PASSWORD;
  const repoManager = new RepoManager({ worktreesRoot, repositoryRoots: repositories, cloneRoot: repositoriesRoot, allowedRemoteHosts, ownPushTarget: gitlabTarget, gitCredentialProvider: gitlabTarget });
  for (const repository of repositories) repoManager.validateRepoUrl(repository);
  const validBranch = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u.test(value) && !value.includes('..') && !value.includes('//') && !value.endsWith('/');
  environments = {
    listProfiles: () => environmentResolver!.listProfiles(),
    resolveProfile: (target, profileId) => environmentResolver!.resolveProfile(target, profileId),
    provisionProfile: async (proposal) => {
      const repositoryUrl = proposal.repositoryUrl?.trim();
      if (!repositoryUrl) throw new Error('Git repository remote address is required');
      const defaultBranch = proposal.defaultBranch?.trim() || 'main';
      if (!validBranch(defaultBranch)) throw new Error(`Invalid default branch: ${defaultBranch}`);
      const id = `remote-${createHash('sha256').update(`${proposal.target}\0${repositoryUrl}`).digest('hex').slice(0, 16)}`;
      const checkout = await repoManager.cloneRemoteRepository(repositoryUrl, id);
      const leaf = repositoryUrl.replace(/\/+$/u, '').split(/[/:]/u).at(-1)?.replace(/\.git$/iu, '') || 'Remote Git project';
      const profile = environmentResolver!.upsertGeneratedProfile({
        id,
        name: proposal.name?.trim() || leaf,
        target: proposal.target,
        repository: checkout,
        repoUrl: repositoryUrl,
        defaultBranch,
        baseBranch: defaultBranch,
        markdown: [], skills: [], documentationPaths: [], skillPaths: [],
        setupCommands: proposal.setupCommands ?? [], validationCommands: proposal.validationCommands ?? [], setup: [], validation: [], instructions: [],
      });
      return { id: profile.id, target: profile.target };
    },
  };
  if (workerEnabled) {
    const commandRunner = new CommandRunner({ allowedCwdRoots: [worktreesRoot] });
    const environmentRunner = new EnvironmentRunner({ commandRunner, commandTimeoutMs: positiveInteger(process.env.ENVIRONMENT_TIMEOUT_MS, 600_000, 'ENVIRONMENT_TIMEOUT_MS') });
    const fixerTimeoutMs = positiveInteger(process.env.FIXER_TIMEOUT_MS, 2_700_000, 'FIXER_TIMEOUT_MS');
    const reviewerTimeoutMs = positiveInteger(process.env.REVIEWER_TIMEOUT_MS, 900_000, 'REVIEWER_TIMEOUT_MS');
    const piBackends: PiBackendDefinition[] = workerBackends.map((backend) => ({
      id: backend.id,
      endpointUrl: backend.endpointUrl,
      model: backend.model,
      ...(backend.apiKeyEnv ? { apiKeyEnv: backend.apiKeyEnv } : {}),
      fixerTimeoutMs: backend.fixerTimeoutMs ?? fixerTimeoutMs,
      reviewerTimeoutMs: backend.reviewerTimeoutMs ?? reviewerTimeoutMs,
    }));
    piRunnerFactory = createPiAgentRunnerFactory(piBackends, {
      env: process.env,
      requireSandbox: true,
      sandboxProfile,
      bashShellPath: process.env.PI_BASH_SHELL?.trim() || undefined,
      confineWorkspace: process.env.PI_CONFINE_WORKSPACE === '1',
      ...(intakeLlmLogger ? { logger: createLogger('pi-agent') } : {}),
    });
    const defaultWorkerBackend = piBackends.find((backend) => backend.id === intakeBackend?.id) ?? piBackends[0];
    if (!defaultWorkerBackend) throw new Error('No enabled fixer/reviewer backend is configured');
    const agentRunner = piRunnerFactory.get(defaultWorkerBackend.id);
    orchestrator = new Orchestrator(config, repo, queue, environmentResolver, repoManager, environmentRunner, agentRunner, new Validator(commandRunner), {
      dryRun: process.env.DRY_RUN !== 'false',
      dispatcher: backendRegistry,
      runnerFactory: piRunnerFactory,
      maxConcurrentJobs,
      leaseTimeoutMs,
      heartbeatIntervalMs,
    });
  }
}
const pageRenderer = (pathname: string) => resolveWebRoute(pathname);
const apiEnvironment = { ...process.env };
delete apiEnvironment.WEEKLY_EMAIL_SMTP_URL;
delete apiEnvironment.WEEKLY_EMAIL_USERNAME;
delete apiEnvironment.WEEKLY_EMAIL_PASSWORD;
delete apiEnvironment.WEEKLY_EMAIL_RECIPIENTS;
delete apiEnvironment.WEEKLY_EMAIL_ALLOW_INSECURE_TLS;
const dispatcherCapabilities = (): unknown => {
  const health = backendRegistry.health();
  const healthById = new Map(health.map((item) => [item.backendId, item]));
  return {
    dispatcher: { loaded: true, backendCount: configuredBackends.length, health },
    capabilities: configuredBackends.map((backend) => ({
      id: backend.id,
      roles: backend.roles,
      taskTypes: backend.taskTypes,
      targets: backend.targets,
      capabilities: backend.capabilities,
      qualityTiers: backend.qualityTiers,
      maxConcurrency: backend.maxConcurrency,
      enabled: backend.enabled,
      draining: backend.draining,
      status: healthById.get(backend.id)?.status ?? 'closed',
    })),
  };
};
const api = new BugApiServer({ ...apiEnvironment, ...config, DRY_RUN: process.env.DRY_RUN ?? true }, { repo, intake, queue, attachments, environments: environments ?? environmentResolver, pageRenderer, capabilities: dispatcherCapabilities });
const weeklyScheduler = weeklyEmailConfig.enabled ? new WeeklyReportScheduler(
  { now: () => new Date() },
  new SQLiteWeeklyReportDeliveryRepository(db),
  new DefaultWeeklyReportService(new SQLiteWeeklyReportDataSource(db)),
  new NodemailerSMTPMailSender(weeklyEmailConfig.value),
  { from: weeklyEmailConfig.value.username, to: weeklyEmailConfig.value.recipients, logger: createLogger('weekly-email') },
) : undefined;
const host = process.env.BUGFIX_LISTEN_HOST ?? '127.0.0.1';
const port = await api.listen(portFromEnv(process.env.PORT), host);
orchestrator?.start();
if (weeklyScheduler) void weeklyScheduler.start();
else console.log('每周邮件未启用');
if (weeklyEmailConfig.enabled && weeklyEmailConfig.value.allowInsecureTls) console.warn('WARNING: weekly email TLS certificate and hostname verification are disabled; use only on an isolated internal SMTP network.');
console.log(`LLM Bugfix local verification server is ready at http://${host}:${port}`);
console.log(workerEnabled ? `LLM backends are loaded; Intake${intakeEnabled ? '' : ' is disabled'}, and the Pi repair worker is enabled.` : intakeEnabled ? `Real Intake is enabled with model ${model}; submitted reports stay in the local queue until PI_SANDBOX_PROFILE enables the externally isolated Pi worker.` : llmEnabled ? 'LLM backends are loaded without an Intake backend; submitted reports stay in the local queue.' : 'LLM and repair worker are disabled; submitted reports stay in the local queue. Configure LLM_BACKENDS_CONFIG_PATH or the legacy LLM_ENDPOINT_URL and LLM_MODEL pair to enable Intake.');
if (llmEnabled && !sandboxProfile) console.warn('WARNING: real Pi repair worker disabled; set PI_SANDBOX_PROFILE to an externally enforced sandbox profile before enabling Pi bash.');

let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  console.log(`Received ${signal}; closing local server.`);
  await weeklyScheduler?.stop();
  await orchestrator?.stop();
  await api.close();
  queue.close();
  db.close();
};
process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
