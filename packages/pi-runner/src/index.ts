import os from 'node:os';
import path from 'node:path';
import { newId } from '@llmbugfix/shared';
import {
  AgentFixResultSchema,
  BugFixTaskSchema,
  ReviewResultSchema,
  type BugFixTask,
} from '@llmbugfix/bug-domain';
import {
  EnvironmentProfileSchema,
  type EnvironmentProfile,
} from '@llmbugfix/environment-resolver';
import {
  DeterministicValidationSchema,
  type DeterministicValidation,
} from '@llmbugfix/validator';
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createExtensionRuntime,
  createWriteToolDefinition,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { z } from 'zod';

const StrictFixResultSchema = AgentFixResultSchema.strict();
const StrictReviewResultSchema = ReviewResultSchema.strict();
export type AgentFixResultChecked = z.infer<typeof StrictFixResultSchema>;
export type ReviewResultChecked = z.infer<typeof StrictReviewResultSchema>;

/** Minimal structural logger so callers can pass a pino logger without a package dependency. */
export type PiRunnerLogger = { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };

/**
 * Thrown when an agent's final text cannot be parsed into the contract JSON
 * even after one correction attempt. The raw output is preserved so callers
 * can persist it as forensic evidence instead of losing the agent's work.
 */
export class PiAgentOutputFormatError extends Error {
  constructor(readonly role: 'fixer' | 'reviewer', readonly rawOutput: string, readonly validationError: string) {
    super(`Pi ${role} output failed contract validation after one correction attempt: ${validationError}`);
    this.name = 'PiAgentOutputFormatError';
  }
}

export interface FixerInput {
  worktreePath: string;
  task: BugFixTask;
  profile: EnvironmentProfile;
  safety: string;
  docs?: Array<{ path: string; content: string }>;
  skills?: Array<{ path: string; content: string }>;
  attachments?: Array<{ id: string; text?: string; analysis?: string }>;
  signal?: AbortSignal;
}

export interface ReviewerInput {
  worktreePath: string;
  task: BugFixTask;
  profile: EnvironmentProfile;
  diff: string;
  filesChanged: string[];
  validation: DeterministicValidation;
  signal?: AbortSignal;
}

export interface AgentRunner {
  runFixer(input: FixerInput): Promise<AgentFixResultChecked>;
  runReviewer(input: ReviewerInput): Promise<ReviewResultChecked>;
}

/** Legacy name retained for callers that use the adapter terminology. */
export type PiRunnerAdapter = AgentRunner;

export const FIXER_TOOLS = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'] as const;
export const REVIEWER_TOOLS = ['read', 'grep', 'find', 'ls'] as const;
const PROVIDER_ID = 'llmbugfix';
const DEFAULT_FIXER_TIMEOUT_MS = 2_700_000;
const DEFAULT_REVIEWER_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_TOKENS = 32_768;
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * The small surface of a Pi session used by this adapter. Keeping this
 * interface injectable makes tests deterministic without reimplementing Pi's
 * agent loop or tool-call handling.
 */
export type PiSession = Pick<AgentSession, 'prompt' | 'getLastAssistantText' | 'abort' | 'dispose'>;

export interface PiModelRuntime {
  registerProvider(providerId: string, config: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    api?: string;
    authHeader?: boolean;
    models?: Array<{
      id: string;
      name: string;
      api?: string;
      reasoning: boolean;
      input: ('text' | 'image')[];
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
      contextWindow: number;
      maxTokens: number;
    }>;
  }): void;
  getModel(providerId: string, modelId: string): unknown;
}

export interface PiSessionFactoryOptions {
  cwd: string;
  model: unknown;
  modelRuntime: PiModelRuntime;
  tools: readonly string[];
  resourceLoader: ResourceLoader;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  agentDir: string;
  /** Extra tool definitions that replace the built-in tools with the same name. */
  customTools?: ToolDefinition[];
}

export type PiSessionFactory = (options: PiSessionFactoryOptions) => Promise<{ session: PiSession }>;

export interface PiAgentRunnerOptions {
  /** OpenAI-compatible API base URL (normally ending in `/v1`). */
  endpoint?: string;
  endpointUrl?: string;
  /** Model id exposed by the configured endpoint. */
  model?: string;
  apiKey?: string;
  fixerTimeoutMs?: number;
  reviewerTimeoutMs?: number;
  safety?: string;
  /** Isolated directory used only for Pi's explicit runtime paths. */
  agentDir?: string;
  /** Primarily useful for deterministic tests. Production uses ModelRuntime.create. */
  modelRuntime?: PiModelRuntime;
  modelRuntimeFactory?: () => Promise<PiModelRuntime>;
  /** Thin seam around createAgentSession; the Pi agent loop remains Pi-owned. */
  sessionFactory?: PiSessionFactory;
  /** Require a host-level sandbox declaration before enabling fixer bash. */
  requireSandbox?: boolean;
  /** Name/path of an externally enforced sandbox profile or launcher. */
  sandboxProfile?: string;
  /**
   * Explicit bash executable used by the fixer bash tool, typically a sandbox
   * wrapper script. The wrapper receives `-c <command>` exactly like bash.
   */
  bashShellPath?: string;
  /**
   * Confine fixer file-mutating tools (edit/write) to the worktree directory.
   * Bash confinement is the wrapper's responsibility (see bashShellPath).
   */
  confineWorkspace?: boolean;
  /** Optional structural logger for prompt/validation diagnostics. */
  logger?: PiRunnerLogger;
}

export class PiAgentRunnerTimeoutError extends Error {
  constructor(role: 'fixer' | 'reviewer', timeoutMs: number) {
    super(`${role} Pi session timed out after ${timeoutMs}ms`);
    this.name = 'PiAgentRunnerTimeoutError';
  }
}

/**
 * Parse the only two output forms accepted from an agent: a complete JSON
 * document or one complete fenced JSON block. Prose, multiple blocks, and
 * mixed JSON/text are intentionally rejected so tool chatter cannot become a
 * result accidentally.
 */
export function parseAgentJson(text: string): unknown {
  const value = text.trim();
  if (!value) throw new Error('Pi agent returned empty output');

  try {
    return JSON.parse(value) as unknown;
  } catch {
    // Continue only for the explicitly supported single fenced form.
  }

  const fenced = value.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu);
  if (!fenced) throw new Error('Pi agent output must be exactly one JSON object or one fenced JSON block');
  try {
    return JSON.parse(fenced[1]) as unknown;
  } catch (error) {
    throw new Error('Pi agent fenced output is not valid JSON', { cause: error });
  }
}

function endpointBaseUrl(value: string): string {
  const endpoint = value.trim().replace(/\/+$/u, '').replace(/\/chat\/completions$/iu, '');
  if (!endpoint) throw new Error('LLM endpoint URL is required');
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch (error) {
    throw new Error('LLM endpoint URL is invalid', { cause: error });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('LLM endpoint URL must use http or https');
  return endpoint;
}

function positiveTimeout(value: number | undefined, fallback: number, name: string): number {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error(`${name} must be a positive number`);
  return timeout;
}

function isolatedResourceLoader(role: 'fixer' | 'reviewer'): ResourceLoader {
  return {
    // Do not discover ~/.pi, project .pi, extensions, skills, templates, or
    // context files. All relevant repository material is in the role prompt.
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => `You are the ${role} in an automated bug-fix pipeline. Use only the tools enabled for this session.`,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function fixerPrompt(input: FixerInput, safety: string): string {
  return [
    'Fix the reported bug in the current repository. You own the coding loop: inspect, reproduce when useful, edit files, and run appropriate validation.',
    `Safety policy: ${safety}`,
    'Do not push, merge, deploy, access production, or download dependencies.',
    'When finished, reply with exactly one JSON object (a single fenced ```json block is also accepted) and no surrounding prose.',
    'The JSON must contain: bugKey, status (fixed|blocked|not_reproducible|failed), confidence (0..1), summary, rootCause, reproduced, regressionTestAdded, filesChanged, riskNotes, blockedReason, missingInformation.',
    `Task and context:\n${asJson({ task: input.task, profile: input.profile, docs: input.docs ?? [], skills: input.skills ?? [], attachments: input.attachments ?? [] })}`,
  ].join('\n\n');
}

function reviewerPrompt(input: ReviewerInput): string {
  return [
    'Review the proposed bug fix in the current repository. You are read-only: inspect files and the supplied evidence, but do not modify files or run commands.',
    'When finished, reply with exactly one JSON object (a single fenced ```json block is also accepted) and no surrounding prose.',
    'The JSON must contain: verdict (approve|reject), bugAddressed, regressionRisk (low|medium|high), summary, findings.',
    `Review evidence:\n${asJson({ task: input.task, profile: input.profile, diff: input.diff, filesChanged: input.filesChanged, validation: input.validation })}`,
  ].join('\n\n');
}

export class PiAgentRunner implements AgentRunner {
  private readonly endpoint: string;
  private readonly modelName: string;
  private readonly fixerTimeoutMs: number;
  private readonly reviewerTimeoutMs: number;
  private readonly safety: string;
  private readonly agentDir: string;
  private readonly apiKey?: string;
  private readonly modelRuntime?: PiModelRuntime;
  private readonly modelRuntimeFactory?: () => Promise<PiModelRuntime>;
  private readonly sessionFactory: PiSessionFactory;
  private readonly requireSandbox: boolean;
  private readonly sandboxProfile?: string;
  private readonly bashShellPath?: string;
  private readonly confineWorkspace: boolean;
  private readonly logger?: PiRunnerLogger;
  private runtimePromise?: Promise<PiModelRuntime>;

  constructor(options: PiAgentRunnerOptions = {}) {
    const endpoint = options.endpointUrl ?? options.endpoint ?? process.env.LLM_ENDPOINT_URL;
    const model = options.model ?? process.env.LLM_MODEL;
    this.endpoint = endpoint ? endpointBaseUrl(endpoint) : '';
    this.modelName = model?.trim() ?? '';
    this.apiKey = options.apiKey ?? process.env.LLM_API_KEY;
    this.fixerTimeoutMs = positiveTimeout(options.fixerTimeoutMs ?? (process.env.FIXER_TIMEOUT_MS ? Number(process.env.FIXER_TIMEOUT_MS) : undefined), DEFAULT_FIXER_TIMEOUT_MS, 'FIXER_TIMEOUT_MS');
    this.reviewerTimeoutMs = positiveTimeout(options.reviewerTimeoutMs ?? (process.env.REVIEWER_TIMEOUT_MS ? Number(process.env.REVIEWER_TIMEOUT_MS) : undefined), DEFAULT_REVIEWER_TIMEOUT_MS, 'REVIEWER_TIMEOUT_MS');
    this.safety = options.safety ?? 'No network, push, merge, deploy, production access.';
    this.agentDir = options.agentDir ?? path.join(os.tmpdir(), 'llmbugfix-pi-agent');
    this.modelRuntime = options.modelRuntime;
    this.modelRuntimeFactory = options.modelRuntimeFactory;
    this.sessionFactory = options.sessionFactory ?? (async (sessionOptions) => createAgentSession({
      cwd: sessionOptions.cwd,
      agentDir: sessionOptions.agentDir,
      model: sessionOptions.model as CreateAgentSessionOptions['model'],
      modelRuntime: sessionOptions.modelRuntime as ModelRuntime,
      resourceLoader: sessionOptions.resourceLoader,
      tools: [...sessionOptions.tools],
      customTools: sessionOptions.customTools,
      sessionManager: sessionOptions.sessionManager,
      settingsManager: sessionOptions.settingsManager,
      thinkingLevel: 'off',
    }).then((result) => ({ session: result.session })));
    this.requireSandbox = options.requireSandbox ?? false;
    this.sandboxProfile = options.sandboxProfile ?? process.env.PI_SANDBOX_PROFILE;
    this.bashShellPath = options.bashShellPath?.trim() || undefined;
    this.confineWorkspace = options.confineWorkspace ?? false;
    this.logger = options.logger;
  }

  /**
   * Build fixer tool definitions that enforce workspace confinement:
   * - bash runs through an explicit sandbox wrapper when bashShellPath is set;
   * - edit/write reject any path that resolves outside the worktree.
   * Definitions returned here shadow Pi's built-in tools with the same name.
   */
  private fixerConfinedTools(cwd: string): ToolDefinition[] {
    // Pi's concrete tool definitions are generic over their schema; the custom
    // tools boundary is the unparameterized ToolDefinition, so the variance is
    // bridged with an explicit cast at this single point.
    const tools: ToolDefinition[] = [];
    if (this.bashShellPath) tools.push(createBashToolDefinition(cwd, { shellPath: this.bashShellPath }) as unknown as ToolDefinition);
    if (this.confineWorkspace) {
      const confined = (definition: ToolDefinition): ToolDefinition => ({
        ...definition,
        execute: async (toolCallId, params, signal, onUpdate, ctx) => {
          const requested = (params as { path?: unknown } | undefined)?.path;
          if (typeof requested !== 'string' || !requested.trim()) throw new Error('A file path is required');
          const resolved = path.resolve(cwd, requested);
          if (resolved !== cwd && !resolved.startsWith(`${cwd}${path.sep}`)) throw new Error(`Path escapes the worktree sandbox: ${requested}`);
          return definition.execute(toolCallId, params, signal, onUpdate, ctx);
        },
      });
      tools.push(confined(createEditToolDefinition(cwd) as unknown as ToolDefinition), confined(createWriteToolDefinition(cwd) as unknown as ToolDefinition));
    }
    return tools;
  }

  private async getRuntime(): Promise<PiModelRuntime> {
    if (!this.runtimePromise) {
      this.runtimePromise = (async () => {
        const runtime = this.modelRuntime ?? await (this.modelRuntimeFactory?.() ?? ModelRuntime.create({
          // Never read ambient models/auth configuration or refresh catalogs.
          modelsPath: null,
          authPath: path.join(this.agentDir, 'auth.json'),
          allowModelNetwork: false,
          refreshOnCreate: false,
        }));
        if (!this.endpoint) throw new Error('LLM endpoint URL is required (set LLM_ENDPOINT_URL)');
        if (!this.modelName) throw new Error('LLM model is required (set LLM_MODEL)');
        runtime.registerProvider(PROVIDER_ID, {
          name: 'LLM Bugfix endpoint',
          baseUrl: this.endpoint,
          apiKey: this.apiKey,
          api: 'openai-completions',
          // An API key is optional for local/self-hosted endpoints. Pi's
          // OpenAI adapter requires authHeader=false when no key is present.
          authHeader: Boolean(this.apiKey),
          models: [{
            id: this.modelName,
            name: this.modelName,
            api: 'openai-completions',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: DEFAULT_CONTEXT_WINDOW,
            maxTokens: DEFAULT_MAX_TOKENS,
          }],
        });
        if (!runtime.getModel(PROVIDER_ID, this.modelName)) throw new Error(`Pi model is unavailable: ${PROVIDER_ID}/${this.modelName}`);
        return runtime;
      })();
    }
    return this.runtimePromise;
  }

  private async runRole<T>(role: 'fixer' | 'reviewer', cwd: string, prompt: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, signal?: AbortSignal): Promise<T> {
    if (role === 'fixer' && this.requireSandbox && !this.sandboxProfile) throw new Error('Pi fixer is disabled: PI_SANDBOX_PROFILE must name an externally enforced sandbox');
    if (signal?.aborted) throw new Error('Pi session cancelled');
    const runtime = await this.getRuntime();
    const model = runtime.getModel(PROVIDER_ID, this.modelName);
    if (!model) throw new Error(`Pi model is unavailable: ${PROVIDER_ID}/${this.modelName}`);
    const tools = role === 'fixer' ? FIXER_TOOLS : REVIEWER_TOOLS;
    const customTools = role === 'fixer' ? this.fixerConfinedTools(cwd) : [];
    const sessionResult = await this.sessionFactory({
      cwd,
      model,
      modelRuntime: runtime,
      tools,
      ...(customTools.length ? { customTools } : {}),
      resourceLoader: isolatedResourceLoader(role),
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 2 },
      }),
      agentDir: this.agentDir,
    });
    const session = sessionResult.session;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutMs = role === 'fixer' ? this.fixerTimeoutMs : this.reviewerTimeoutMs;
    try {
      const operation = (async () => {
        this.logger?.info({ role, cwd, prompt }, `pi ${role} session prompt`);
        await session.prompt(prompt, { expandPromptTemplates: false, source: 'rpc' });
        // One correction attempt mirrors the intake model: a malformed final
        // answer is fed back to the same session so the agent can re-emit the
        // contract JSON without redoing its investigation.
        let lastOutput = '';
        let lastValidationError = '';
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const output = await session.getLastAssistantText();
          if (output === undefined || output === null) throw new Error(`Pi ${role} session returned no assistant text`);
          lastOutput = output;
          try {
            return schema.parse(parseAgentJson(output));
          } catch (error) {
            lastValidationError = error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n') : error instanceof Error ? error.message : String(error);
            this.logger?.error({ role, attempt: attempt + 1, validationError: lastValidationError, content: output }, `pi ${role} output failed validation`);
            if (attempt === 0) {
              await session.prompt([
                `Your previous response failed output validation:\n${lastValidationError}`,
                'Reply again with exactly one JSON object (a single fenced ```json block is also accepted) matching the required schema and no surrounding prose.',
                'Every required field must be present with the correct type. Array fields must always be JSON arrays: wrap prose values like ["note"] instead of "note", and use [] when empty.',
                'Do not invent facts to satisfy validation.',
              ].join('\n'), { expandPromptTemplates: false, source: 'rpc' });
            }
          }
        }
        throw new PiAgentOutputFormatError(role, lastOutput, lastValidationError);
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          void Promise.resolve(session.abort()).catch(() => undefined);
          reject(new PiAgentRunnerTimeoutError(role, timeoutMs));
        }, timeoutMs);
      });
      const cancelled = signal ? new Promise<never>((_, reject) => signal.addEventListener('abort', () => { void Promise.resolve(session.abort()).catch(() => undefined); reject(new Error(`Pi ${role} session cancelled`)); }, { once: true })) : undefined;
      return await Promise.race(cancelled ? [operation, timeout, cancelled] : [operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      // `timedOut` is kept explicit to make the cancellation intent visible;
      // Pi's abort is best-effort and dispose is always required.
      if (timedOut) await Promise.resolve().catch(() => undefined);
      session.dispose();
    }
  }

  async runFixer(input: FixerInput): Promise<AgentFixResultChecked> {
    const task = BugFixTaskSchema.parse(input.task);
    const profile = EnvironmentProfileSchema.parse(input.profile);
    const result = await this.runRole('fixer', input.worktreePath, fixerPrompt({ ...input, task, profile }, input.safety || this.safety), StrictFixResultSchema, input.signal);
    if (result.bugKey !== task.bugKey) throw new Error(`Pi fixer returned bugKey ${result.bugKey}, expected ${task.bugKey}`);
    return result;
  }

  async runReviewer(input: ReviewerInput): Promise<ReviewResultChecked> {
    const task = BugFixTaskSchema.parse(input.task);
    const profile = EnvironmentProfileSchema.parse(input.profile);
    const validation = DeterministicValidationSchema.parse(input.validation);
    return this.runRole('reviewer', input.worktreePath, reviewerPrompt({ ...input, task, profile, validation }), StrictReviewResultSchema, input.signal);
  }
}

export class FakePiRunner implements AgentRunner {
  readonly fixerSessions: string[] = [];
  readonly reviewerSessions: string[] = [];
  constructor(private readonly fixResult?: AgentFixResultChecked, private readonly reviewResult?: ReviewResultChecked) {}
  async runFixer(input: FixerInput): Promise<AgentFixResultChecked> {
    const sessionId = newId();
    this.fixerSessions.push(sessionId);
    return StrictFixResultSchema.parse(this.fixResult ?? { bugKey: input.task.bugKey, status: 'fixed', confidence: 1, summary: 'Fake fixer result', rootCause: null, reproduced: true, regressionTestAdded: false, filesChanged: [], riskNotes: [], blockedReason: null, missingInformation: [] });
  }
  async runReviewer(input: ReviewerInput): Promise<ReviewResultChecked> {
    const sessionId = newId();
    this.reviewerSessions.push(sessionId);
    return StrictReviewResultSchema.parse(this.reviewResult ?? { verdict: input.validation.passed ? 'approve' : 'reject', bugAddressed: input.validation.passed, regressionRisk: 'low', summary: 'Fake review result', findings: [] });
  }
}
