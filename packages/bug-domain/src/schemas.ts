import { z } from 'zod';

const iso = z.string().datetime({ offset: true });
const id = z.string().uuid();
const nullableString = z.string().nullable();
const devEnvSpecialItemSchema = z.string().trim().min(1).max(50_000);
const devEnvSpecialSchema = z.preprocess(
  (value) => typeof value === 'string' ? [value] : value,
  z.array(devEnvSpecialItemSchema).max(100).optional(),
);

export const BugTypeSchema = z.enum(['functional', 'ui', 'api', 'crash', 'performance', 'data', 'permission', 'compatibility', 'network', 'concurrency', 'unknown']);
export type BugType = z.infer<typeof BugTypeSchema>;
export const ExecutionTargetSchema = z.enum(['frontend', 'backend', 'unknown']);
export type ExecutionTarget = z.infer<typeof ExecutionTargetSchema>;
export const TaskTypeSchema = z.enum(['bugfix', 'development']);
export type TaskType = z.infer<typeof TaskTypeSchema>;
/**
 * Facts collected during intake for a project which does not yet have a
 * checked-in environment profile.  This is intentionally part of the draft
 * only: the server turns it into a generated, runnable profile after the
 * reporter confirms submission.
 */
export const EnvironmentProfileProposalSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  repositoryUrl: z.string().min(1).max(2_048).optional(),
  defaultBranch: z.string().min(1).max(255).optional(),
  target: z.enum(['frontend', 'backend']).optional(),
  setupCommands: z.array(z.string().min(1)).max(20).optional(),
  validationCommands: z.array(z.string().min(1)).max(20).optional(),
});
export type EnvironmentProfileProposal = z.infer<typeof EnvironmentProfileProposalSchema>;
export const UserSchema = z.object({ id, displayName: z.string().min(1), email: z.string().email().nullable(), createdAt: iso, updatedAt: iso });
export type User = z.infer<typeof UserSchema>;

export const BugStatusSchema = z.enum([
  'DRAFT', 'COLLECTING', 'READY_FOR_CONFIRMATION', 'SUBMITTED', 'TRIAGING', 'QUEUED', 'NEEDS_INFO',
  'PREPARING_ENV', 'FIXING', 'FIX_CANDIDATE', 'VALIDATING', 'REVIEWING', 'FIX_READY', 'FIX_FAILED', 'PUSHING',
  'READY_FOR_HUMAN_REVIEW', 'BLOCKED', 'CANCELLED', 'REJECTED', 'ENVIRONMENT_FAILED', 'VALIDATION_FAILED',
  'REVIEW_REJECTED', 'PUSH_FAILED',
]);
export type BugStatus = z.infer<typeof BugStatusSchema>;

export const AttachmentAnalysisStatusSchema = z.enum(['not_required', 'pending', 'completed', 'unsupported', 'failed']);
export const AttachmentRefSchema = z.object({
  id, filename: z.string().min(1), mimeType: z.string().min(1), size: z.number().int().nonnegative(),
  relativePath: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/i), extractedText: nullableString,
  analysisStatus: AttachmentAnalysisStatusSchema, analysisResult: nullableString,
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

const reproductionSchema = z.object({
  reproducible: z.boolean().nullable(),
  frequency: z.enum(['always', 'often', 'sometimes', 'rare', 'once', 'unknown']),
  prerequisites: z.array(z.string()), steps: z.array(z.string()), testData: z.array(z.string()),
});
const environmentSchema = z.object({
  environmentName: nullableString, appVersion: nullableString, buildNumber: nullableString, commitSha: nullableString,
  frontend: z.object({ route: nullableString, browser: nullableString, browserVersion: nullableString, os: nullableString, resolution: nullableString }).optional(),
  backend: z.object({ service: nullableString, endpoint: nullableString, method: nullableString, statusCode: z.number().int().nullable() }).optional(),
  additionalInfo: z.record(z.string()),
});
const evidenceSchema = z.object({
  errorMessages: z.array(z.string()), stackTraces: z.array(z.string()), logs: z.array(AttachmentRefSchema), screenshots: z.array(AttachmentRefSchema),
  videos: z.array(AttachmentRefSchema), networkTraces: z.array(AttachmentRefSchema), jsonFiles: z.array(AttachmentRefSchema), otherFiles: z.array(AttachmentRefSchema),
});

export const BugReportSchema = z.object({
  id, bugKey: z.string().regex(/^BUG-[0-9]{6,}$/), taskType: TaskTypeSchema.default('bugfix'), title: z.string().min(1), productArea: nullableString, component: nullableString,
  bugType: BugTypeSchema, executionTarget: ExecutionTargetSchema, environmentProfileId: z.string().min(1).nullable(),
  dev_env_snapshot: z.string().trim().min(1).optional(), dev_env_special: devEnvSpecialSchema,
  severity: z.enum(['low', 'medium', 'high', 'critical', 'unknown']), actualBehavior: z.string().default(''), expectedBehavior: nullableString,
  objective: nullableString.default(null), requirements: z.array(z.string().min(1)).default([]), acceptanceCriteria: z.array(z.string().min(1)).default([]),
  nonGoals: z.array(z.string().min(1)).default([]), constraints: z.array(z.string().min(1)).default([]), referenceContext: z.array(z.string().min(1)).default([]),
  reproduction: reproductionSchema, environment: environmentSchema, evidence: evidenceSchema,
  impact: z.object({ affectedUsers: nullableString, scope: z.enum(['single_user', 'some_users', 'all_users', 'unknown']), blocksTesting: z.boolean().nullable(), workaroundExists: z.boolean().nullable(), workaround: nullableString }),
  regression: z.object({ isRegression: z.boolean().nullable(), lastKnownGoodVersion: nullableString, suspectedVersion: nullableString }),
  observations: z.array(z.string()), reporterHypotheses: z.array(z.string()), reporter: z.object({ userId: id, displayName: z.string().min(1) }),
  intake: z.object({ completenessScore: z.number().min(0).max(100), confidence: z.number().min(0).max(1), missingInformation: z.array(z.string()), conversationId: id, llmSummary: z.string() }),
  createdAt: iso, updatedAt: iso,
});
export type BugReport = z.infer<typeof BugReportSchema>;
// The proposal is conversation state rather than a permanent BugReport field.
// Keeping it in the draft lets the LLM ask for a Git remote over several turns
// without turning an arbitrary repository address into executable state early.
export const BugReportDraftSchema = BugReportSchema.deepPartial().extend({
  environmentProfile: EnvironmentProfileProposalSchema.optional(),
});
export type BugReportDraft = z.infer<typeof BugReportDraftSchema>;

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system']);
export const ConversationStatusSchema = z.enum(['active', 'awaiting_confirmation', 'submitted', 'abandoned']);
export const ConversationMessageSchema = z.object({ id, conversationId: id, role: MessageRoleSchema, content: z.string(), metadata: z.record(z.unknown()).default({}), createdAt: iso });
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
export const BugConversationSchema = z.object({ id, reporterId: id, status: ConversationStatusSchema, draft: BugReportDraftSchema, completeness: z.lazy(() => CompletenessEvaluationSchema), createdAt: iso, updatedAt: iso });
export type BugConversation = z.infer<typeof BugConversationSchema>;

export const CompletenessEvaluationSchema = z.object({ score: z.number().min(0).max(100), dimensions: z.object({ problem: z.number().min(0).max(25), reproduction: z.number().min(0).max(30), environment: z.number().min(0).max(15), evidence: z.number().min(0).max(20), impact: z.number().min(0).max(10), objective: z.number().min(0).max(25).optional(), requirements: z.number().min(0).max(25).optional(), acceptance: z.number().min(0).max(25).optional(), scope: z.number().min(0).max(10).optional() }), missingCriticalInformation: z.array(z.string()), recommendedQuestions: z.array(z.string()), readyForSubmission: z.boolean(), readyForConfirmation: z.boolean().optional() });
export type CompletenessEvaluation = z.infer<typeof CompletenessEvaluationSchema>;

export const JobStatusSchema = z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);
export type JobStatus = z.infer<typeof JobStatusSchema>;
export const JobRoutingRequirementsSchema = z.object({
  priority: z.enum(['high', 'normal', 'low']).default('normal'),
  capabilityHints: z.array(z.string().min(1).max(64)).max(16).default([]),
  quality: z.enum(['standard', 'high']).default('standard'),
}).strict();
export type JobRoutingRequirements = z.infer<typeof JobRoutingRequirementsSchema>;
export const JobFailureClassSchema = z.enum([
  'connection', 'tls', 'timeout', 'http_408', 'http_429', 'http_5xx', 'http_4xx',
  'authentication', 'contract', 'cancelled', 'agent_failed', 'no_diff',
  'validation_failed', 'review_rejected', 'unknown',
]);
export type JobFailureClass = z.infer<typeof JobFailureClassSchema>;
export const JobSchema = z.object({
  id, bugId: id, status: JobStatusSchema, priority: z.number().int(), attempt: z.number().int().nonnegative(),
  createdAt: iso, startedAt: iso.nullable(), finishedAt: iso.nullable(), heartbeatAt: iso.nullable(), error: nullableString,
  // These fields are optional so rows created before lease-aware migrations
  // still validate and existing repository callers remain source-compatible.
  workerId: nullableString.optional(), leaseToken: nullableString.optional(), leaseExpiresAt: iso.nullable().optional(),
  claimedAt: iso.nullable().optional(), routingRequirements: JobRoutingRequirementsSchema.nullable().optional(),
  failureClass: JobFailureClassSchema.nullable().optional(), lastFailureBackendId: z.string().min(1).nullable().optional(),
});
export type Job = z.infer<typeof JobSchema>;

export const AgentRunStatusSchema = z.enum(['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']);
export const AgentRunSchema = z.object({
  id, bugId: id, jobId: id.nullable(), agentType: z.enum(['intake', 'fixer', 'reviewer', 'other']), status: AgentRunStatusSchema,
  sessionId: nullableString, startedAt: iso, finishedAt: iso.nullable(), input: z.record(z.unknown()).default({}), output: z.record(z.unknown()).nullable(), error: nullableString,
  backendId: z.string().min(1).nullable().optional(), model: z.string().min(1).nullable().optional(),
  roleAttempt: z.number().int().positive().optional(), failureClass: JobFailureClassSchema.nullable().optional(), leaseToken: nullableString.optional(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const BugFixTaskSchema = z.object({ bugKey: z.string().regex(/^BUG-[0-9]{6,}$/), title: z.string().min(1), executionTarget: z.enum(['frontend', 'backend']), environmentProfileId: z.string().min(1), dev_env_snapshot: z.string().trim().min(1).optional(), dev_env_special: devEnvSpecialSchema, actualBehavior: z.string().min(1), expectedBehavior: nullableString, reproductionSteps: z.array(z.string()), prerequisites: z.array(z.string()), environment: z.record(z.unknown()), errorMessages: z.array(z.string()), stackTraces: z.array(z.string()), attachments: z.array(AttachmentRefSchema), lastKnownGoodVersion: nullableString, failingVersion: nullableString, reporterObservations: z.array(z.string()), reporterHypotheses: z.array(z.string()), machineObservations: z.array(z.string()), missingInformation: z.array(z.string()), completenessScore: z.number().min(0).max(100) });
export type BugFixTask = z.infer<typeof BugFixTaskSchema>;

const CodingTaskBaseSchema = z.object({ bugKey: z.string().regex(/^BUG-[0-9]{6,}$/), title: z.string().min(1), executionTarget: z.enum(['frontend', 'backend']), environmentProfileId: z.string().min(1), dev_env_snapshot: z.string().trim().min(1).optional(), dev_env_special: devEnvSpecialSchema, environment: z.record(z.unknown()), attachments: z.array(AttachmentRefSchema), reporterObservations: z.array(z.string()), machineObservations: z.array(z.string()), missingInformation: z.array(z.string()), completenessScore: z.number().min(0).max(100) });
export const CodingTaskSchema = z.discriminatedUnion('taskType', [
  CodingTaskBaseSchema.extend({ taskType: z.literal('bugfix'), actualBehavior: z.string().min(1), expectedBehavior: nullableString, reproductionSteps: z.array(z.string()), prerequisites: z.array(z.string()), errorMessages: z.array(z.string()), stackTraces: z.array(z.string()), lastKnownGoodVersion: nullableString, failingVersion: nullableString, reporterHypotheses: z.array(z.string()) }),
  CodingTaskBaseSchema.extend({ taskType: z.literal('development'), objective: z.string().min(1), requirements: z.array(z.string().min(1)).min(1), acceptanceCriteria: z.array(z.string().min(1)).min(1), nonGoals: z.array(z.string().min(1)), constraints: z.array(z.string().min(1)), referenceContext: z.array(z.string().min(1)) }),
]);
export type CodingTask = z.infer<typeof CodingTaskSchema>;

export const AgentFixResultSchema = z.object({ bugKey: z.string().regex(/^BUG-[0-9]{6,}$/), status: z.enum(['fixed', 'blocked', 'not_reproducible', 'failed']), confidence: z.number().min(0).max(1), summary: z.string(), rootCause: nullableString, reproduced: z.boolean(), regressionTestAdded: z.boolean(), filesChanged: z.array(z.string()), riskNotes: z.array(z.string()), blockedReason: nullableString, missingInformation: z.array(z.string()) });
export type AgentFixResult = z.infer<typeof AgentFixResultSchema>;

export const AgentTaskResultSchema = z.object({ bugKey: z.string().regex(/^BUG-[0-9]{6,}$/), taskType: TaskTypeSchema, status: z.enum(['completed', 'blocked', 'failed']), confidence: z.number().min(0).max(1), summary: z.string(), filesChanged: z.array(z.string()), validationNotes: z.array(z.string()).default([]), riskNotes: z.array(z.string()), blockedReason: nullableString, missingInformation: z.array(z.string()), bugfixDetails: z.object({ rootCause: nullableString, reproduced: z.boolean(), regressionTestAdded: z.boolean() }).optional(), developmentDetails: z.object({ requirementsAddressed: z.array(z.string()), acceptanceCriteriaAddressed: z.array(z.string()), designNotes: z.array(z.string()) }).optional() }).superRefine((value, ctx) => { if (value.taskType === 'bugfix' && !value.bugfixDetails) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bugfixDetails'], message: 'bugfixDetails is required for bugfix tasks' }); if (value.taskType === 'development' && !value.developmentDetails) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['developmentDetails'], message: 'developmentDetails is required for development tasks' }); });
export type AgentTaskResult = z.infer<typeof AgentTaskResultSchema>;

/** Metadata for a non-authoritative patch that survived fixer failure/timeout. */
export const FixCandidateMetadataSchema = z.object({
  bugKey: z.string().regex(/^BUG-[0-9]{6,}$/),
  patchFile: z.literal('diff.patch'),
  patchSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  patchBytes: z.number().int().positive().max(10_000_000),
  baseCommit: z.string().regex(/^[a-f0-9]{7,64}$/i),
  reason: z.enum(['completion_format_failed', 'fixer_timeout', 'fixer_aborted', 'fixer_error']),
  createdAt: iso,
}).strict();
export type FixCandidateMetadata = z.infer<typeof FixCandidateMetadataSchema>;

export const ValidationResultSchema = z.object({ passed: z.boolean(), commands: z.array(z.string()), results: z.array(z.object({ command: z.string(), exitCode: z.number().int(), passed: z.boolean(), output: z.string() })), summary: z.string().default(''), artifacts: z.array(z.string()).default([]) });
export type ValidationResult = z.infer<typeof ValidationResultSchema>;
const ReviewAcceptanceCriterionSchema = z.object({ criterion: z.string(), met: z.boolean(), evidence: z.string() });
const ReviewResultBaseSchema = z.object({ verdict: z.enum(['approve', 'reject']), regressionRisk: z.enum(['low', 'medium', 'high']), summary: z.string(), findings: z.array(z.string()) });
export const ReviewResultSchema = ReviewResultBaseSchema.extend({ bugAddressed: z.boolean().optional(), taskAddressed: z.boolean().optional(), acceptanceCriteriaMet: z.array(ReviewAcceptanceCriterionSchema).optional() });
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
/** Task-specific review contracts make fields required at the boundary where
 * the orchestrator consumes them. The generic schema remains available for
 * compatibility with callers that handle both task types. */
export const BugReviewResultSchema = ReviewResultBaseSchema.extend({ bugAddressed: z.boolean() }).strict();
export const DevelopmentReviewResultSchema = ReviewResultBaseSchema.extend({ taskAddressed: z.boolean(), acceptanceCriteriaMet: z.array(ReviewAcceptanceCriterionSchema) }).strict();
export type BugReviewResult = z.infer<typeof BugReviewResultSchema>;
export type DevelopmentReviewResult = z.infer<typeof DevelopmentReviewResultSchema>;
export const GitResultSchema = z.object({ success: z.boolean(), branch: nullableString, commitSha: nullableString, mergeRequestUrl: nullableString, pushed: z.boolean(), error: nullableString });
export type GitResult = z.infer<typeof GitResultSchema>;

export const IntakeTurnResultSchema = z.object({ fieldUpdates: BugReportDraftSchema, observations: z.array(z.string()), reporterHypotheses: z.array(z.string()), contradictions: z.array(z.object({ field: z.string(), previousValue: z.unknown(), newValue: z.unknown() })), possibleSensitiveData: z.boolean(), executionTargetConfidence: z.number().min(0).max(1), questions: z.array(z.object({ field: z.string(), text: z.string(), importance: z.enum(['critical', 'high', 'medium', 'low']) })).max(3), readyForConfirmation: z.boolean() });
export type IntakeTurnResult = z.infer<typeof IntakeTurnResultSchema>;

// Lowercase aliases are convenient for callers that follow the usual Zod naming convention.
export const bugReportSchema = BugReportSchema;
export const bugStatusSchema = BugStatusSchema;
export const attachmentRefSchema = AttachmentRefSchema;
export const bugConversationSchema = BugConversationSchema;
export const conversationMessageSchema = ConversationMessageSchema;
export const completenessEvaluationSchema = CompletenessEvaluationSchema;
export const jobSchema = JobSchema;
export const agentRunSchema = AgentRunSchema;
export const jobRoutingRequirementsSchema = JobRoutingRequirementsSchema;
export const jobFailureClassSchema = JobFailureClassSchema;
export const bugFixTaskSchema = BugFixTaskSchema;
export const agentFixResultSchema = AgentFixResultSchema;
export const codingTaskSchema = CodingTaskSchema;
export const agentTaskResultSchema = AgentTaskResultSchema;
export const fixCandidateMetadataSchema = FixCandidateMetadataSchema;
export const validationResultSchema = ValidationResultSchema;
export const reviewResultSchema = ReviewResultSchema;
export const bugReviewResultSchema = BugReviewResultSchema;
export const developmentReviewResultSchema = DevelopmentReviewResultSchema;
export const gitResultSchema = GitResultSchema;
export const MessageSchema = ConversationMessageSchema;
export type Message = ConversationMessage;
export const ConversationSchema = BugConversationSchema;
export const CompletenessSchema = CompletenessEvaluationSchema;
export type Completeness = CompletenessEvaluation;
