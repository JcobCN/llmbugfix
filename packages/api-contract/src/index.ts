import { z } from 'zod';

/** ISO-8601 timestamp used on all wire resources. */
export const IsoTimestampSchema = z.string().datetime({ offset: true });

/** IDs are UUIDs throughout the public API. */
export const ResourceIdSchema = z.string().uuid();

export const ExternalTaskTypeSchema = z.enum(['bugfix', 'development']);
export type ExternalTaskType = z.infer<typeof ExternalTaskTypeSchema>;

export const ExternalExecutionTargetSchema = z.enum(['frontend', 'backend']);
export type ExternalExecutionTarget = z.infer<typeof ExternalExecutionTargetSchema>;

export const TaskPrioritySchema = z.enum(['high', 'normal', 'low']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const QualityTierSchema = z.enum(['standard', 'high']);
export type QualityTier = z.infer<typeof QualityTierSchema>;

const normalizedCapability = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9+._-]*$/u, 'Capability must be a normalized label');

/**
 * Validate the shorthand accepted by `git check-ref-format --branch`.
 *
 * This deliberately stays a pure check. In particular, do not shell out to
 * git here: this value is eventually passed to git commands and must be
 * rejected before it can be interpreted as an option or a revision pattern.
 */
const isValidGitBranchName = (value: string): boolean => {
  if (!value || value === '@' || value.startsWith('-')) return false;
  if (value.includes('..') || value.includes('@{')) return false;
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//')) return false;
  if (value.endsWith('.')) return false;

  // check-ref-format applies the component checks to every path component,
  // including a one-component branch name. A component may not start with a
  // dot or end in .lock.
  const components = value.split('/');
  if (components.some((component) => component.startsWith('.') || component.endsWith('.lock'))) return false;

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    // Git's refname check rejects ASCII control bytes, including DEL, and
    // these special ref syntax characters. Backslash is checked explicitly.
    if (codePoint <= 0x20 || codePoint === 0x7f || '~^:?*[\\'.includes(character)) return false;
  }
  return true;
};

/** Hints are advisory; callers never select an endpoint or model directly. */
export const RoutingRequirementsSchema = z.object({
  priority: TaskPrioritySchema.default('normal'),
  capabilityHints: z.array(normalizedCapability).max(16).default([]),
  quality: QualityTierSchema.default('standard'),
}).strict();
export type RoutingRequirements = z.infer<typeof RoutingRequirementsSchema>;

/**
 * A repository accepted by the worker. HTTP(S), SSH, and scp-style remotes are supported;
 * local paths and credentials embedded in HTTP(S) URLs are deliberately not.
 */
export const RepositoryTargetSchema = z.object({
  cloneUrl: z.string().trim().min(1).max(2_048).superRefine((value, context) => {
    if (/^[a-zA-Z]:/u.test(value) || value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('\\\\')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Repository cloneUrl must not be a local path' });
      return;
    }
    // A scp-style remote has a user@host prefix. Requiring the @ keeps
    // ambiguous values such as `foo:bar` from bypassing URI scheme checks.
    const scpStyle = /^(?:[^@/\\:\s]+@)([^/\\:\s]+):[^\s]+$/u.test(value);
    if (scpStyle) return;

    const scheme = value.match(/^([a-z][a-z0-9+.-]*):/iu)?.[1].toLowerCase();

    let parsed: URL;
    if (!scheme || value.slice(0, scheme.length + 3).toLowerCase() !== `${scheme}://`) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Repository cloneUrl must be an HTTP(S) or SSH Git remote' });
      return;
    }
    try { parsed = new URL(value); } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Repository cloneUrl must be an HTTP(S) or SSH Git remote' });
      return;
    }
    if (!['http:', 'https:', 'ssh:'].includes(parsed.protocol)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Repository cloneUrl must use http, https, or ssh' });
      return;
    }
    if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Repository cloneUrl must include a repository path' });
    }
    // SSH URLs may have a user (normally git), but never a password. HTTP
    // credentials are rejected entirely because they are commonly tokens.
    if (parsed.password || (['http:', 'https:'].includes(parsed.protocol) && parsed.username)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Repository cloneUrl must not contain credentials' });
    }
  }),
  baseBranch: z.string().min(1).max(255).refine(isValidGitBranchName, 'baseBranch contains invalid Git ref characters').default('main'),
}).strict();
export type RepositoryTarget = z.infer<typeof RepositoryTargetSchema>;

const ExternalTaskBaseSchema = z.object({
  title: z.string().trim().min(1).max(500),
  executionTarget: ExternalExecutionTargetSchema,
  repository: RepositoryTargetSchema,
  dev_env_snapshot: z.string().trim().min(1).max(50_000),
  dev_env_special: z.array(z.string().trim().min(1).max(50_000)).min(1).max(100).optional(),
  routing: RoutingRequirementsSchema.default({}),
}).strict();

export const ExternalBugfixTaskSchema = ExternalTaskBaseSchema.extend({
  taskType: z.literal('bugfix'),
  actualBehavior: z.string().trim().min(1).max(50_000),
  expectedBehavior: z.string().trim().min(1).max(50_000),
  reproductionSteps: z.array(z.string().trim().min(1).max(10_000)).min(1).max(100),
  errorMessages: z.array(z.string().trim().min(1).max(50_000)).max(100).optional(),
  stackTraces: z.array(z.string().trim().min(1).max(50_000)).max(100).optional(),
  environment: z.record(z.unknown()).optional(),
}).strict();
export type ExternalBugfixTask = z.infer<typeof ExternalBugfixTaskSchema>;

export const ExternalDevelopmentTaskSchema = ExternalTaskBaseSchema.extend({
  taskType: z.literal('development'),
  objective: z.string().trim().min(1).max(50_000),
  requirements: z.array(z.string().trim().min(1).max(10_000)).min(1).max(100),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(10_000)).min(1).max(100),
  constraints: z.array(z.string().trim().min(1).max(10_000)).max(100).optional(),
  nonGoals: z.array(z.string().trim().min(1).max(10_000)).max(100).optional(),
}).strict();
export type ExternalDevelopmentTask = z.infer<typeof ExternalDevelopmentTaskSchema>;

export const ExternalTaskCreateRequestSchema = z.discriminatedUnion('taskType', [
  ExternalBugfixTaskSchema,
  ExternalDevelopmentTaskSchema,
]);
export type ExternalTaskCreateRequest = z.infer<typeof ExternalTaskCreateRequestSchema>;

export const PublicTaskStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type PublicTaskStatus = z.infer<typeof PublicTaskStatusSchema>;

export const PublicTaskStageSchema = z.enum([
  'queued',
  'preparing_environment',
  'fixing',
  'validating',
  'reviewing',
  'pushing',
  'ready',
  'human_review',
  'failed',
  'cancelled',
]);
export type PublicTaskStage = z.infer<typeof PublicTaskStageSchema>;

const TaskLinksSchema = z.object({
  self: z.string().min(1),
  events: z.string().min(1),
  result: z.string().min(1),
}).strict();

export const ExternalTaskResourceSchema = z.object({
  taskId: ResourceIdSchema,
  taskKey: z.string().regex(/^BUG-[0-9]{6,}$/u),
  taskType: ExternalTaskTypeSchema,
  title: z.string().min(1),
  executionTarget: ExternalExecutionTargetSchema,
  status: PublicTaskStatusSchema,
  stage: PublicTaskStageSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  links: TaskLinksSchema,
}).strict();
export type ExternalTaskResource = z.infer<typeof ExternalTaskResourceSchema>;

export const ExternalFixSummarySchema = z.object({
  status: z.enum(['fixed', 'blocked', 'not_reproducible', 'failed', 'completed']),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  rootCause: z.string().nullable().optional(),
  filesChanged: z.array(z.string()),
  riskNotes: z.array(z.string()),
}).strict();

export const ExternalValidationSummarySchema = z.object({
  passed: z.boolean(),
  summary: z.string(),
  commands: z.array(z.string()),
  results: z.array(z.object({
    command: z.string(),
    exitCode: z.number().int(),
    passed: z.boolean(),
    output: z.string(),
  }).strict()),
}).strict();

export const ExternalReviewSummarySchema = z.object({
  verdict: z.enum(['approve', 'reject']),
  addressed: z.boolean(),
  regressionRisk: z.enum(['low', 'medium', 'high']),
  summary: z.string(),
  findings: z.array(z.string()),
}).strict();

export const PatchDeliverySchema = z.object({
  type: z.literal('patch'),
  pushed: z.literal(false),
  branch: z.null(),
  commitSha: z.null(),
  diff: z.string().nullable(),
}).strict();

export const GitBranchDeliverySchema = z.object({
  type: z.literal('git_branch'),
  pushed: z.literal(true),
  branch: z.string().min(1),
  commitSha: z.string().regex(/^[a-f0-9]{7,64}$/iu),
  diff: z.string().nullable(),
}).strict();

export const ExternalDeliverySchema = z.discriminatedUnion('type', [PatchDeliverySchema, GitBranchDeliverySchema]);
export type ExternalDelivery = z.infer<typeof ExternalDeliverySchema>;

export const ExternalTaskFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
}).strict();

export const ExternalTaskResultSchema = z.object({
  taskId: ResourceIdSchema,
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  completedAt: IsoTimestampSchema,
  fix: ExternalFixSummarySchema.nullable(),
  validation: ExternalValidationSummarySchema.nullable(),
  review: ExternalReviewSummarySchema.nullable(),
  delivery: ExternalDeliverySchema.nullable(),
  error: ExternalTaskFailureSchema.nullable(),
}).strict();
export type ExternalTaskResult = z.infer<typeof ExternalTaskResultSchema>;

export const ExternalTaskEventTypeSchema = z.enum([
  'task.created',
  'task.queued',
  'task.started',
  'task.stage_changed',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.retry_requested',
]);
export type ExternalTaskEventType = z.infer<typeof ExternalTaskEventTypeSchema>;

export const ExternalTaskEventSchema = z.object({
  eventId: ResourceIdSchema,
  sequence: z.number().int().nonnegative(),
  taskId: ResourceIdSchema,
  type: ExternalTaskEventTypeSchema,
  status: PublicTaskStatusSchema,
  stage: PublicTaskStageSchema,
  occurredAt: IsoTimestampSchema,
  data: z.record(z.unknown()).default({}),
}).strict();
export type ExternalTaskEvent = z.infer<typeof ExternalTaskEventSchema>;

export const ExternalApiErrorCodeSchema = z.enum([
  'INVALID_JSON',
  'INVALID_REQUEST',
  'MISSING_IDEMPOTENCY_KEY',
  'INVALID_IDEMPOTENCY_KEY',
  'INVALID_CURSOR',
  'TASK_NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'TASK_NOT_CANCELLABLE',
  'TASK_NOT_RETRYABLE',
  'REPOSITORY_URL_INVALID',
  'REPOSITORY_HOST_NOT_ALLOWED',
  'INVALID_BASE_BRANCH',
  'QUEUE_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export type ExternalApiErrorCode = z.infer<typeof ExternalApiErrorCodeSchema>;

export const ExternalApiErrorSchema = z.object({
  error: z.object({
    code: ExternalApiErrorCodeSchema,
    message: z.string().min(1),
    details: z.record(z.unknown()).optional(),
  }).strict(),
  requestId: ResourceIdSchema,
}).strict();
export type ExternalApiError = z.infer<typeof ExternalApiErrorSchema>;

export const ExternalTaskListSchema = z.object({
  data: z.array(ExternalTaskResourceSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
}).strict();
export type ExternalTaskList = z.infer<typeof ExternalTaskListSchema>;

export const ExternalTaskEventPageSchema = z.object({
  data: z.array(ExternalTaskEventSchema),
  nextAfter: z.number().int().nonnegative().nullable(),
  hasMore: z.boolean(),
}).strict();
export type ExternalTaskEventPage = z.infer<typeof ExternalTaskEventPageSchema>;

export const ExternalTaskSubmissionSchema = ExternalTaskResourceSchema.extend({
  idempotent: z.boolean().default(false),
}).strict();
export type ExternalTaskSubmission = z.infer<typeof ExternalTaskSubmissionSchema>;

// Lowercase aliases match the naming style used by the existing domain
// package, while the PascalCase exports remain the public API documentation.
export const externalTaskCreateRequestSchema = ExternalTaskCreateRequestSchema;
export const externalTaskResourceSchema = ExternalTaskResourceSchema;
export const externalTaskResultSchema = ExternalTaskResultSchema;
export const externalTaskEventSchema = ExternalTaskEventSchema;
export const externalApiErrorSchema = ExternalApiErrorSchema;
export const routingRequirementsSchema = RoutingRequirementsSchema;
