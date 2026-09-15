import { AgentRunSchema, BugConversationSchema, BugReportDraftSchema, BugReportSchema, BugStatusSchema, ConversationMessageSchema, CompletenessEvaluationSchema, JobSchema, JobStatusSchema, AttachmentRefSchema, assertValidTransition, type AgentRun, type BugConversation, type BugReport, type ConversationMessage, type Job, type AttachmentRef, type BugStatus, type JobStatus, UserSchema, type User } from '@llmbugfix/bug-domain';
import { NotFoundError, newId, now, bugKey, sanitizeDiagnostic } from '@llmbugfix/shared';
import type { SqliteDatabase } from './database.js';

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
  enqueueJob(bugIdOrKey: string, options?: { priority?: number }): Job;
  claimNextJob(): Job | null;
  updateJob(id: string, patch: Partial<Pick<Job, 'status' | 'error' | 'heartbeatAt' | 'finishedAt'>>): Job;
  createAgentRun(input: Omit<AgentRun, 'id'> & Partial<Pick<AgentRun, 'id'>>): AgentRun;
  appendWorkerEvent(input: WorkerEventInput): WorkerEvent;
  listWorkerEvents(bugIdOrKey: string, query?: WorkerEventQuery): WorkerEvent[];
}

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
      // The reporter is a foreign key and must exist before the report is persisted.
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
      // Importing here would hide the state-machine contract from callers; use domain transition through dynamic value.
      const current = parseJson(row.report, BugReportSchema);
      assertValidTransition(row.status, status);
      const updatedAt = now();
      const report = { ...current, updatedAt };
      this.database.prepare('UPDATE bug_reports SET status = ?, report = ?, updated_at = ? WHERE id = ?').run(status, json(report), updatedAt, id);
      this.database.prepare('INSERT INTO bug_events (id, bug_id, from_status, to_status, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(newId(), id, row.status, status, eventType, json(payload), updatedAt);
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
  enqueueJob(bugIdOrKey: string, options: { priority?: number } = {}): Job { const bugId = this.bugId(bugIdOrKey); const value = JobSchema.parse({ id: newId(), bugId, status: 'QUEUED', priority: options.priority ?? 0, attempt: 0, createdAt: now(), startedAt: null, finishedAt: null, heartbeatAt: null, error: null }); this.database.prepare('INSERT INTO jobs (id, bug_id, status, priority, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(value.id, value.bugId, value.status, value.priority, value.attempt, value.createdAt); return value; }
  claimNextJob(): Job | null { const tx = this.database.transaction(() => { if (Number((this.database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'RUNNING'").get() as { count: number }).count) > 0) return null; const row = this.database.prepare("SELECT * FROM jobs WHERE status = 'QUEUED' ORDER BY priority ASC, created_at ASC LIMIT 1").get() as Record<string, unknown> | undefined; if (!row) return null; const startedAt = now(); const updated = this.database.prepare("UPDATE jobs SET status = 'RUNNING', attempt = attempt + 1, started_at = ?, heartbeat_at = ? WHERE id = ? AND status = 'QUEUED'").run(startedAt, startedAt, row.id); if (updated.changes !== 1) return null; return JobSchema.parse({ id: row.id, bugId: row.bug_id, status: 'RUNNING', priority: row.priority, attempt: Number(row.attempt) + 1, createdAt: row.created_at, startedAt, finishedAt: null, heartbeatAt: startedAt, error: null }); }); return tx(); }
  updateJob(id: string, patch: Partial<Pick<Job, 'status' | 'error' | 'heartbeatAt' | 'finishedAt'>>): Job { const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined; if (!row) throw new NotFoundError('Job', id); const status = patch.status ?? row.status; JobStatusSchema.parse(status); const error = patch.error === undefined ? row.error : patch.error; const heartbeat = patch.heartbeatAt === undefined ? row.heartbeat_at : patch.heartbeatAt; const finished = patch.finishedAt === undefined ? row.finished_at : patch.finishedAt; this.database.prepare('UPDATE jobs SET status = ?, error = ?, heartbeat_at = ?, finished_at = ? WHERE id = ?').run(status, error, heartbeat, finished, id); return JobSchema.parse({ id: row.id, bugId: row.bug_id, status, priority: row.priority, attempt: row.attempt, createdAt: row.created_at, startedAt: row.started_at, finishedAt: finished, heartbeatAt: heartbeat, error }); }
  createAgentRun(input: Omit<AgentRun, 'id'> & Partial<Pick<AgentRun, 'id'>>): AgentRun { const value = AgentRunSchema.parse({ ...input, id: input.id ?? newId() }); this.database.prepare('INSERT INTO agent_runs (id, bug_id, job_id, agent_type, status, session_id, started_at, finished_at, input, output, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(value.id, value.bugId, value.jobId, value.agentType, value.status, value.sessionId, value.startedAt, value.finishedAt, json(value.input), value.output === null ? null : json(value.output), value.error); return value; }
  appendWorkerEvent(input: WorkerEventInput): WorkerEvent {
    const bugId = this.bugId(input.bugId);
    const job = this.database.prepare('SELECT bug_id FROM jobs WHERE id = ?').get(input.jobId) as { bug_id?: string } | undefined;
    if (!job || job.bug_id !== bugId) throw new NotFoundError('Job', input.jobId);
    const role = sanitizeDiagnostic(input.role, 32);
    const eventType = sanitizeDiagnostic(input.eventType, 64);
    const tool = input.tool == null ? null : sanitizeDiagnostic(input.tool, 128);
    const summary = sanitizeDiagnostic(input.summary, 1024);
    const occurredAt = input.occurredAt ?? now();
    const value = this.database.transaction(() => {
      const current = this.database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM worker_events WHERE bug_id = ?').get(bugId) as { sequence: number };
      const sequence = Number(current.sequence) + 1;
      const id = newId();
      this.database.prepare('INSERT INTO worker_events (id, bug_id, job_id, sequence, occurred_at, role, event_type, tool, is_error, turn_index, tool_call_count, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, bugId, input.jobId, sequence, occurredAt, role, eventType, tool, input.isError ? 1 : 0, input.turnIndex ?? null, input.toolCallCount ?? null, summary);
      // Keep each job bounded. The bug-wide sequence remains monotonic, so
      // clients can safely poll across retries while old rows are reclaimed.
      this.database.prepare('DELETE FROM worker_events WHERE job_id = ? AND sequence NOT IN (SELECT sequence FROM worker_events WHERE job_id = ? ORDER BY sequence DESC LIMIT 1000)').run(input.jobId, input.jobId);
      return { id, bugId, jobId: input.jobId, sequence, occurredAt, role, eventType, tool, isError: Boolean(input.isError), turnIndex: input.turnIndex ?? null, toolCallCount: input.toolCallCount ?? null, summary };
    })();
    return value;
  }
  listWorkerEvents(bugIdOrKey: string, query: WorkerEventQuery = {}): WorkerEvent[] {
    const bugId = this.bugId(bugIdOrKey);
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer between 1 and 100');
    if (query.after !== undefined && query.before !== undefined) throw new Error('after and before cannot be used together');
    const cursor = query.before ?? query.after ?? 0;
    const before = query.before !== undefined;
    const rows = this.database.prepare(`SELECT * FROM worker_events WHERE bug_id = ? AND sequence ${before ? '<' : '>'} ? ORDER BY sequence ${before ? 'DESC' : 'ASC'} LIMIT ?`).all(bugId, cursor, limit) as Record<string, unknown>[];
    if (before) rows.reverse();
    return rows.map((row) => ({ id: String(row.id), bugId: String(row.bug_id), jobId: String(row.job_id), sequence: Number(row.sequence), occurredAt: String(row.occurred_at), role: String(row.role), eventType: String(row.event_type), tool: row.tool == null ? null : String(row.tool), isError: Boolean(row.is_error), turnIndex: row.turn_index == null ? null : Number(row.turn_index), toolCallCount: row.tool_call_count == null ? null : Number(row.tool_call_count), summary: String(row.summary) }));
  }
}
