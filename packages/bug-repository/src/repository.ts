import {
  AgentRunSchema,
  BugConversationSchema,
  BugReportDraftSchema,
  BugReportSchema,
  BugStatusSchema,
  ConversationMessageSchema,
  CompletenessEvaluationSchema,
  JobSchema,
  JobStatusSchema,
  AttachmentRefSchema,
  assertValidTransition,
  UserSchema,
  type AgentRun,
  type BugConversation,
  type BugReport,
  type ConversationMessage,
  type Job,
  type AttachmentRef,
  type BugStatus,
  type User,
} from '@llmbugfix/bug-domain';
import type { ExternalTaskCreateRequest, ExternalTaskSubmission, RoutingRequirements } from '@llmbugfix/api-contract';
import { NotFoundError, newId, now, bugKey, sanitizeDiagnostic } from '@llmbugfix/shared';
import type { SqliteDatabase } from './database.js';
import { createHash } from 'node:crypto';

const json = (value: unknown): string => JSON.stringify(value);
const parseJson = <T>(value: unknown, parser: { parse: (value: unknown) => T }): T => parser.parse(typeof value === 'string' ? JSON.parse(value) : value);
type UserInput = Omit<User, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<User, 'id' | 'createdAt' | 'updatedAt'>>;
type DefaultedTaskFields = 'taskType' | 'objective' | 'requirements' | 'acceptanceCriteria' | 'nonGoals' | 'constraints' | 'referenceContext';
type BugInput = Omit<BugReport, 'id' | 'bugKey' | 'createdAt' | 'updatedAt' | DefaultedTaskFields> & Partial<Pick<BugReport, 'id' | 'bugKey' | 'createdAt' | 'updatedAt' | DefaultedTaskFields>>;

export type WorkerEventInput = {
  bugId: string;
  jobId: string;
  role: string;
  eventType: string;
  tool?: string | null;
  isError?: boolean;
  turnIndex?: number | null;
  toolCallCount?: number | null;
  summary: string;
  occurredAt?: string;
};
export type WorkerEvent = WorkerEventInput & { id: string; sequence: number; occurredAt: string; tool: string | null; isError: boolean; turnIndex: number | null; toolCallCount: number | null };
export type WorkerEventQuery = { after?: number; before?: number; limit?: number };

export type TaskRepositoryStatus = 'PENDING' | 'CLONING' | 'READY' | 'FAILED';
export interface TaskRepositoryRecord {
  id: string;
  bugId: string;
  cloneUrl: string;
  baseBranch: string;
  executionTarget: 'frontend' | 'backend';
  checkoutId: string | null;
  profileId: string | null;
  status: TaskRepositoryStatus;
  repositoryPath: string | null;
  attempt: number;
  errorCode: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TaskEventRecord = {
  eventId: string;
  sequence: number;
  taskId: string;
  jobId: string | null;
  type: string;
  status: string;
  stage: string;
  occurredAt: string;
  data: Record<string, unknown>;
};
export type TaskEventQuery = { after?: number; limit?: number };

export interface ExternalTaskCreationInput {
  request: ExternalTaskCreateRequest;
  idempotencyKey: string;
  scope?: string;
}
export interface ExternalTaskSubmissionRecord extends ExternalTaskSubmission {
  jobId: string;
}
export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor(readonly scope: string, readonly idempotencyKey: string) {
    super('The Idempotency-Key was already used with a different request body');
    this.name = 'IdempotencyConflictError';
  }
}

export interface BugRepository {
  createUser(input: UserInput): User;
  getUser(id: string): User | null;
  createBug(input: BugInput | BugReport): BugReport;
  getBug(idOrKey: string): BugReport | null;
  listBugs(): BugReport[];
  changeBugStatus(idOrKey: string, status: BugStatus, eventType?: string, payload?: unknown): BugReport;
  createConversation(input: Omit<BugConversation, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<BugConversation, 'id' | 'createdAt' | 'updatedAt'>>): BugConversation;
  getConversation(id: string): BugConversation | null;
  updateConversation(id: string, patch: Partial<Pick<BugConversation, 'status' | 'draft' | 'completeness'>>): BugConversation;
  appendMessage(input: Omit<ConversationMessage, 'id' | 'createdAt'> & Partial<Pick<ConversationMessage, 'id' | 'createdAt'>>): ConversationMessage;
  listMessages(conversationId: string): ConversationMessage[];
  addAttachment(bugIdOrKey: string, attachment: AttachmentRef): AttachmentRef;
  listAttachments(bugIdOrKey: string): AttachmentRef[];
  enqueueJob(bugIdOrKey: string, options?: { priority?: number; routingRequirements?: RoutingRequirements }): Job;
  claimNextJob(): Job | null;
  updateJob(id: string, patch: Partial<Pick<Job, 'status' | 'error' | 'heartbeatAt' | 'finishedAt'>>): Job;
  createAgentRun(input: Omit<AgentRun, 'id'> & Partial<Pick<AgentRun, 'id'>>): AgentRun;
  appendWorkerEvent(input: WorkerEventInput): WorkerEvent;
  listWorkerEvents(bugIdOrKey: string, query?: WorkerEventQuery): WorkerEvent[];
  createExternalTask(input: ExternalTaskCreationInput | ExternalTaskCreateRequest, idempotencyKey?: string, scope?: string): ExternalTaskSubmissionRecord;
  getTaskRepository(bugIdOrKey: string): TaskRepositoryRecord | null;
  updateTaskRepository(id: string, patch: Partial<Omit<TaskRepositoryRecord, 'id' | 'bugId' | 'createdAt' | 'updatedAt'>>): TaskRepositoryRecord;
  appendTaskEvent(bugIdOrKey: string, input: Omit<TaskEventRecord, 'eventId' | 'sequence' | 'taskId' | 'jobId' | 'occurredAt'> & Partial<Pick<TaskEventRecord, 'jobId' | 'occurredAt'>>): TaskEventRecord;
  listTaskEvents(bugIdOrKey: string, query?: TaskEventQuery): TaskEventRecord[];
  listJobsForBug(bugIdOrKey: string): Job[];
}

const EXTERNAL_SYSTEM_USER_ID = '00000000-0000-4000-8000-000000000001';
const EXTERNAL_SYSTEM_EMAIL = 'external-api@system.invalid';
const EXTERNAL_SCOPE = 'external-api:v1';
// The public API caps pages at 100, but asks the repository for one extra row
// to calculate hasMore without a second query.
const TASK_EVENT_LOOKAHEAD_LIMIT = 101;

/** Stable JSON is used for idempotency so object property order does not
 * accidentally turn a semantically identical request into a new task. */
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};

// Node's built-in crypto is synchronous and safe to use while a transaction is
// open.
const requestHash = (value: unknown): string => createHash('sha256').update(stableJson(value)).digest('hex');

const priorityValue = (priority: 'high' | 'normal' | 'low'): number => ({ high: 0, normal: 10, low: 20 })[priority];

const publicState = (status: string): { status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; stage: string } => {
  if (status === 'CANCELLED') return { status: 'cancelled', stage: 'cancelled' };
  if (status === 'FIX_READY') return { status: 'succeeded', stage: 'ready' };
  if (status === 'READY_FOR_HUMAN_REVIEW') return { status: 'succeeded', stage: 'human_review' };
  if (['FIX_FAILED', 'FIX_CANDIDATE', 'ENVIRONMENT_FAILED', 'VALIDATION_FAILED', 'REVIEW_REJECTED', 'PUSH_FAILED', 'BLOCKED', 'REJECTED'].includes(status)) return { status: 'failed', stage: 'failed' };
  if (status === 'PREPARING_ENV') return { status: 'running', stage: 'preparing_environment' };
  if (status === 'FIXING') return { status: 'running', stage: 'fixing' };
  if (status === 'VALIDATING') return { status: 'running', stage: 'validating' };
  if (status === 'REVIEWING') return { status: 'running', stage: 'reviewing' };
  if (status === 'PUSHING') return { status: 'running', stage: 'pushing' };
  return status === 'QUEUED' || status === 'DRAFT' || status === 'SUBMITTED' || status === 'TRIAGING' ? { status: 'queued', stage: 'queued' } : { status: 'running', stage: 'queued' };
};

const mapJob = (row: Record<string, unknown>): Job => JobSchema.parse({
  id: row.id,
  bugId: row.bug_id,
  status: row.status,
  priority: Number(row.priority),
  attempt: Number(row.attempt),
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  heartbeatAt: row.heartbeat_at,
  error: row.error,
  workerId: row.worker_id ?? null,
  leaseToken: row.lease_token ?? null,
  leaseExpiresAt: row.lease_expires_at ?? null,
  claimedAt: row.claimed_at ?? null,
  routingRequirements: row.routing_requirements == null ? null : parseJson(row.routing_requirements, { parse: (value) => value as RoutingRequirements }),
  failureClass: row.failure_class ?? null,
  lastFailureBackendId: row.last_failure_backend_id ?? null,
});

const mapTaskRepository = (row: Record<string, unknown>): TaskRepositoryRecord => ({
  id: String(row.id), bugId: String(row.bug_id), cloneUrl: String(row.clone_url), baseBranch: String(row.base_branch), executionTarget: String(row.execution_target) as 'frontend' | 'backend', checkoutId: row.checkout_id == null ? null : String(row.checkout_id), profileId: row.profile_id == null ? null : String(row.profile_id), status: String(row.status) as TaskRepositoryStatus, repositoryPath: row.repository_path == null ? null : String(row.repository_path), attempt: Number(row.attempt), errorCode: row.error_code == null ? null : String(row.error_code), error: row.error == null ? null : String(row.error), startedAt: row.started_at == null ? null : String(row.started_at), finishedAt: row.finished_at == null ? null : String(row.finished_at), heartbeatAt: row.heartbeat_at == null ? null : String(row.heartbeat_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
});

export class SQLiteBugRepository implements BugRepository {
  constructor(readonly database: SqliteDatabase) {}

  createUser(input: UserInput): User {
    const value = UserSchema.parse({ ...input, id: input.id ?? newId(), createdAt: input.createdAt ?? now(), updatedAt: input.updatedAt ?? now() });
    this.database.prepare('INSERT INTO users (id, display_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(value.id, value.displayName, value.email, value.createdAt, value.updatedAt);
    return value;
  }
  getUser(id: string): User | null {
    const row = this.database.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? UserSchema.parse({ id: row.id, displayName: row.display_name, email: row.email, createdAt: row.created_at, updatedAt: row.updated_at }) : null;
  }
  private bugId(idOrKey: string): string {
    const row = this.database.prepare('SELECT id FROM bug_reports WHERE id = ? OR bug_key = ?').get(idOrKey, idOrKey) as { id: string } | undefined;
    if (!row) throw new NotFoundError('BugReport', idOrKey);
    return row.id;
  }
  private nextBugKey(): string {
    const row = this.database.prepare('SELECT next_value AS next FROM bug_key_sequence WHERE id = 1').get() as { next: number };
    this.database.prepare('UPDATE bug_key_sequence SET next_value = next_value + 1 WHERE id = 1').run();
    return bugKey(row.next);
  }
  createBug(input: BugInput | BugReport): BugReport {
    const body = () => {
      const value = BugReportSchema.parse({ ...input, id: input.id ?? newId(), bugKey: input.bugKey ?? this.nextBugKey(), createdAt: input.createdAt ?? now(), updatedAt: input.updatedAt ?? now() });
      if (!this.getUser(value.reporter.userId)) throw new NotFoundError('User', value.reporter.userId);
      this.database.prepare('INSERT INTO bug_reports (id, bug_key, task_type, reporter_id, conversation_id, status, report, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(value.id, value.bugKey, value.taskType, value.reporter.userId, value.intake.conversationId, 'DRAFT', json(value), value.createdAt, value.updatedAt);
      return value;
    };
    return this.database.transaction(body)();
  }
  getBug(idOrKey: string): BugReport | null {
    const row = this.database.prepare('SELECT report FROM bug_reports WHERE id = ? OR bug_key = ?').get(idOrKey, idOrKey) as { report: string } | undefined;
    return row ? parseJson(row.report, BugReportSchema) : null;
  }
  listBugs(): BugReport[] { return (this.database.prepare('SELECT report FROM bug_reports ORDER BY created_at ASC').all() as { report: string }[]).map((r) => parseJson(r.report, BugReportSchema)); }

  changeBugStatus(idOrKey: string, status: BugStatus, eventType = 'status_changed', payload: unknown = {}): BugReport {
    const result = this.database.transaction(() => {
      const id = this.bugId(idOrKey);
      const row = this.database.prepare('SELECT status, report FROM bug_reports WHERE id = ?').get(id) as { status: BugStatus; report: string };
      BugStatusSchema.parse(status);
      const current = parseJson(row.report, BugReportSchema);
      assertValidTransition(row.status, status);
      const updatedAt = now();
      const report = { ...current, updatedAt };
      this.database.prepare('UPDATE bug_reports SET status = ?, report = ?, updated_at = ? WHERE id = ?').run(status, json(report), updatedAt, id);
      this.database.prepare('INSERT INTO bug_events (id, bug_id, from_status, to_status, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(newId(), id, row.status, status, eventType, json(payload), updatedAt);
      const state = publicState(status);
      const eventTypePublic = status === 'CANCELLED' ? 'task.cancelled' : status === 'FIX_READY' || status === 'READY_FOR_HUMAN_REVIEW' ? 'task.completed' : /retry/i.test(eventType) ? 'task.retry_requested' : status === 'FIX_FAILED' || state.status === 'failed' ? 'task.failed' : 'task.stage_changed';
      this.insertTaskEvent(id, null, eventTypePublic, state.status, state.stage, payload, updatedAt);
      return report;
    });
    return result();
  }
  createConversation(input: Omit<BugConversation, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<BugConversation, 'id' | 'createdAt' | 'updatedAt'>>): BugConversation {
    const value = BugConversationSchema.parse({ ...input, id: input.id ?? newId(), createdAt: input.createdAt ?? now(), updatedAt: input.updatedAt ?? now() });
    this.database.prepare('INSERT INTO bug_conversations (id, reporter_id, status, draft, completeness, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(value.id, value.reporterId, value.status, json(value.draft), json(value.completeness), value.createdAt, value.updatedAt);
    return value;
  }
  getConversation(id: string): BugConversation | null {
    const row = this.database.prepare('SELECT * FROM bug_conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? BugConversationSchema.parse({ id: row.id, reporterId: row.reporter_id, status: row.status, draft: parseJson(row.draft, BugReportDraftSchema), completeness: parseJson(row.completeness, CompletenessEvaluationSchema), createdAt: row.created_at, updatedAt: row.updated_at }) : null;
  }
  updateConversation(id: string, patch: Partial<Pick<BugConversation, 'status' | 'draft' | 'completeness'>>): BugConversation {
    const row = this.database.prepare('SELECT * FROM bug_conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError('BugConversation', id);
    const status = patch.status ?? (row.status as BugConversation['status']);
    const draft = patch.draft ?? parseJson(row.draft, BugReportDraftSchema);
    const completeness = patch.completeness ?? parseJson(row.completeness, CompletenessEvaluationSchema);
    const updatedAt = now();
    this.database.prepare('UPDATE bug_conversations SET status = ?, draft = ?, completeness = ?, updated_at = ? WHERE id = ?').run(status, json(draft), json(completeness), updatedAt, id);
    return BugConversationSchema.parse({ id: row.id, reporterId: row.reporter_id, status, draft, completeness, createdAt: row.created_at, updatedAt });
  }
  appendMessage(input: Omit<ConversationMessage, 'id' | 'createdAt'> & Partial<Pick<ConversationMessage, 'id' | 'createdAt'>>): ConversationMessage {
    const value = ConversationMessageSchema.parse({ ...input, id: input.id ?? newId(), createdAt: input.createdAt ?? now() });
    this.database.prepare('INSERT INTO conversation_messages (id, conversation_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(value.id, value.conversationId, value.role, value.content, json(value.metadata), value.createdAt);
    return value;
  }
  listMessages(conversationId: string): ConversationMessage[] { return (this.database.prepare('SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId) as Record<string, unknown>[]).map((r) => ConversationMessageSchema.parse({ id: r.id, conversationId: r.conversation_id, role: r.role, content: r.content, metadata: parseJson(r.metadata, { parse: (v) => v }), createdAt: r.created_at })); }
  addAttachment(bugIdOrKey: string, attachment: AttachmentRef): AttachmentRef { const id = this.bugId(bugIdOrKey); const value = AttachmentRefSchema.parse(attachment); const time = now(); this.database.prepare('INSERT INTO bug_attachments (id, bug_id, attachment, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(value.id, id, json(value), time, time); return value; }
  listAttachments(bugIdOrKey: string): AttachmentRef[] { const id = this.bugId(bugIdOrKey); return (this.database.prepare('SELECT attachment FROM bug_attachments WHERE bug_id = ? ORDER BY created_at').all(id) as { attachment: string }[]).map((r) => parseJson(r.attachment, AttachmentRefSchema)); }

  enqueueJob(bugIdOrKey: string, options: { priority?: number; routingRequirements?: RoutingRequirements } = {}): Job {
    const bugId = this.bugId(bugIdOrKey);
    const active = this.database.prepare("SELECT * FROM jobs WHERE bug_id = ? AND status IN ('QUEUED', 'RUNNING') ORDER BY created_at ASC LIMIT 1").get(bugId) as Record<string, unknown> | undefined;
    if (active) return mapJob(active);
    const value = JobSchema.parse({ id: newId(), bugId, status: 'QUEUED', priority: options.priority ?? 0, attempt: 0, createdAt: now(), startedAt: null, finishedAt: null, heartbeatAt: null, error: null, workerId: null, leaseToken: null, leaseExpiresAt: null, claimedAt: null, routingRequirements: options.routingRequirements ?? null, failureClass: null, lastFailureBackendId: null });
    this.database.prepare('INSERT INTO jobs (id, bug_id, status, priority, attempt, created_at, routing_requirements) VALUES (?, ?, ?, ?, ?, ?, ?)').run(value.id, value.bugId, value.status, value.priority, value.attempt, value.createdAt, value.routingRequirements == null ? null : json(value.routingRequirements));
    return value;
  }
  claimNextJob(): Job | null {
    const tx = this.database.transaction(() => {
      const row = this.database.prepare("SELECT * FROM jobs WHERE status = 'QUEUED' ORDER BY priority ASC, created_at ASC LIMIT 1").get() as Record<string, unknown> | undefined;
      if (!row) return null;
      const startedAt = now();
      const leaseToken = newId();
      const leaseExpiresAt = new Date(Date.now() + 300_000).toISOString();
      const updated = this.database.prepare("UPDATE jobs SET status = 'RUNNING', attempt = attempt + 1, started_at = ?, claimed_at = ?, heartbeat_at = ?, worker_id = ?, lease_token = ?, lease_expires_at = ? WHERE id = ? AND status = 'QUEUED'").run(startedAt, startedAt, startedAt, 'legacy-repository-worker', leaseToken, leaseExpiresAt, row.id);
      if (updated.changes !== 1) return null;
      return mapJob({ ...row, status: 'RUNNING', attempt: Number(row.attempt) + 1, started_at: startedAt, claimed_at: startedAt, heartbeat_at: startedAt, worker_id: 'legacy-repository-worker', lease_token: leaseToken, lease_expires_at: leaseExpiresAt, error: null });
    });
    return tx();
  }
  updateJob(id: string, patch: Partial<Pick<Job, 'status' | 'error' | 'heartbeatAt' | 'finishedAt'>>): Job {
    const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError('Job', id);
    const status = patch.status ?? row.status; JobStatusSchema.parse(status);
    const error = patch.error === undefined ? row.error : patch.error;
    const heartbeat = patch.heartbeatAt === undefined ? row.heartbeat_at : patch.heartbeatAt;
    const finished = patch.finishedAt === undefined ? row.finished_at : patch.finishedAt;
    this.database.prepare('UPDATE jobs SET status = ?, error = ?, heartbeat_at = ?, finished_at = ?, worker_id = CASE WHEN ? IN (\'COMPLETED\', \'FAILED\', \'CANCELLED\', \'INTERRUPTED\') THEN NULL ELSE worker_id END, lease_token = CASE WHEN ? IN (\'COMPLETED\', \'FAILED\', \'CANCELLED\', \'INTERRUPTED\') THEN NULL ELSE lease_token END, lease_expires_at = CASE WHEN ? IN (\'COMPLETED\', \'FAILED\', \'CANCELLED\', \'INTERRUPTED\') THEN NULL ELSE lease_expires_at END WHERE id = ?').run(status, error, heartbeat, finished, status, status, status, id);
    return mapJob({ ...row, status, error, heartbeat_at: heartbeat, finished_at: finished, worker_id: ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(String(status)) ? null : row.worker_id, lease_token: ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(String(status)) ? null : row.lease_token, lease_expires_at: ['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(String(status)) ? null : row.lease_expires_at });
  }
  createAgentRun(input: Omit<AgentRun, 'id'> & Partial<Pick<AgentRun, 'id'>>): AgentRun {
    const value = AgentRunSchema.parse({ ...input, id: input.id ?? newId() });
    this.database.prepare('INSERT INTO agent_runs (id, bug_id, job_id, agent_type, status, session_id, started_at, finished_at, input, output, error, backend_id, model, role_attempt, failure_class, lease_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(value.id, value.bugId, value.jobId, value.agentType, value.status, value.sessionId, value.startedAt, value.finishedAt, json(value.input), value.output === null ? null : json(value.output), value.error, value.backendId ?? null, value.model ?? null, value.roleAttempt ?? null, value.failureClass ?? null, value.leaseToken ?? null);
    return value;
  }
  appendWorkerEvent(input: WorkerEventInput): WorkerEvent {
    const bugId = this.bugId(input.bugId);
    const job = this.database.prepare('SELECT bug_id FROM jobs WHERE id = ?').get(input.jobId) as { bug_id?: string } | undefined;
    if (!job || job.bug_id !== bugId) throw new NotFoundError('Job', input.jobId);
    const role = sanitizeDiagnostic(input.role, 32); const eventType = sanitizeDiagnostic(input.eventType, 64); const tool = input.tool == null ? null : sanitizeDiagnostic(input.tool, 128); const summary = sanitizeDiagnostic(input.summary, 1024); const occurredAt = input.occurredAt ?? now();
    return this.database.transaction(() => {
      const current = this.database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM worker_events WHERE bug_id = ?').get(bugId) as { sequence: number };
      const sequence = Number(current.sequence) + 1; const id = newId();
      this.database.prepare('INSERT INTO worker_events (id, bug_id, job_id, sequence, occurred_at, role, event_type, tool, is_error, turn_index, tool_call_count, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, bugId, input.jobId, sequence, occurredAt, role, eventType, tool, input.isError ? 1 : 0, input.turnIndex ?? null, input.toolCallCount ?? null, summary);
      this.database.prepare('DELETE FROM worker_events WHERE job_id = ? AND sequence NOT IN (SELECT sequence FROM worker_events WHERE job_id = ? ORDER BY sequence DESC LIMIT 1000)').run(input.jobId, input.jobId);
      return { id, bugId, jobId: input.jobId, sequence, occurredAt, role, eventType, tool, isError: Boolean(input.isError), turnIndex: input.turnIndex ?? null, toolCallCount: input.toolCallCount ?? null, summary };
    })();
  }
  listWorkerEvents(bugIdOrKey: string, query: WorkerEventQuery = {}): WorkerEvent[] {
    const bugId = this.bugId(bugIdOrKey); const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer between 1 and 100');
    if (query.after !== undefined && query.before !== undefined) throw new Error('after and before cannot be used together');
    const cursor = query.before ?? query.after ?? 0; const before = query.before !== undefined;
    const rows = this.database.prepare(`SELECT * FROM worker_events WHERE bug_id = ? AND sequence ${before ? '<' : '>'} ? ORDER BY sequence ${before ? 'DESC' : 'ASC'} LIMIT ?`).all(bugId, cursor, limit) as Record<string, unknown>[];
    if (before) rows.reverse();
    return rows.map((row) => ({ id: String(row.id), bugId: String(row.bug_id), jobId: String(row.job_id), sequence: Number(row.sequence), occurredAt: String(row.occurred_at), role: String(row.role), eventType: String(row.event_type), tool: row.tool == null ? null : String(row.tool), isError: Boolean(row.is_error), turnIndex: row.turn_index == null ? null : Number(row.turn_index), toolCallCount: row.tool_call_count == null ? null : Number(row.tool_call_count), summary: String(row.summary) }));
  }

  private insertTaskEvent(bugId: string, jobId: string | null, type: string, status: string, stage: string, data: unknown, occurredAt = now()): TaskEventRecord {
    const current = this.database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM task_events WHERE bug_id = ?').get(bugId) as { sequence: number };
    const value: TaskEventRecord = { eventId: newId(), sequence: Number(current.sequence) + 1, taskId: bugId, jobId, type, status, stage, occurredAt, data: (data && typeof data === 'object' ? data : {}) as Record<string, unknown> };
    this.database.prepare('INSERT INTO task_events (id, bug_id, job_id, sequence, type, status, stage, occurred_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(value.eventId, value.taskId, value.jobId, value.sequence, value.type, value.status, value.stage, value.occurredAt, json(value.data));
    return value;
  }
  appendTaskEvent(bugIdOrKey: string, input: Omit<TaskEventRecord, 'eventId' | 'sequence' | 'taskId' | 'jobId' | 'occurredAt'> & Partial<Pick<TaskEventRecord, 'jobId' | 'occurredAt'>>): TaskEventRecord {
    return this.database.transaction(() => this.insertTaskEvent(this.bugId(bugIdOrKey), input.jobId ?? null, input.type, input.status, input.stage, input.data, input.occurredAt ?? now()))();
  }
  listTaskEvents(bugIdOrKey: string, query: TaskEventQuery = {}): TaskEventRecord[] {
    const bugId = this.bugId(bugIdOrKey); const after = query.after ?? 0; const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > TASK_EVENT_LOOKAHEAD_LIMIT) throw new Error('invalid task event cursor or limit');
    return (this.database.prepare('SELECT * FROM task_events WHERE bug_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?').all(bugId, after, limit) as Record<string, unknown>[]).map((row) => ({ eventId: String(row.id), sequence: Number(row.sequence), taskId: String(row.bug_id), jobId: row.job_id == null ? null : String(row.job_id), type: String(row.type), status: String(row.status), stage: String(row.stage), occurredAt: String(row.occurred_at), data: parseJson(row.data, { parse: (value) => (value && typeof value === 'object' ? value as Record<string, unknown> : {}) }) }));
  }
  getTaskRepository(bugIdOrKey: string): TaskRepositoryRecord | null {
    const bugId = this.bugId(bugIdOrKey); const row = this.database.prepare('SELECT * FROM task_repositories WHERE bug_id = ?').get(bugId) as Record<string, unknown> | undefined; return row ? mapTaskRepository(row) : null;
  }
  updateTaskRepository(id: string, patch: Partial<Omit<TaskRepositoryRecord, 'id' | 'bugId' | 'createdAt' | 'updatedAt'>>): TaskRepositoryRecord {
    const row = this.database.prepare('SELECT * FROM task_repositories WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError('TaskRepository', id);
    const next = { ...mapTaskRepository(row), ...patch, updatedAt: now() };
    this.database.prepare('UPDATE task_repositories SET clone_url = ?, base_branch = ?, execution_target = ?, checkout_id = ?, profile_id = ?, status = ?, repository_path = ?, attempt = ?, error_code = ?, error = ?, started_at = ?, finished_at = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?').run(next.cloneUrl, next.baseBranch, next.executionTarget, next.checkoutId, next.profileId, next.status, next.repositoryPath, next.attempt, next.errorCode, next.error, next.startedAt, next.finishedAt, next.heartbeatAt, next.updatedAt, id);
    return next;
  }

  /** Creates all externally-owned records under one SQLite transaction. */
  createExternalTask(input: ExternalTaskCreationInput | ExternalTaskCreateRequest, suppliedKey?: string, suppliedScope = EXTERNAL_SCOPE): ExternalTaskSubmissionRecord {
    const request = 'request' in input ? input.request : input;
    const idempotencyKey = 'request' in input ? input.idempotencyKey : suppliedKey;
    const scope = 'request' in input ? input.scope ?? EXTERNAL_SCOPE : suppliedScope;
    if (!idempotencyKey) throw new Error('Idempotency-Key is required');
    const hash = requestHash(request);
    return this.database.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?').get(scope, idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) {
        if (String(existing.request_hash) !== hash) throw new IdempotencyConflictError(scope, idempotencyKey);
        const bug = this.getBug(String(existing.bug_id)); const job = this.database.prepare('SELECT id FROM jobs WHERE id = ?').get(existing.job_id) as { id: string } | undefined;
        if (!bug || !job) throw new Error('Idempotency record references missing task');
        const bugRow = this.database.prepare('SELECT status FROM bug_reports WHERE id = ?').get(bug.id) as { status?: string } | undefined;
        const state = publicState(bugRow?.status ?? 'QUEUED');
        return this.taskResource(bug, job.id, true, state);
      }

      const createdAt = now();
      const system = this.database.prepare('SELECT * FROM users WHERE id = ?').get(EXTERNAL_SYSTEM_USER_ID) as Record<string, unknown> | undefined;
      if (!system) this.database.prepare('INSERT INTO users (id, display_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(EXTERNAL_SYSTEM_USER_ID, 'External API', EXTERNAL_SYSTEM_EMAIL, createdAt, createdAt);
      const user = this.getUser(EXTERNAL_SYSTEM_USER_ID)!;
      const conversationId = newId();
      const completeness = { score: 100, dimensions: { problem: 25, reproduction: 30, environment: 15, evidence: 20, impact: 10 }, missingCriticalInformation: [], recommendedQuestions: [], readyForSubmission: true };
      this.database.prepare('INSERT INTO bug_conversations (id, reporter_id, status, draft, completeness, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(conversationId, user.id, 'submitted', json(request), json(completeness), createdAt, createdAt);
      const id = newId(); const key = this.nextBugKey();
      const externalEnvironment = request.taskType === 'bugfix' ? request.environment ?? {} : {};
      const environment = Object.fromEntries(Object.entries(externalEnvironment).map(([name, value]) => [name, typeof value === 'string' ? value : JSON.stringify(value) ?? 'null']));
      const report = BugReportSchema.parse({ id, bugKey: key, taskType: request.taskType, title: request.title, productArea: null, component: null, bugType: 'functional', executionTarget: request.executionTarget, environmentProfileId: null, severity: 'unknown', actualBehavior: request.taskType === 'bugfix' ? request.actualBehavior : '', expectedBehavior: request.taskType === 'bugfix' ? request.expectedBehavior : null, objective: request.taskType === 'development' ? request.objective : null, requirements: request.taskType === 'development' ? request.requirements : [], acceptanceCriteria: request.taskType === 'development' ? request.acceptanceCriteria : [], nonGoals: request.taskType === 'development' ? request.nonGoals ?? [] : [], constraints: request.taskType === 'development' ? request.constraints ?? [] : [], referenceContext: [], reproduction: { reproducible: null, frequency: 'unknown', prerequisites: [], steps: request.taskType === 'bugfix' ? request.reproductionSteps : [], testData: [] }, environment: { environmentName: null, appVersion: null, buildNumber: null, commitSha: null, additionalInfo: environment }, evidence: { errorMessages: request.taskType === 'bugfix' ? request.errorMessages ?? [] : [], stackTraces: request.taskType === 'bugfix' ? request.stackTraces ?? [] : [], logs: [], screenshots: [], videos: [], networkTraces: [], jsonFiles: [], otherFiles: [] }, impact: { affectedUsers: null, scope: 'unknown', blocksTesting: null, workaroundExists: null, workaround: null }, regression: { isRegression: null, lastKnownGoodVersion: null, suspectedVersion: null }, observations: [], reporterHypotheses: [], reporter: { userId: user.id, displayName: user.displayName }, intake: { completenessScore: 100, confidence: 1, missingInformation: [], conversationId, llmSummary: request.taskType === 'bugfix' ? request.actualBehavior : request.objective }, createdAt, updatedAt: createdAt });
      this.database.prepare('INSERT INTO bug_reports (id, bug_key, task_type, reporter_id, conversation_id, status, report, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, key, request.taskType, user.id, conversationId, 'QUEUED', json(report), createdAt, createdAt);
      this.database.prepare('INSERT INTO bug_events (id, bug_id, from_status, to_status, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(newId(), id, null, 'QUEUED', 'task.created', json({ taskType: request.taskType }), createdAt);
      const requirements: RoutingRequirements = request.routing ?? { priority: 'normal', capabilityHints: [], quality: 'standard' };
      const jobId = newId();
      this.database.prepare('INSERT INTO jobs (id, bug_id, status, priority, attempt, created_at, routing_requirements) VALUES (?, ?, ?, ?, ?, ?, ?)').run(jobId, id, 'QUEUED', priorityValue(requirements.priority), 0, createdAt, json(requirements));
      const taskRepositoryId = newId();
      this.database.prepare('INSERT INTO task_repositories (id, bug_id, clone_url, base_branch, execution_target, status, attempt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(taskRepositoryId, id, request.repository.cloneUrl, request.repository.baseBranch, request.executionTarget, 'PENDING', 0, createdAt, createdAt);
      this.insertTaskEvent(id, jobId, 'task.created', 'queued', 'queued', { taskType: request.taskType }, createdAt);
      this.insertTaskEvent(id, jobId, 'task.queued', 'queued', 'queued', {}, createdAt);
      this.database.prepare('INSERT INTO idempotency_keys (scope, idempotency_key, request_hash, bug_id, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(scope, idempotencyKey, hash, id, jobId, createdAt);
      return this.taskResource(report, jobId, false, { status: 'queued', stage: 'queued' });
    })();
  }

  private taskResource(bug: BugReport, jobId: string, idempotent: boolean, state = publicState(((this.database.prepare('SELECT status FROM bug_reports WHERE id = ?').get(bug.id) as { status?: string } | undefined)?.status) ?? 'QUEUED')): ExternalTaskSubmissionRecord {
    return { taskId: bug.id, taskKey: bug.bugKey, taskType: bug.taskType, title: bug.title, executionTarget: bug.executionTarget as 'frontend' | 'backend', status: state.status, stage: state.stage as ExternalTaskSubmissionRecord['stage'], createdAt: bug.createdAt, updatedAt: bug.updatedAt, links: { self: `/api/v1/tasks/${bug.id}`, events: `/api/v1/tasks/${bug.id}/events`, result: `/api/v1/tasks/${bug.id}/result` }, idempotent, jobId };
  }
  listJobsForBug(bugIdOrKey: string): Job[] { const bugId = this.bugId(bugIdOrKey); return (this.database.prepare('SELECT * FROM jobs WHERE bug_id = ? ORDER BY created_at ASC').all(bugId) as Record<string, unknown>[]).map(mapJob); }
}
