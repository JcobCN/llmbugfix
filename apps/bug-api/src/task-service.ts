import fs from 'node:fs';
import path from 'node:path';
import { newId, now } from '@llmbugfix/shared';
import {
  ExternalApiErrorCodeSchema,
  ExternalTaskCreateRequestSchema,
  ExternalTaskEventSchema,
  ExternalTaskResourceSchema,
  ExternalTaskResultSchema,
  type ExternalApiErrorCode,
  type ExternalTaskEvent,
  type ExternalTaskResource,
  type ExternalTaskResult,
  type ExternalTaskType,
  type PublicTaskStage,
  type PublicTaskStatus,
} from '@llmbugfix/api-contract';
import type { BugRepository } from '@llmbugfix/bug-repository';
import type { BugReport } from '@llmbugfix/bug-domain';

/** The API deliberately talks to a small structural interface.  This keeps
 * the web process compatible with both the pre-v1 repository and the
 * transaction-backed repository introduced by the queue migration. */
export type ExternalTaskRepository = Pick<BugRepository, 'getBug' | 'listBugs' | 'changeBugStatus'> & {
  database?: {
    prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown; run(...args: unknown[]): { changes?: number } };
    transaction<T>(callback: () => T): () => T;
  };
  createExternalTask?: (input: unknown, idempotencyKey?: string) => unknown;
  getExternalTask?: (taskId: string) => unknown;
  listExternalTasks?: (query?: unknown) => unknown;
  listTaskEvents?: (taskId: string, query?: unknown) => unknown;
  getTaskResult?: (taskId: string) => unknown;
  cancelExternalTask?: (taskId: string) => unknown;
  retryExternalTask?: (taskId: string) => unknown;
};

export type ExternalTaskQueue = {
  listJobs?: () => Array<Record<string, unknown>>;
  getJob?: (id: string) => Record<string, unknown>;
  cancelJob?: (id: string, ...args: unknown[]) => unknown;
  retryJob?: (id: string) => unknown;
  enqueueJob?: (bugId: string, bugKey?: string, priority?: number) => unknown;
};

export type TaskServiceOptions = {
  repo: ExternalTaskRepository;
  queue?: ExternalTaskQueue;
  dataRoot?: string;
  dryRun?: boolean;
  allowedRepositoryHosts?: string[];
  capabilities?: () => unknown;
};

export type TaskListFilters = { status?: PublicTaskStatus; taskType?: ExternalTaskType };
export type TaskCursor = { createdAt: string; taskId: string; filters: TaskListFilters };

export class TaskServiceError extends Error {
  constructor(readonly code: ExternalApiErrorCode, readonly status: number, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'TaskServiceError';
  }
}

const PRIORITY: Record<string, number> = { high: 0, normal: 10, low: 20 };
const ACTIVE_INTERNAL = new Set(['QUEUED', 'TRIAGING', 'SUBMITTED', 'PREPARING_ENV', 'FIXING', 'VALIDATING', 'REVIEWING', 'PUSHING']);
const TERMINAL_INTERNAL = new Set(['FIX_READY', 'READY_FOR_HUMAN_REVIEW', 'FIX_CANDIDATE', 'FIX_FAILED', 'ENVIRONMENT_FAILED', 'VALIDATION_FAILED', 'REVIEW_REJECTED', 'PUSH_FAILED', 'BLOCKED', 'CANCELLED', 'REJECTED']);
const isoOrNow = (value: unknown): string => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : now();
const stringValue = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const arrayValue = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const jsonObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'string') return objectValue(value);
  try { return objectValue(JSON.parse(value)); } catch { return {}; }
};
const safeText = (value: unknown, max = 8_000): string => {
  const text = String(value ?? '');
  // Paths, tokens and internal URLs are never part of an external result.
  return text.replace(/(?:bearer\s+|api[_-]?key\s*[=:]\s*)[^\s,;]+/giu, '[REDACTED]').replace(/(?:https?|ssh):\/\/[^\s)]+/giu, '[REDACTED_URL]').replace(/(^|[\s"'])(?:\/|[A-Za-z]:\\)[^\s"']*/gu, '$1[REDACTED_PATH]').slice(0, max);
};
const safeFilename = (value: unknown): string => {
  const name = path.basename(String(value ?? '')).replace(/[\r\n]/gu, '');
  return name.length > 500 ? name.slice(0, 500) : name;
};

/** Extract the host from a validated Git remote without confusing a URI
 * scheme (for example, the `https` in `https://host/repo`) with the host. */
function repositoryHostname(cloneUrl: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(cloneUrl)) {
    try { return new URL(cloneUrl).hostname || undefined; } catch { return undefined; }
  }
  // RepositoryTargetSchema accepts the canonical scp-style form
  // `user@host:path`. Keep this parser in lockstep with that shape.
  return cloneUrl.match(/^(?:[^@/\\:\s]+@)([^/\\:\s]+):/u)?.[1];
}

function internalStatus(repo: ExternalTaskRepository, bug: BugReport): string {
  const database = repo.database;
  if (!database) return stringValue((bug as unknown as Record<string, unknown>).status, 'DRAFT');
  try {
    const row = database.prepare('SELECT status FROM bug_reports WHERE id = ? OR bug_key = ?').get(bug.id, bug.bugKey) as { status?: string } | undefined;
    return row?.status ?? stringValue((bug as unknown as Record<string, unknown>).status, 'DRAFT');
  } catch { return stringValue((bug as unknown as Record<string, unknown>).status, 'DRAFT'); }
}

export function publicTaskStatus(status: string): PublicTaskStatus {
  if (status === 'queued' || status === 'running' || status === 'succeeded' || status === 'failed' || status === 'cancelled') return status;
  if (status === 'CANCELLED') return 'cancelled';
  if (TERMINAL_INTERNAL.has(status)) return status === 'FIX_READY' || status === 'READY_FOR_HUMAN_REVIEW' ? 'succeeded' : 'failed';
  if (ACTIVE_INTERNAL.has(status)) return status === 'QUEUED' || status === 'TRIAGING' || status === 'SUBMITTED' ? 'queued' : 'running';
  return 'queued';
}

export function publicTaskStage(status: string): PublicTaskStage {
  if (status === 'queued' || status === 'preparing_environment' || status === 'fixing' || status === 'validating' || status === 'reviewing' || status === 'pushing' || status === 'ready' || status === 'human_review' || status === 'failed' || status === 'cancelled') return status;
  const stages: Record<string, PublicTaskStage> = {
    DRAFT: 'queued', COLLECTING: 'queued', READY_FOR_CONFIRMATION: 'queued', SUBMITTED: 'queued', TRIAGING: 'queued', QUEUED: 'queued',
    NEEDS_INFO: 'queued', PREPARING_ENV: 'preparing_environment', FIXING: 'fixing', VALIDATING: 'validating',
    REVIEWING: 'reviewing', PUSHING: 'pushing', FIX_READY: 'ready', READY_FOR_HUMAN_REVIEW: 'human_review', BLOCKED: 'failed',
    FIX_CANDIDATE: 'failed', FIX_FAILED: 'failed', ENVIRONMENT_FAILED: 'failed', VALIDATION_FAILED: 'failed', REVIEW_REJECTED: 'failed', PUSH_FAILED: 'failed',
    REJECTED: 'failed', CANCELLED: 'cancelled',
  };
  return stages[status] ?? 'queued';
}

function decodeCursor(value: string | undefined, filters: TaskListFilters): TaskCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const raw = Buffer.from(value, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    const cursor = objectValue(parsed);
    if (typeof cursor.createdAt !== 'string' || typeof cursor.taskId !== 'string' || !cursor.filters || JSON.stringify(cursor.filters) !== JSON.stringify(filters)) throw new Error('cursor mismatch');
    if (Number.isNaN(Date.parse(cursor.createdAt))) throw new Error('cursor timestamp');
    return { createdAt: cursor.createdAt, taskId: cursor.taskId, filters };
  } catch { throw new TaskServiceError('INVALID_CURSOR', 400, 'Cursor is invalid'); }
}
const encodeCursor = (cursor: TaskCursor): string => Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

function links(taskId: string): ExternalTaskResource['links'] {
  const prefix = `/api/v1/tasks/${encodeURIComponent(taskId)}`;
  return { self: prefix, events: `${prefix}/events`, result: `${prefix}/result` };
}

function readStatusFromValue(value: unknown): string | undefined {
  const object = objectValue(value);
  const bug = object.bug;
  if (typeof object.status === 'string') return object.status;
  if (typeof object.state === 'string') return object.state;
  if (typeof bug === 'object' && bug && typeof (bug as Record<string, unknown>).status === 'string') return (bug as Record<string, unknown>).status as string;
  return undefined;
}

export class TaskService {
  private readonly repo: ExternalTaskRepository;
  private readonly queue?: ExternalTaskQueue;
  private readonly dataRoot: string;
  private readonly dryRun: boolean;
  private readonly allowedHosts: Set<string>;
  private readonly capabilitiesProvider?: () => unknown;

  constructor(options: TaskServiceOptions) {
    this.repo = options.repo;
    this.queue = options.queue;
    this.dataRoot = options.dataRoot ?? 'data';
    this.dryRun = options.dryRun ?? true;
    this.allowedHosts = new Set((options.allowedRepositoryHosts ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean));
    this.capabilitiesProvider = options.capabilities;
  }

  private bug(taskId: string): BugReport {
    try {
      const value = this.repo.getBug(taskId);
      if (!value) throw new TaskServiceError('TASK_NOT_FOUND', 404, 'Task does not exist');
      return value;
    } catch (error) {
      if (error instanceof TaskServiceError) throw error;
      throw new TaskServiceError('TASK_NOT_FOUND', 404, 'Task does not exist');
    }
  }

  private resource(bug: BugReport, statusOverride?: string): ExternalTaskResource {
    const status = statusOverride ?? internalStatus(this.repo, bug);
    return ExternalTaskResourceSchema.parse({ taskId: bug.id, taskKey: bug.bugKey, taskType: bug.taskType, title: bug.title, executionTarget: bug.executionTarget, status: publicTaskStatus(status), stage: publicTaskStage(status), createdAt: isoOrNow(bug.createdAt), updatedAt: isoOrNow(bug.updatedAt), links: links(bug.id) });
  }

  private validateHost(cloneUrl: string): void {
    if (!this.allowedHosts.size) return;
    const hostname = repositoryHostname(cloneUrl);
    if (!hostname || !this.allowedHosts.has(hostname.toLowerCase())) {
      throw new TaskServiceError('REPOSITORY_HOST_NOT_ALLOWED', 400, 'Repository host is not allowed', { host: hostname ?? '' });
    }
  }

  async create(input: unknown, idempotencyKey: string | undefined): Promise<{ task: ExternalTaskResource; idempotent: boolean }> {
    if (idempotencyKey === undefined) throw new TaskServiceError('MISSING_IDEMPOTENCY_KEY', 400, 'Idempotency-Key header is required');
    if (idempotencyKey.length < 1 || idempotencyKey.length > 200 || /[\r\n]/u.test(idempotencyKey)) throw new TaskServiceError('INVALID_IDEMPOTENCY_KEY', 400, 'Idempotency-Key must be 1 to 200 characters');
    const parsed = ExternalTaskCreateRequestSchema.safeParse(input);
    if (!parsed.success) {
      const branchIssue = parsed.error.issues.find((issue) => issue.path.join('.') === 'repository.baseBranch');
      const repositoryIssue = parsed.error.issues.find((issue) => issue.path[0] === 'repository');
      const code = branchIssue ? 'INVALID_BASE_BRANCH' : repositoryIssue ? 'REPOSITORY_URL_INVALID' : 'INVALID_REQUEST';
      throw new TaskServiceError(code, 400, 'Request does not satisfy the external task contract', { issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) });
    }
    this.validateHost(parsed.data.repository.cloneUrl);

    try {
      const creator = this.repo.createExternalTask;
      if (!creator) throw new TaskServiceError('QUEUE_UNAVAILABLE', 503, 'External task queue is unavailable');
      // The migrated repository accepts the request and key as one transaction
      // input. The second argument remains for source compatibility with an
      // earlier implementation that accepted the key separately.
      const created = await Promise.resolve(creator.call(this.repo, { request: parsed.data, idempotencyKey }, idempotencyKey));
      const value = objectValue(created);
      const returnedBug = objectValue(value.bug || value.task);
      const taskId = stringValue(value.taskId || value.bugId || value.id || returnedBug.taskId || returnedBug.id);
      const bug = taskId ? this.repo.getBug(taskId) : null;
      if (!bug) throw new TaskServiceError('INTERNAL_ERROR', 500, 'Task creation did not return a task');
      return { task: this.resource(bug, readStatusFromValue(created)), idempotent: value.idempotent === true };
    } catch (error) {
      if (error instanceof TaskServiceError) throw error;
      if (objectValue(error).code === 'IDEMPOTENCY_CONFLICT') throw new TaskServiceError('IDEMPOTENCY_CONFLICT', 409, 'The Idempotency-Key was already used with a different request body');
      const message = error instanceof Error ? error.message : 'Unable to enqueue task';
      if (/queue|database|sqlite|busy|job/iu.test(message)) throw new TaskServiceError('QUEUE_UNAVAILABLE', 503, 'Task queue is temporarily unavailable');
      throw new TaskServiceError('INTERNAL_ERROR', 500, 'Unable to create task');
    }
  }

  get(taskId: string): ExternalTaskResource { return this.resource(this.bug(taskId)); }

  list(filters: TaskListFilters, limit: number, cursorValue?: string): { data: ExternalTaskResource[]; nextCursor: string | null; hasMore: boolean } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TaskServiceError('INVALID_REQUEST', 400, 'limit must be between 1 and 100');
    const cursor = decodeCursor(cursorValue, filters);
    let allBugs = this.repo.listBugs();
    // External submissions have a durable task_repositories row. Excluding
    // legacy UI-intake reports prevents an old/partial BugReport (for example
    // executionTarget=unknown) from breaking the external list contract.
    if (this.repo.database) {
      try {
        const rows = this.repo.database.prepare('SELECT bug_id FROM task_repositories').all() as Array<Record<string, unknown>>;
        const externalIds = new Set(rows.map((row) => String(row.bug_id)));
        allBugs = allBugs.filter((bug) => externalIds.has(bug.id));
      } catch { /* pre-v1 databases have no marker table */ }
    }
    let bugs = allBugs.map((bug) => ({ bug, resource: this.resource(bug) }));
    bugs = bugs.filter(({ resource }) => (!filters.status || resource.status === filters.status) && (!filters.taskType || resource.taskType === filters.taskType));
    bugs.sort((a, b) => a.resource.createdAt.localeCompare(b.resource.createdAt) || a.resource.taskId.localeCompare(b.resource.taskId));
    if (cursor) bugs = bugs.filter(({ resource }) => resource.createdAt > cursor.createdAt || (resource.createdAt === cursor.createdAt && resource.taskId > cursor.taskId));
    const page = bugs.slice(0, limit + 1);
    const hasMore = page.length > limit;
    const data = page.slice(0, limit).map(({ resource }) => resource);
    const last = data.at(-1);
    return { data, hasMore, nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, taskId: last.taskId, filters }) : null };
  }

  events(taskId: string, after: number, limit: number): { data: ExternalTaskEvent[]; nextAfter: number | null; hasMore: boolean } {
    const bug = this.bug(taskId);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TaskServiceError('INVALID_REQUEST', 400, 'after and limit must be valid non-negative integers');
    let events: unknown[] = [];
    if (this.repo.listTaskEvents) {
      const provided = this.repo.listTaskEvents(bug.id, { after, limit: limit + 1 });
      events = Array.isArray(provided) ? provided : arrayValue(objectValue(provided).data);
    }
    if (!events.length && this.repo.database) {
      try {
        const rows = this.repo.database.prepare('SELECT * FROM task_events WHERE bug_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?').all(bug.id, after, limit + 1) as unknown[];
        events = rows;
      } catch {
        // A pre-migration process has no task_events table. Fall back to the
        // durable bug/worker events so GET events remains useful during a
        // rolling upgrade.
        try {
          const rows = this.repo.database.prepare('SELECT id, created_at, event_type, to_status, payload FROM bug_events WHERE bug_id = ? ORDER BY created_at ASC').all(bug.id) as Array<Record<string, unknown>>;
          events = rows.map((row, index) => ({ eventId: row.id, sequence: index + 1, taskId: bug.id, type: eventType(stringValue(row.event_type)), status: publicTaskStatus(stringValue(row.to_status)), stage: publicTaskStage(stringValue(row.to_status)), occurredAt: row.created_at, data: jsonObject(row.payload) })).filter((event) => Number((event as Record<string, unknown>).sequence) > after).slice(0, limit + 1);
        } catch { events = []; }
      }
    }
    const normalized = events.map((value, index) => this.normalizeEvent(value, bug, after + index + 1)).filter((value): value is ExternalTaskEvent => value !== null);
    const hasMore = normalized.length > limit;
    const data = normalized.slice(0, limit);
    return { data, hasMore, nextAfter: data.at(-1)?.sequence ?? (after || null) };
  }

  private normalizeEvent(value: unknown, bug: BugReport, fallbackSequence: number): ExternalTaskEvent | null {
    const object = objectValue(value);
    const statusRaw = stringValue(object.status || object.toStatus || object.to_status, internalStatus(this.repo, bug));
    const type = eventType(stringValue(object.type || object.eventType || object.event_type));
    const parsed = ExternalTaskEventSchema.safeParse({ eventId: stringValue(object.eventId || object.id, newId()), sequence: Number(object.sequence ?? fallbackSequence), taskId: bug.id, type, status: publicTaskStatus(statusRaw), stage: publicTaskStage(statusRaw), occurredAt: isoOrNow(object.occurredAt || object.occurred_at), data: objectValue(object.data || object.payload) });
    return parsed.success ? parsed.data : null;
  }

  result(taskId: string): { ready: boolean; task: ExternalTaskResource; result: ExternalTaskResult | null } {
    const bug = this.bug(taskId);
    const task = this.resource(bug);
    if (task.status !== 'succeeded' && task.status !== 'failed' && task.status !== 'cancelled') return { ready: false, task, result: null };
    const value = this.repo.getTaskResult ? this.repo.getTaskResult(bug.id) : undefined;
    const result = value && objectValue(value).taskId ? this.normalizeResult(objectValue(value), bug, task) : this.readArtifacts(bug, task);
    return { ready: true, task, result };
  }

  private readArtifacts(bug: BugReport, task: ExternalTaskResource): ExternalTaskResult {
    const root = path.resolve(this.dataRoot, 'agent-results', bug.bugKey);
    const read = (filename: string): Record<string, unknown> => {
      try { const value = JSON.parse(fs.readFileSync(path.join(root, filename), 'utf8')) as unknown; return objectValue(value); } catch { return {}; }
    };
    const fix = read('agent-result.json');
    const validation = read('validation.json');
    const review = read('review.json');
    const git = read('git-result.json');
    let diff: string | null = null;
    try { diff = safeText(fs.readFileSync(path.join(root, 'diff.patch'), 'utf8'), 200_000); } catch { /* optional */ }
    const delivery = task.status !== 'succeeded' ? null : this.dryRun ? { type: 'patch' as const, pushed: false as const, branch: null, commitSha: null, diff } : git.branch && git.commitSha ? { type: 'git_branch' as const, pushed: true as const, branch: safeText(git.branch, 255), commitSha: safeText(git.commitSha, 64), diff } : null;
    return ExternalTaskResultSchema.parse({ taskId: bug.id, status: task.status, completedAt: isoOrNow(bug.updatedAt), fix: Object.keys(fix).length ? this.fixSummary(fix) : null, validation: Object.keys(validation).length ? this.validationSummary(validation) : null, review: Object.keys(review).length ? this.reviewSummary(review) : null, delivery, error: task.status === 'failed' ? { code: 'TASK_FAILED', message: safeText(stringValue(fix.error || validation.error || review.error || git.error, 'Task failed')) } : null });
  }

  private normalizeResult(value: Record<string, unknown>, bug: BugReport, task: ExternalTaskResource): ExternalTaskResult {
    const candidate = objectValue(value.result || value);
    const delivery = objectValue(candidate.delivery);
    const failure = candidate.error;
    const normalized = { ...candidate, taskId: bug.id, status: task.status, completedAt: isoOrNow(candidate.completedAt || bug.updatedAt), fix: candidate.fix ? this.fixSummary(objectValue(candidate.fix)) : null, validation: candidate.validation ? this.validationSummary(objectValue(candidate.validation)) : null, review: candidate.review ? this.reviewSummary(objectValue(candidate.review)) : null, delivery: task.status !== 'succeeded' ? null : this.dryRun ? { type: 'patch' as const, pushed: false as const, branch: null, commitSha: null, diff: typeof delivery.diff === 'string' ? safeText(delivery.diff, 200_000) : null } : delivery.type === 'git_branch' ? { type: 'git_branch' as const, pushed: true as const, branch: safeText(delivery.branch, 255), commitSha: safeText(delivery.commitSha, 64), diff: typeof delivery.diff === 'string' ? safeText(delivery.diff, 200_000) : null } : null };
    return ExternalTaskResultSchema.parse({ taskId: normalized.taskId, status: normalized.status, completedAt: normalized.completedAt, fix: normalized.fix, validation: normalized.validation, review: normalized.review, delivery: normalized.delivery, error: failure ? { code: safeText(objectValue(failure).code || 'TASK_FAILED', 100), message: safeText(objectValue(failure).message || 'Task failed') } : null });
  }

  private fixSummary(value: Record<string, unknown>): ExternalTaskResult['fix'] {
    const status = ['fixed', 'blocked', 'not_reproducible', 'failed', 'completed'].includes(stringValue(value.status)) ? stringValue(value.status) : 'completed';
    return { status: status as 'fixed', confidence: Math.max(0, Math.min(1, Number(value.confidence ?? 0))), summary: safeText(value.summary || value.message), ...(value.rootCause == null ? {} : { rootCause: safeText(value.rootCause) }), filesChanged: arrayValue(value.filesChanged || value.files_changed).map(safeFilename).filter(Boolean), riskNotes: arrayValue(value.riskNotes || value.risk_notes).map((item) => safeText(item, 2_000)) } as ExternalTaskResult['fix'];
  }
  private validationSummary(value: Record<string, unknown>): ExternalTaskResult['validation'] {
    const results = arrayValue(value.results).map((entry) => { const item = objectValue(entry); return { command: safeText(item.command, 500), exitCode: Number.isInteger(item.exitCode) ? Number(item.exitCode) : 1, passed: Boolean(item.passed), output: safeText(item.output, 8_000) }; });
    return { passed: Boolean(value.passed ?? value.success), summary: safeText(value.summary || value.message), commands: arrayValue(value.commands).map((item) => safeText(item, 500)), results };
  }
  private reviewSummary(value: Record<string, unknown>): ExternalTaskResult['review'] {
    const risk = ['low', 'medium', 'high'].includes(stringValue(value.regressionRisk)) ? stringValue(value.regressionRisk) : 'medium';
    return { verdict: value.verdict === 'reject' ? 'reject' : 'approve', addressed: Boolean(value.addressed ?? value.bugAddressed ?? value.taskAddressed), regressionRisk: risk as 'medium', summary: safeText(value.summary || value.message), findings: arrayValue(value.findings).map((item) => safeText(item, 2_000)) };
  }

  async cancel(taskId: string): Promise<ExternalTaskResource> {
    const bug = this.bug(taskId);
    const task = this.resource(bug);
    if (task.status !== 'queued' && task.status !== 'running') throw new TaskServiceError('TASK_NOT_CANCELLABLE', 409, 'Task cannot be cancelled', { status: task.status });
    try {
      if (this.repo.cancelExternalTask) await Promise.resolve(this.repo.cancelExternalTask(bug.id));
      else {
        const jobs = this.jobsFor(bug.id);
        const current = jobs.find((job) => job.status === 'QUEUED' || job.status === 'RUNNING');
        if (current && this.queue?.cancelJob) await Promise.resolve(this.queue.cancelJob(String(current.id)));
        this.repo.changeBugStatus(bug.id, 'CANCELLED', 'external_cancel');
      }
      return this.resource(this.bug(taskId));
    } catch { throw new TaskServiceError('TASK_NOT_CANCELLABLE', 409, 'Task could not be cancelled'); }
  }

  async retry(taskId: string): Promise<ExternalTaskResource> {
    const bug = this.bug(taskId);
    const task = this.resource(bug);
    if (task.status !== 'failed') throw new TaskServiceError('TASK_NOT_RETRYABLE', 409, 'Task is not retryable', { status: task.status });
    try {
      if (this.repo.retryExternalTask) await Promise.resolve(this.repo.retryExternalTask(bug.id));
      else {
        const jobs = this.jobsFor(bug.id);
        const previous = jobs.slice().reverse().find((job) => job.status === 'FAILED' || job.status === 'INTERRUPTED');
        if (previous && this.queue?.retryJob) await Promise.resolve(this.queue.retryJob(String(previous.id)));
        else if (this.queue?.enqueueJob) await Promise.resolve(this.queue.enqueueJob(bug.id, bug.bugKey, 10));
        this.repo.changeBugStatus(bug.id, 'QUEUED', 'external_retry');
      }
      return this.resource(this.bug(taskId));
    } catch { throw new TaskServiceError('TASK_NOT_RETRYABLE', 409, 'Task could not be retried'); }
  }

  capabilities(): unknown {
    if (this.capabilitiesProvider) return this.capabilitiesProvider();
    return { capabilities: [] };
  }

  private jobsFor(bugId: string): Array<Record<string, unknown>> {
    if (this.queue?.listJobs) return this.queue.listJobs().filter((job) => String(job.bugId ?? job.bug_id) === bugId);
    try { return (this.repo.database?.prepare('SELECT * FROM jobs WHERE bug_id = ?').all(bugId) as Array<Record<string, unknown>> ?? []); } catch { return []; }
  }
}

function eventType(value: string): ExternalTaskEvent['type'] {
  if (value === 'task.created' || value === 'task.queued' || value === 'task.started' || value === 'task.stage_changed' || value === 'task.completed' || value === 'task.failed' || value === 'task.cancelled' || value === 'task.retry_requested') return value;
  if (/cancel/iu.test(value)) return 'task.cancelled';
  if (/retry/iu.test(value)) return 'task.retry_requested';
  if (/fail|reject|error/iu.test(value)) return 'task.failed';
  if (/complete|ready/iu.test(value)) return 'task.completed';
  if (/start|run/iu.test(value)) return 'task.started';
  if (/queue|submit/iu.test(value)) return 'task.queued';
  return 'task.stage_changed';
}

export function priorityFor(value: string): number {
  return PRIORITY[value] ?? PRIORITY.normal;
}

export function assertExternalTaskErrorCode(code: string): ExternalApiErrorCode {
  return ExternalApiErrorCodeSchema.parse(code);
}
