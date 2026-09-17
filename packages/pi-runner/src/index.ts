import os from 'node:os';
import path from 'node:path';
import { newId } from '@llmbugfix/shared';
import {
  AgentFixResultSchema,
  AgentTaskResultSchema,
  BugReviewResultSchema,
  BugFixTaskSchema,
  CodingTaskSchema,
  DevelopmentReviewResultSchema,
  ReviewResultSchema,
  type BugFixTask,
  type CodingTask,
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
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { z } from 'zod';

const StrictFixResultSchema = AgentFixResultSchema.strict();
const StrictTaskResultSchema = AgentTaskResultSchema;
const StrictReviewResultSchema = ReviewResultSchema.strict();
const StrictBugReviewResultSchema = BugReviewResultSchema.strict();
const StrictDevelopmentReviewResultSchema = DevelopmentReviewResultSchema.strict();
export type AgentFixResultChecked = z.infer<typeof StrictFixResultSchema>;
export type AgentTaskResultChecked = z.infer<typeof StrictTaskResultSchema>;
export type ReviewResultChecked = z.infer<typeof StrictReviewResultSchema>;

/** A bounded, structured execution event. It intentionally contains no model
 * prompt, response, or tool result body. */
export type PiProgressEvent = {
  role: 'fixer' | 'reviewer';
  eventType: string;
  tool?: string | null;
  isError?: boolean;
  turnIndex?: number | null;
  toolCallCount?: number | null;
  summary: string;
};
export type PiProgressSink = (event: PiProgressEvent) => void | Promise<void>;

/** Minimal structural logger so callers can pass a pino logger without a package dependency. */
export type PiRunnerLogger = { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };

/**
 * Thrown only for the compatibility text fallback when no structured
 * submit_fix_result call was accepted. The raw output is preserved so callers
 * can persist it as forensic evidence instead of losing the agent's work.
 */
export class PiAgentOutputFormatError extends Error {
  constructor(readonly role: 'fixer' | 'reviewer', readonly rawOutput: string, readonly validationError: string) {
    super(`Pi ${role} output failed contract validation after one correction attempt: ${validationError}`);
    this.name = 'PiAgentOutputFormatError';
  }
}

/** Raised when the Pi loop exceeds a bounded turn/tool budget. */
export class PiAgentLoopBudgetError extends Error {
  constructor(readonly role: 'fixer' | 'reviewer', readonly limit: string, readonly value: number) {
    super(`Pi ${role} session exceeded ${limit} budget (${value})`);
    this.name = 'PiAgentLoopBudgetError';
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
  progress?: PiProgressSink;
  /** Selected backend is normally carried by the runner factory. */
  backendId?: string;
}

export interface ReviewerInput {
  worktreePath: string;
  task: BugFixTask | CodingTask;
  profile: EnvironmentProfile;
  diff: string;
  filesChanged: string[];
  validation: DeterministicValidation;
  signal?: AbortSignal;
  progress?: PiProgressSink;
  /** Selected backend is normally carried by the runner factory. */
  backendId?: string;
}

export interface AgentRunner {
  runFixer(input: FixerInput): Promise<AgentFixResultChecked>;
  runCoder?(input: Omit<FixerInput, 'task'> & { task: CodingTask }): Promise<AgentTaskResultChecked>;
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
const DEFAULT_MAX_TURNS = 80;
const DEFAULT_MAX_TOOL_CALLS = 240;
const DEFAULT_MAX_REPEATED_TOOL_CALLS = 4;
const DEFAULT_CLOSEOUT_GRACE_MS = 15_000;

/**
 * The small surface of a Pi session used by this adapter. Keeping this
 * interface injectable makes tests deterministic without reimplementing Pi's
 * agent loop or tool-call handling.
 */
export type PiSession = Pick<AgentSession, 'prompt' | 'getLastAssistantText' | 'abort' | 'dispose'> & {
  /** Optional in the test seam; real AgentSession always supplies it. */
  subscribe?: (listener: (event: AgentSessionEvent) => void) => () => void;
};

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
  /** The backend identity is available to instrumentation, never to prompts. */
  backendId?: string;
  providerId?: string;
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
  /** Stable identity used to isolate this runner's Pi provider registration. */
  backendId?: string;
  /** Explicit Pi provider id; defaults to a backend-scoped id. */
  providerId?: string;
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
  fixerMaxTurns?: number;
  reviewerMaxTurns?: number;
  fixerMaxToolCalls?: number;
  reviewerMaxToolCalls?: number;
  fixerMaxRepeatedToolCalls?: number;
  reviewerMaxRepeatedToolCalls?: number;
  fixerCloseoutGraceMs?: number;
  reviewerCloseoutGraceMs?: number;
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

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? undefined : Number(raw);
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0) throw new Error(`${name} must be a positive integer`);
  return result;
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

/**
 * Compact, bounded parameter summary for tool-call audit logs. Only the keys
 * that identify what the agent touched are kept, so the log stays readable
 * and never carries whole file bodies.
 */
function summarizeToolParams(tool: string, params: unknown): Record<string, string | number> {
  const value = (params ?? {}) as Record<string, unknown>;
  const clip = (input: string, max = 300): string => (input.length > max ? `${input.slice(0, max)}…` : input);
  if (tool === 'bash') {
    const command = typeof value.command === 'string' ? value.command : '';
    return { command: redactedToolValue(command, 500) };
  }
  if (typeof value.path === 'string') {
    const summary: Record<string, string | number> = { path: value.path };
    if (tool === 'read') { if (typeof value.offset === 'number') summary.offset = value.offset; if (typeof value.limit === 'number') summary.limit = value.limit; }
    if (tool === 'edit' && Array.isArray(value.edits)) summary.edits = value.edits.length;
    if (tool === 'write' && typeof value.content === 'string') summary.bytes = value.content.length;
    return summary;
  }
  if (tool === 'grep' && typeof value.pattern === 'string') return { pattern: redactedToolValue(value.pattern), ...(typeof value.path === 'string' ? { path: value.path } : {}) };
  if (tool === 'find') { if (typeof value.pattern === 'string') return { pattern: clip(value.pattern) }; }
  return { params: redactedToolValue(JSON.stringify(value)) };
}

/**
 * Stricter summary for events persisted to the dashboard. Shell commands and
 * search patterns can contain arbitrary credentials that regex redaction
 * cannot reliably identify, so only bounded file-operation metadata crosses
 * this persistence boundary. The richer audit summary remains terminal-only.
 */
function summarizePersistedToolParams(tool: string, params: unknown): Record<string, string | number> {
  const value = (params ?? {}) as Record<string, unknown>;
  if (!['read', 'edit', 'write'].includes(tool) || typeof value.path !== 'string') return {};
  const summary: Record<string, string | number> = { path: redactedToolValue(value.path, 300) };
  if (tool === 'read') {
    if (typeof value.offset === 'number') summary.offset = value.offset;
    if (typeof value.limit === 'number') summary.limit = value.limit;
  }
  if (tool === 'edit' && Array.isArray(value.edits)) summary.edits = value.edits.length;
  if (tool === 'write' && typeof value.content === 'string') summary.bytes = value.content.length;
  return summary;
}

const redactedToolValue = (value: string, max = 500): string => {
  // Tool audit logs are deliberately summaries, not a transcript. Redact the
  // common credential-shaped command arguments before applying the size cap.
  const safe = value.replace(/((?:api[_-]?key|token|secret|password|passwd|authorization|cookie)\s*[=:]\s*)([^\s,;]+)/giu, '$1[REDACTED]');
  return safe.length > max ? `${safe.slice(0, max)}…` : safe;
};

/**
 * The canonical result remains strict (arrays are arrays). This tiny adapter
 * is the only compatibility exception for old/fragile model wire formats:
 * empty strings become [], and non-empty strings become one-item arrays.
 * It intentionally does not parse prose or touch unknown/semantic fields.
 */
export function repairAgentFixResultInput(value: unknown, onRepair?: (fields: string[]) => void): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = { ...(value as Record<string, unknown>) };
  const repaired: string[] = [];
  for (const field of ['riskNotes', 'missingInformation'] as const) {
    if (typeof result[field] === 'string') {
      result[field] = result[field] === '' ? [] : [result[field]];
      repaired.push(field);
    }
  }
  if (repaired.length) onRepair?.(repaired);
  return result;
}

export type SubmitFixResultToolOptions = {
  expectedBugKey: string;
  logger?: PiRunnerLogger;
  onSubmit: (result: AgentFixResultChecked) => void;
  result?: AgentFixResultChecked;
};

/**
 * A TypeBox-compatible JSON schema is kept inline to avoid adding another
 * runtime dependency to this adapter. `prepareArguments` runs before Pi's
 * schema validator, allowing only the documented two-field wire repair.
 */
export function createSubmitFixResultTool(options: SubmitFixResultToolOptions): ToolDefinition {
  const stringArray = { type: 'array', items: { type: 'string' } };
  const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  const parameters = {
    type: 'object', additionalProperties: false,
    properties: {
      bugKey: { type: 'string', pattern: '^BUG-[0-9]{6,}$' },
      status: { type: 'string', enum: ['fixed', 'blocked', 'not_reproducible', 'failed'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 }, summary: { type: 'string' }, rootCause: nullableString,
      reproduced: { type: 'boolean' }, regressionTestAdded: { type: 'boolean' }, filesChanged: stringArray,
      riskNotes: stringArray, blockedReason: nullableString, missingInformation: stringArray,
    },
    required: ['bugKey', 'status', 'confidence', 'summary', 'rootCause', 'reproduced', 'regressionTestAdded', 'filesChanged', 'riskNotes', 'blockedReason', 'missingInformation'],
  } as unknown as ToolDefinition['parameters'];

  return defineTool({
    name: 'submit_fix_result', label: 'Submit fix result',
    description: 'Submit the completed fixer result to the host. Call exactly once after making and checking the fix.',
    promptSnippet: 'submit_fix_result — submit the structured fixer result',
    promptGuidelines: ['This is the authoritative completion channel. Call it exactly once when your work is complete.', 'Do not put the result in prose; pass every required field with its declared type.'],
    parameters,
    prepareArguments: (args: unknown) => repairAgentFixResultInput(args, (fields) => options.logger?.info({ role: 'fixer', fields }, 'contract_repaired')) as never,
    execute: async (_toolCallId, params) => {
      const repaired = repairAgentFixResultInput(params, (fields) => options.logger?.info({ role: 'fixer', fields }, 'contract_repaired'));
      let result: AgentFixResultChecked;
      try { result = StrictFixResultSchema.parse(repaired); }
      catch (error) {
        const detail = error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') : String(error);
        throw new Error(`submit_fix_result rejected: ${detail}`);
      }
      if (result.bugKey !== options.expectedBugKey) throw new Error(`submit_fix_result bugKey must equal ${options.expectedBugKey}`);
      if (options.result) throw new Error('submit_fix_result may only be called once');
      options.onSubmit(result);
      options.result = result;
      // `terminate` tells Pi to stop its loop after this tool batch. The
      // model may still emit a trailing assistant message in some providers;
      // the host continues to treat this captured result as authoritative.
      return { content: [{ type: 'text', text: 'Fix result accepted by host.' }], details: { accepted: true }, terminate: true };
    },
  });
}

export type SubmitReviewResultToolOptions = {
  taskType: 'bugfix' | 'development';
  logger?: PiRunnerLogger;
  onSubmit: (result: ReviewResultChecked) => void;
  result?: ReviewResultChecked;
};

/**
 * Give reviewers the same typed completion channel as fixers. The tool
 * schema is task-specific so a bugfix cannot omit bugAddressed and a
 * development task cannot omit its acceptance-criteria evidence.
 */
export function createSubmitReviewResultTool(options: SubmitReviewResultToolOptions): ToolDefinition {
  const stringArray = { type: 'array', items: { type: 'string' } };
  const acceptanceCriteria = {
    type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: { criterion: { type: 'string' }, met: { type: 'boolean' }, evidence: { type: 'string' } },
      required: ['criterion', 'met', 'evidence'],
    },
  };
  const properties: Record<string, unknown> = {
    verdict: { type: 'string', enum: ['approve', 'reject'] },
    regressionRisk: { type: 'string', enum: ['low', 'medium', 'high'] },
    summary: { type: 'string' }, findings: stringArray,
  };
  const required = options.taskType === 'development'
    ? ['verdict', 'taskAddressed', 'acceptanceCriteriaMet', 'regressionRisk', 'summary', 'findings']
    : ['verdict', 'bugAddressed', 'regressionRisk', 'summary', 'findings'];
  if (options.taskType === 'development') {
    properties.taskAddressed = { type: 'boolean' };
    properties.acceptanceCriteriaMet = acceptanceCriteria;
  } else {
    properties.bugAddressed = { type: 'boolean' };
  }
  const parameters = { type: 'object', additionalProperties: false, properties, required } as unknown as ToolDefinition['parameters'];
  const schema = options.taskType === 'development' ? StrictDevelopmentReviewResultSchema : StrictBugReviewResultSchema;
  return defineTool({
    name: 'submit_review_result', label: 'Submit review result',
    description: 'Submit the completed read-only review to the host. Call exactly once after inspecting the supplied evidence.',
    promptSnippet: 'submit_review_result — submit the structured reviewer result',
    promptGuidelines: ['This is the authoritative completion channel. Call it exactly once when the review is complete.', 'Pass every field with its declared type: booleans must be JSON booleans and findings must be an array of strings.'],
    parameters,
    execute: async (_toolCallId, params) => {
      let result: ReviewResultChecked;
      try { result = schema.parse(params) as ReviewResultChecked; }
      catch (error) {
        const detail = error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') : String(error);
        throw new Error(`submit_review_result rejected: ${detail}`);
      }
      if (options.result) throw new Error('submit_review_result may only be called once');
      options.onSubmit(result); options.result = result;
      options.logger?.info({ role: 'reviewer' }, 'review contract accepted');
      return { content: [{ type: 'text', text: 'Review result accepted by host.' }], details: { accepted: true }, terminate: true };
    },
  });
}

type CompletionToolOptions = SubmitFixResultToolOptions | SubmitReviewResultToolOptions;

function fixerPrompt(input: FixerInput, safety: string): string {
  return [
    'Fix the reported bug in the current repository. You own the coding loop: inspect, reproduce when useful, edit files, and run appropriate validation.',
    `Safety policy: ${safety}`,
    'Do not push, merge, deploy, access production, or download dependencies.',
    'When finished, call the submit_fix_result tool exactly once. Its accepted parameters are the only authoritative completion; ordinary assistant prose after a successful tool call is ignored.',
    'The configured endpoint must support tool calls/function calling. If it supports tools but this run produces no accepted tool call, the compatibility fallback is exactly one JSON object (a single fenced ```json block is also accepted) and no surrounding prose.',
    'The result fields are: bugKey, status (fixed|blocked|not_reproducible|failed), confidence (0..1), summary, rootCause, reproduced, regressionTestAdded, filesChanged, riskNotes, blockedReason, missingInformation. riskNotes and missingInformation are arrays of strings.',
    `Task and context:\n${asJson({ task: input.task, profile: input.profile, docs: input.docs ?? [], skills: input.skills ?? [], attachments: input.attachments ?? [] })}`,
  ].join('\n\n');
}

function coderPrompt(input: Omit<FixerInput, 'task'> & { task: CodingTask }, safety: string): string {
  return [
    'Implement the requested development task in the current repository. Inspect the existing architecture and conventions, then make the smallest complete change satisfying every acceptance criterion.',
    `Safety policy: ${safety}`,
    'Do not push, merge, deploy, access production, download dependencies, or expand into declared non-goals.',
    'If an ambiguity would materially change product behavior, return blocked with missingInformation instead of guessing.',
    'When complete, reply with exactly one JSON object and no prose. Required fields: bugKey, taskType (development), status (completed|blocked|failed), confidence, summary, filesChanged, validationNotes, riskNotes, blockedReason, missingInformation, developmentDetails { requirementsAddressed, acceptanceCriteriaAddressed, designNotes }.',
    'Task and context:\n' + asJson({ task: input.task, profile: input.profile, docs: input.docs ?? [], skills: input.skills ?? [], attachments: input.attachments ?? [] }),
  ].join('\n\n');
}

function reviewerPrompt(input: ReviewerInput): string {
  const development = 'taskType' in input.task && input.task.taskType === 'development';
  const contract = development
    ? [
      'For a development task, required fields and types are: verdict ("approve"|"reject"), taskAddressed (boolean), acceptanceCriteriaMet (array of objects with criterion (string), met (boolean), evidence (string)), regressionRisk ("low"|"medium"|"high"), summary (string), and findings (array of strings).',
      'Valid shape example:',
      asJson({ verdict: 'approve', taskAddressed: true, acceptanceCriteriaMet: [{ criterion: 'The requested behavior works', met: true, evidence: 'The diff and supplied validation evidence cover this criterion.' }], regressionRisk: 'low', summary: 'The change satisfies the requested behavior.', findings: ['The change is limited to the requested scope.'] }),
    ].join('\n')
    : [
      'For a bugfix, required fields and types are: verdict ("approve"|"reject"), bugAddressed (boolean), regressionRisk ("low"|"medium"|"high"), summary (string), and findings (array of strings).',
      'Valid shape example:',
      asJson({ verdict: 'approve', bugAddressed: true, regressionRisk: 'low', summary: 'The fix addresses the reported behavior.', findings: ['The changed calculation matches the expected result.'] }),
    ].join('\n');
  return [
    development ? 'Review the proposed development change against every requirement, acceptance criterion, non-goal, repository convention, and regression risk. You are read-only: inspect files and supplied evidence, but do not modify files or run commands.' : 'Review the proposed bug fix in the current repository. You are read-only: inspect files and the supplied evidence, but do not modify files or run commands.',
    'When finished, call submit_review_result exactly once. Its accepted parameters are the authoritative completion result. If the tool is unavailable, reply with exactly one JSON object (a single fenced ```json block is also accepted) and no surrounding prose.',
    contract,
    'Hard type rules: bugAddressed and taskAddressed are JSON booleans, never explanatory strings. findings is always an array of strings, never an array of objects. Put explanations in summary or findings. Do not add fields that are not shown in the valid shape.',
    `Review evidence:\n${asJson({ task: input.task, profile: input.profile, diff: input.diff, filesChanged: input.filesChanged, validation: input.validation })}`,
  ].join('\n\n');
}

export class PiAgentRunner implements AgentRunner {
  readonly backendId?: string;
  private readonly providerId: string;
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
  private readonly fixerMaxTurns: number;
  private readonly reviewerMaxTurns: number;
  private readonly fixerMaxToolCalls: number;
  private readonly reviewerMaxToolCalls: number;
  private readonly fixerMaxRepeatedToolCalls: number;
  private readonly reviewerMaxRepeatedToolCalls: number;
  private readonly fixerCloseoutGraceMs: number;
  private readonly reviewerCloseoutGraceMs: number;
  private runtimePromise?: Promise<PiModelRuntime>;

  constructor(options: PiAgentRunnerOptions = {}) {
    this.backendId = options.backendId?.trim() || undefined;
    this.providerId = options.providerId?.trim() || (this.backendId ? `${PROVIDER_ID}-${this.backendId.replace(/[^a-zA-Z0-9._-]/gu, '-')}` : PROVIDER_ID);
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
    this.fixerMaxTurns = positiveInteger(options.fixerMaxTurns ?? envNumber('PI_FIXER_MAX_TURNS'), DEFAULT_MAX_TURNS, 'PI_FIXER_MAX_TURNS');
    this.reviewerMaxTurns = positiveInteger(options.reviewerMaxTurns ?? envNumber('PI_REVIEWER_MAX_TURNS'), DEFAULT_MAX_TURNS, 'PI_REVIEWER_MAX_TURNS');
    this.fixerMaxToolCalls = positiveInteger(options.fixerMaxToolCalls ?? envNumber('PI_FIXER_MAX_TOOL_CALLS'), DEFAULT_MAX_TOOL_CALLS, 'PI_FIXER_MAX_TOOL_CALLS');
    this.reviewerMaxToolCalls = positiveInteger(options.reviewerMaxToolCalls ?? envNumber('PI_REVIEWER_MAX_TOOL_CALLS'), DEFAULT_MAX_TOOL_CALLS, 'PI_REVIEWER_MAX_TOOL_CALLS');
    this.fixerMaxRepeatedToolCalls = positiveInteger(options.fixerMaxRepeatedToolCalls ?? envNumber('PI_FIXER_MAX_REPEATED_TOOL_CALLS'), DEFAULT_MAX_REPEATED_TOOL_CALLS, 'PI_FIXER_MAX_REPEATED_TOOL_CALLS');
    this.reviewerMaxRepeatedToolCalls = positiveInteger(options.reviewerMaxRepeatedToolCalls ?? envNumber('PI_REVIEWER_MAX_REPEATED_TOOL_CALLS'), DEFAULT_MAX_REPEATED_TOOL_CALLS, 'PI_REVIEWER_MAX_REPEATED_TOOL_CALLS');
    this.fixerCloseoutGraceMs = positiveTimeout(options.fixerCloseoutGraceMs ?? envNumber('PI_FIXER_CLOSEOUT_GRACE_MS'), DEFAULT_CLOSEOUT_GRACE_MS, 'PI_FIXER_CLOSEOUT_GRACE_MS');
    this.reviewerCloseoutGraceMs = positiveTimeout(options.reviewerCloseoutGraceMs ?? envNumber('PI_REVIEWER_CLOSEOUT_GRACE_MS'), DEFAULT_CLOSEOUT_GRACE_MS, 'PI_REVIEWER_CLOSEOUT_GRACE_MS');
  }

  /**
   * Build fixer tool definitions that shadow Pi's built-ins with audit
   * logging and optional workspace confinement:
   * - every tool call is logged (tool name + parameter summary) so operators
   *   can follow what the agent is doing in real time via the dev log;
   * - bash runs through an explicit sandbox wrapper when bashShellPath is set;
   * - edit/write reject any path that resolves outside the worktree when
   *   confineWorkspace is set.
   */
  private fixerConfinedTools(cwd: string, completion?: SubmitFixResultToolOptions): ToolDefinition[] {
    // Pi's concrete tool definitions are generic over their schema; the custom
    // tools boundary is the unparameterized ToolDefinition, so the variance is
    // bridged with an explicit cast at this single point.
    const audited = (name: string, definition: ToolDefinition, confinePaths: boolean): ToolDefinition => ({
      ...definition,
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        const summary = summarizeToolParams(name, params);
        this.logger?.info({ role: 'fixer', tool: name, ...summary }, 'pi fixer tool call');
        if (confinePaths) {
          const requested = (params as { path?: unknown } | undefined)?.path;
          if (typeof requested !== 'string' || !requested.trim()) throw new Error('A file path is required');
          const resolved = path.resolve(cwd, requested);
          if (resolved !== cwd && !resolved.startsWith(`${cwd}${path.sep}`)) throw new Error(`Path escapes the worktree sandbox: ${requested}`);
        }
        try {
          return await definition.execute(toolCallId, params, signal, onUpdate, ctx);
        } catch (error) {
          this.logger?.error({ role: 'fixer', tool: name, error: error instanceof Error ? error.message : String(error) }, 'pi fixer tool call failed');
          throw error;
        }
      },
    });
    const tools: ToolDefinition[] = [];
    const bashDefinition: ToolDefinition | undefined = this.bashShellPath ? createBashToolDefinition(cwd, { shellPath: this.bashShellPath }) as unknown as ToolDefinition : undefined;
    const editDefinition = createEditToolDefinition(cwd) as unknown as ToolDefinition;
    const writeDefinition = createWriteToolDefinition(cwd) as unknown as ToolDefinition;
    // The bash tool must stay audited even without a sandbox wrapper so the
    // log always shows which commands the fixer executes.
    if (bashDefinition) tools.push(audited('bash', bashDefinition, false));
    if (this.logger) tools.push(audited('edit', editDefinition, this.confineWorkspace), audited('write', writeDefinition, this.confineWorkspace));
    else if (this.confineWorkspace) tools.push(audited('edit', editDefinition, true), audited('write', writeDefinition, true));
    if (completion) tools.push(createSubmitFixResultTool(completion));
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
        runtime.registerProvider(this.providerId, {
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
        if (!runtime.getModel(this.providerId, this.modelName)) throw new Error(`Pi model is unavailable: ${this.providerId}/${this.modelName}`);
        return runtime;
      })();
    }
    return this.runtimePromise;
  }

  private async runRole<T>(role: 'fixer' | 'reviewer', cwd: string, prompt: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, signal?: AbortSignal, completion?: CompletionToolOptions, progress?: PiProgressSink): Promise<T> {
    if (role === 'fixer' && this.requireSandbox && !this.sandboxProfile) throw new Error('Pi fixer is disabled: PI_SANDBOX_PROFILE must name an externally enforced sandbox');
    if (signal?.aborted) throw new Error('Pi session cancelled');
    const runtime = await this.getRuntime();
    const model = runtime.getModel(this.providerId, this.modelName);
    if (!model) throw new Error(`Pi model is unavailable: ${this.providerId}/${this.modelName}`);
    const customTools: ToolDefinition[] = role === 'fixer'
      ? this.fixerConfinedTools(cwd, completion as SubmitFixResultToolOptions | undefined)
      : completion ? [createSubmitReviewResultTool(completion as SubmitReviewResultToolOptions)] : [];
    // `createAgentSession({ tools })` doubles as Pi's allowed-tool allowlist;
    // include the SDK completion tool there or Pi would register but hide it.
    const tools = role === 'fixer' ? [...FIXER_TOOLS, ...(completion ? ['submit_fix_result'] as const : [])] : [...REVIEWER_TOOLS, ...(completion ? ['submit_review_result'] as const : [])];
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
      ...(this.backendId ? { backendId: this.backendId } : {}),
      providerId: this.providerId,
    });
    const session = sessionResult.session;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let closeoutExpired: Promise<void> | undefined;
    let timedOut = false;
    let closeoutRequested = false;
    let resolveBudgetTriggered: (() => void) | undefined;
    const budgetTriggered = new Promise<void>((resolve) => { resolveBudgetTriggered = resolve; });
    let budgetError: PiAgentLoopBudgetError | undefined;
    let turns = 0;
    let toolCalls = 0;
    let previousToolSignature = '';
    let repeatedToolCalls = 0;
    const timeoutMs = role === 'fixer' ? this.fixerTimeoutMs : this.reviewerTimeoutMs;
    const maxTurns = role === 'fixer' ? this.fixerMaxTurns : this.reviewerMaxTurns;
    const maxToolCalls = role === 'fixer' ? this.fixerMaxToolCalls : this.reviewerMaxToolCalls;
    const maxRepeatedToolCalls = role === 'fixer' ? this.fixerMaxRepeatedToolCalls : this.reviewerMaxRepeatedToolCalls;
    const closeoutGraceMs = role === 'fixer' ? this.fixerCloseoutGraceMs : this.reviewerCloseoutGraceMs;
    const completionName = role === 'fixer' ? 'submit_fix_result' : 'submit_review_result';
    const closeoutText = `Stop inspecting and editing now. Submit the structured result with ${completionName} or the exact JSON fallback immediately. Do not start another tool call.`;
    const emitProgress = (event: PiProgressEvent): void => {
      if (!progress) return;
      try { void Promise.resolve(progress(event)).catch((error) => this.logger?.error({ role, error: error instanceof Error ? error.message : String(error) }, 'pi progress sink failed')); }
      catch (error) { this.logger?.error({ role, error: error instanceof Error ? error.message : String(error) }, 'pi progress sink failed'); }
    };
    const unsubscribe = session.subscribe?.((event) => {
      const summary: Record<string, string | number | boolean> = { role, type: event.type };
      const eventTurnIndex = 'turnIndex' in event && typeof event.turnIndex === 'number' ? event.turnIndex : undefined;
      if (eventTurnIndex !== undefined) summary.turnIndex = eventTurnIndex;
      if (event.type === 'turn_start') turns = eventTurnIndex === undefined ? turns + 1 : Math.max(turns, eventTurnIndex + 1);
      if (event.type === 'tool_execution_start') {
        toolCalls += 1;
        summary.tool = event.toolName;
        const signature = `${event.toolName}:${JSON.stringify(event.args ?? {})}`;
        repeatedToolCalls = signature === previousToolSignature ? repeatedToolCalls + 1 : 1;
        previousToolSignature = signature;
        summary.toolCalls = toolCalls;
        summary.repeatedToolCalls = repeatedToolCalls;
      }
      if (event.type === 'tool_execution_end') { summary.tool = event.toolName; summary.isError = event.isError; }
      if (event.type === 'turn_start' || event.type === 'turn_end' || event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
        const tool = 'toolName' in event && typeof event.toolName === 'string' ? event.toolName : undefined;
        const persistedParams = tool && 'args' in event ? summarizePersistedToolParams(tool, event.args) : {};
        const safeSummary = event.type === 'tool_execution_start' && tool
          ? `${tool} started${Object.keys(persistedParams).length ? ` (${JSON.stringify(persistedParams)})` : ''}`
          : event.type === 'tool_execution_end' && tool ? `${tool} completed` : event.type.replaceAll('_', ' ');
        emitProgress({ role, eventType: event.type, ...(tool ? { tool } : {}), ...('isError' in event && typeof event.isError === 'boolean' ? { isError: event.isError } : {}), ...(eventTurnIndex === undefined ? {} : { turnIndex: eventTurnIndex }), ...(toolCalls ? { toolCallCount: toolCalls } : {}), summary: safeSummary });
      }
      if (event.type === 'auto_retry_start' || event.type === 'auto_retry_end' || event.type === 'compaction_start' || event.type === 'compaction_end') {
        this.logger?.info(summary, `pi ${role} session event`);
      } else if (event.type === 'turn_start' || event.type === 'turn_end' || event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
        this.logger?.info(summary, `pi ${role} session event`);
      }
      const limit = turns >= maxTurns ? ['max_turns', turns] as const
        : toolCalls >= maxToolCalls ? ['max_tool_calls', toolCalls] as const
          : repeatedToolCalls >= maxRepeatedToolCalls ? ['max_repeated_tool_calls', repeatedToolCalls] as const : undefined;
      if (!limit || closeoutRequested) return;
      budgetError = new PiAgentLoopBudgetError(role, limit[0], limit[1]);
      closeoutRequested = true;
      this.logger?.error({ role, limit: limit[0], value: limit[1] }, 'pi session budget reached; requesting one closeout');
      // Pi queues a prompt submitted from an event callback. The one-shot flag
      // and grace timer ensure that this cannot turn into another open loop.
      void Promise.resolve().then(async () => {
        try {
          // The session is already streaming when the budget event fires. Pi
          // requires an explicit delivery mode for an in-flight prompt; steer
          // asks it to finish this one bounded closeout before the grace timer
          // performs the hard abort.
          await session.prompt(closeoutText, { expandPromptTemplates: false, source: 'rpc', streamingBehavior: 'steer' });
        } catch { /* the grace timer still performs the bounded abort */ }
      });
      closeoutExpired = new Promise<void>((resolve) => {
        closeoutTimer = setTimeout(() => {
          // Resolve the budget wait at the deadline even if an SDK abort
          // implementation stalls; the operation must remain hard-bounded.
          resolve();
          try { void Promise.resolve(session.abort()).catch(() => undefined); } catch { /* best-effort abort */ }
        }, closeoutGraceMs);
      });
      resolveBudgetTriggered?.();
    });
    try {
      const operation = (async () => {
        this.logger?.info({ role, cwd, promptBytes: prompt.length }, `pi ${role} session prompt`);
        emitProgress({ role, eventType: 'session_start', summary: `${role} session started` });
        // A steer is queued while the original prompt is streaming. Race the
        // session's completion against the one-shot grace deadline so an SDK
        // prompt that only settles after abort cannot keep this operation
        // hanging indefinitely.
        const initialPrompt = session.prompt(prompt, { expandPromptTemplates: false, source: 'rpc' });
        const initialOutcome = initialPrompt.then(
          () => ({ kind: 'completed' as const }),
          (error) => ({ kind: 'error' as const, error }),
        );
        const outcome = await Promise.race([
          initialOutcome,
          budgetTriggered.then(() => Promise.race([
            initialOutcome,
            closeoutExpired!.then(() => ({ kind: 'expired' as const })),
          ])),
        ]);
        if (outcome.kind === 'expired') throw budgetError ?? new PiAgentLoopBudgetError(role, 'closeout_grace', closeoutGraceMs);
        if (outcome.kind === 'error' && !budgetError) throw outcome.error;
        // A successful structured tool call is authoritative even when the
        // model appends ordinary prose or an invalid final assistant message.
        if (completion?.result) return completion.result as unknown as T;
        if (budgetError) {
          // Budget closeout is deliberately a separate protocol path: allow
          // exactly one final text parse (with only the fixer wire repair),
          // never the ordinary two-attempt correction loop. If it is invalid,
          // consume the remaining grace so the timer performs the hard abort
          // before reporting the budget failure.
          try {
            const output = await session.getLastAssistantText();
            if (output === undefined || output === null) throw new Error(`Pi ${role} session returned no assistant text`);
            const parsed = parseAgentJson(output);
            const adapted = role === 'fixer' ? repairAgentFixResultInput(parsed, (fields) => this.logger?.info({ role, fields }, 'contract_repaired')) : parsed;
            return schema.parse(adapted);
          } catch (error) {
            this.logger?.error({ role, error: error instanceof Error ? error.message : String(error) }, `pi ${role} closeout output failed validation`);
            await closeoutExpired;
            throw budgetError ?? new PiAgentLoopBudgetError(role, 'closeout_grace', closeoutGraceMs);
          }
        }
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
            const parsed = parseAgentJson(output);
            const adapted = role === 'fixer' ? repairAgentFixResultInput(parsed, (fields) => this.logger?.info({ role, fields }, 'contract_repaired')) : parsed;
            return schema.parse(adapted);
          } catch (error) {
            lastValidationError = error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n') : error instanceof Error ? error.message : String(error);
            this.logger?.error({ role, attempt: attempt + 1, validationError: lastValidationError, outputBytes: output.length }, `pi ${role} output failed validation`);
            if (attempt === 0) {
              const correctionContract = role === 'reviewer'
                ? [
                  'Reviewer contract reminder: bugfix results require bugAddressed as a literal JSON boolean; development results require taskAddressed as a literal JSON boolean and acceptanceCriteriaMet as an array of {criterion: string, met: boolean, evidence: string}.',
                  'findings must be an array whose every item is a string. Put explanations in summary or findings; do not use explanatory strings for boolean fields and do not use objects as findings.',
                ].join('\n')
                : '';
              await session.prompt([
                `Your previous response failed output validation:\n${lastValidationError}`,
                'Reply again with exactly one JSON object (a single fenced ```json block is also accepted) matching the required schema and no surrounding prose.',
                'Every required field must be present with the correct type. Array fields must always be JSON arrays: wrap prose values like ["note"] instead of "note", and use [] when empty.',
                correctionContract,
                'Do not invent facts to satisfy validation.',
              ].filter(Boolean).join('\n'), { expandPromptTemplates: false, source: 'rpc' });
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
      const result = await Promise.race(cancelled ? [operation, timeout, cancelled] : [operation, timeout]);
      emitProgress({ role, eventType: 'completed', summary: `${role} completed` });
      return result;
    } catch (error) {
      emitProgress({ role, eventType: 'failed', isError: true, summary: redactedToolValue(error instanceof Error ? error.message : String(error), 1024) });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (closeoutTimer) clearTimeout(closeoutTimer);
      unsubscribe?.();
      // `timedOut` is kept explicit to make the cancellation intent visible;
      // Pi's abort is best-effort and dispose is always required.
      if (timedOut) await Promise.resolve().catch(() => undefined);
      session.dispose();
    }
  }

  async runFixer(input: FixerInput): Promise<AgentFixResultChecked> {
    const task = BugFixTaskSchema.parse(input.task);
    const profile = EnvironmentProfileSchema.parse(input.profile);
    const completion: SubmitFixResultToolOptions = { expectedBugKey: task.bugKey, logger: this.logger, onSubmit: () => undefined };
    const result = await this.runRole('fixer', input.worktreePath, fixerPrompt({ ...input, task, profile }, input.safety || this.safety), StrictFixResultSchema, input.signal, completion, input.progress);
    if (result.bugKey !== task.bugKey) throw new Error(`Pi fixer returned bugKey ${result.bugKey}, expected ${task.bugKey}`);
    return result;
  }

  async runCoder(input: Omit<FixerInput, 'task'> & { task: CodingTask }): Promise<AgentTaskResultChecked> {
    const task = CodingTaskSchema.parse(input.task);
    if (task.taskType === 'bugfix') {
      const legacy = await this.runFixer({ ...input, task });
      return StrictTaskResultSchema.parse({ bugKey: legacy.bugKey, taskType: 'bugfix', status: legacy.status === 'fixed' ? 'completed' : legacy.status === 'failed' ? 'failed' : 'blocked', confidence: legacy.confidence, summary: legacy.summary, filesChanged: legacy.filesChanged, validationNotes: [], riskNotes: legacy.riskNotes, blockedReason: legacy.blockedReason, missingInformation: legacy.missingInformation, bugfixDetails: { rootCause: legacy.rootCause, reproduced: legacy.reproduced, regressionTestAdded: legacy.regressionTestAdded } });
    }
    const profile = EnvironmentProfileSchema.parse(input.profile);
    const result = await this.runRole('fixer', input.worktreePath, coderPrompt({ ...input, task, profile }, input.safety || this.safety), StrictTaskResultSchema, input.signal, undefined, input.progress);
    if (result.bugKey !== task.bugKey) throw new Error(`Pi coder returned bugKey ${result.bugKey}, expected ${task.bugKey}`);
    return result;
  }

  async runReviewer(input: ReviewerInput): Promise<ReviewResultChecked> {
    const task = 'taskType' in input.task ? CodingTaskSchema.parse(input.task) : BugFixTaskSchema.parse(input.task);
    const profile = EnvironmentProfileSchema.parse(input.profile);
    const validation = DeterministicValidationSchema.parse(input.validation);
    if ('taskType' in task && task.taskType === 'development') {
      const completion: SubmitReviewResultToolOptions = { taskType: 'development', logger: this.logger, onSubmit: () => undefined };
      return this.runRole('reviewer', input.worktreePath, reviewerPrompt({ ...input, task, profile, validation }), StrictDevelopmentReviewResultSchema, input.signal, completion, input.progress);
    }
    const completion: SubmitReviewResultToolOptions = { taskType: 'bugfix', logger: this.logger, onSubmit: () => undefined };
    return this.runRole('reviewer', input.worktreePath, reviewerPrompt({ ...input, task, profile, validation }), StrictBugReviewResultSchema, input.signal, completion, input.progress);
  }
}

export class FakePiRunner implements AgentRunner {
  readonly fixerSessions: string[] = [];
  readonly reviewerSessions: string[] = [];
  /** Backend ids are deliberately observable in tests and never in prompts. */
  readonly fixerBackendIds: string[] = [];
  readonly reviewerBackendIds: string[] = [];
  readonly backendId?: string;
  constructor(private readonly fixResult?: AgentFixResultChecked, private readonly reviewResult?: ReviewResultChecked, options: { backendId?: string } | string = {}) {
    this.backendId = typeof options === 'string' ? options : options.backendId;
  }
  async runFixer(input: FixerInput): Promise<AgentFixResultChecked> {
    const sessionId = newId();
    this.fixerSessions.push(sessionId);
    this.fixerBackendIds.push(input.backendId ?? this.backendId ?? 'fake');
    const result = StrictFixResultSchema.parse(this.fixResult ?? { bugKey: input.task.bugKey, status: 'fixed', confidence: 1, summary: 'Fake fixer result', rootCause: null, reproduced: true, regressionTestAdded: false, filesChanged: [], riskNotes: [], blockedReason: null, missingInformation: [] });
    await input.progress?.({ role: 'fixer', eventType: 'completed', summary: 'fixer completed' });
    return result;
  }

  async runCoder(input: Omit<FixerInput, 'task'> & { task: CodingTask }): Promise<AgentTaskResultChecked> {
    if (input.task.taskType === 'bugfix') {
      const legacy = await this.runFixer({ ...input, task: input.task });
      return StrictTaskResultSchema.parse({ bugKey: legacy.bugKey, taskType: 'bugfix', status: legacy.status === 'fixed' ? 'completed' : legacy.status === 'failed' ? 'failed' : 'blocked', confidence: legacy.confidence, summary: legacy.summary, filesChanged: legacy.filesChanged, validationNotes: [], riskNotes: legacy.riskNotes, blockedReason: legacy.blockedReason, missingInformation: legacy.missingInformation, bugfixDetails: { rootCause: legacy.rootCause, reproduced: legacy.reproduced, regressionTestAdded: legacy.regressionTestAdded } });
    }
    const result = StrictTaskResultSchema.parse({ bugKey: input.task.bugKey, taskType: 'development', status: 'completed', confidence: 1, summary: 'Fake coder result', filesChanged: [], validationNotes: [], riskNotes: [], blockedReason: null, missingInformation: [], developmentDetails: { requirementsAddressed: input.task.requirements, acceptanceCriteriaAddressed: input.task.acceptanceCriteria, designNotes: [] } });
    await input.progress?.({ role: 'fixer', eventType: 'completed', summary: 'coder completed' });
    return result;
  }
  async runReviewer(input: ReviewerInput): Promise<ReviewResultChecked> {
    const sessionId = newId();
    this.reviewerSessions.push(sessionId);
    this.reviewerBackendIds.push(input.backendId ?? this.backendId ?? 'fake');
    let result: ReviewResultChecked;
    if ('taskType' in input.task && input.task.taskType === 'development') {
      result = StrictDevelopmentReviewResultSchema.parse(this.reviewResult ?? {
        verdict: input.validation.passed ? 'approve' : 'reject',
        taskAddressed: input.validation.passed,
        acceptanceCriteriaMet: input.task.acceptanceCriteria.map((criterion) => ({ criterion, met: input.validation.passed, evidence: 'Fake validation evidence' })),
        regressionRisk: 'low', summary: 'Fake review result', findings: [],
      }) as ReviewResultChecked;
    } else {
      result = StrictBugReviewResultSchema.parse(this.reviewResult ?? {
        verdict: input.validation.passed ? 'approve' : 'reject', bugAddressed: input.validation.passed,
        regressionRisk: 'low', summary: 'Fake review result', findings: [],
      }) as ReviewResultChecked;
    }
    await input.progress?.({ role: 'reviewer', eventType: 'completed', summary: 'reviewer completed' });
    return result;
  }
}

/** Minimal backend shape accepted by the runner factory. It intentionally
 * mirrors the dispatcher config without creating a package dependency cycle. */
export interface PiBackendDefinition {
  id: string;
  endpointUrl: string;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  fixerTimeoutMs?: number;
  reviewerTimeoutMs?: number;
}

export interface PiAgentRunnerFactoryOptions extends Omit<PiAgentRunnerOptions, 'endpoint' | 'endpointUrl' | 'model' | 'apiKey' | 'backendId' | 'providerId' | 'fixerTimeoutMs' | 'reviewerTimeoutMs'> {
  env?: NodeJS.ProcessEnv;
  /** Shared runtime is allowed; provider IDs remain backend-scoped. */
  modelRuntime?: PiModelRuntime;
  modelRuntimeFactory?: () => Promise<PiModelRuntime>;
}

/**
 * Creates and caches one Pi runner per backend id. Each runner has its own
 * provider/model registration and registration is single-flight inside the
 * runner, so concurrent first calls cannot register a provider twice.
 */
export class PiAgentRunnerFactory {
  private readonly backends = new Map<string, PiBackendDefinition>();
  private readonly runners = new Map<string, PiAgentRunner>();
  private readonly options: PiAgentRunnerFactoryOptions;
  private readonly env: NodeJS.ProcessEnv;

  constructor(backends: readonly PiBackendDefinition[], options: PiAgentRunnerFactoryOptions = {}) {
    this.options = options;
    this.env = options.env ?? process.env;
    for (const backend of backends) {
      if (this.backends.has(backend.id)) throw new Error(`Duplicate Pi backend id: ${backend.id}`);
      if (!backend.id.trim() || !backend.endpointUrl.trim() || !backend.model.trim()) throw new Error('Pi backend id, endpointUrl, and model are required');
      this.backends.set(backend.id, { ...backend });
    }
  }

  get(backendId: string): PiAgentRunner {
    const cached = this.runners.get(backendId);
    if (cached) return cached;
    const backend = this.backends.get(backendId);
    if (!backend) throw new Error(`Unknown Pi backend: ${backendId}`);
    const apiKey = backend.apiKey ?? (backend.apiKeyEnv ? this.env[backend.apiKeyEnv]?.trim() || undefined : undefined);
    const runner = new PiAgentRunner({
      ...this.options,
      endpointUrl: backend.endpointUrl,
      model: backend.model,
      ...(apiKey ? { apiKey } : {}),
      backendId: backend.id,
      ...(backend.fixerTimeoutMs === undefined ? {} : { fixerTimeoutMs: backend.fixerTimeoutMs }),
      ...(backend.reviewerTimeoutMs === undefined ? {} : { reviewerTimeoutMs: backend.reviewerTimeoutMs }),
    });
    this.runners.set(backendId, runner);
    return runner;
  }

  has(backendId: string): boolean { return this.backends.has(backendId); }
  listBackendIds(): string[] { return [...this.backends.keys()]; }
  clear(): void { this.runners.clear(); }
}

export const createPiAgentRunnerFactory = (backends: readonly PiBackendDefinition[], options: PiAgentRunnerFactoryOptions = {}): PiAgentRunnerFactory => new PiAgentRunnerFactory(backends, options);
