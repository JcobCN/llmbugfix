import { newId } from '@llmbugfix/shared';
import { ExternalApiErrorSchema, ExternalTaskEventPageSchema, ExternalTaskListSchema, ExternalTaskSubmissionSchema, type ExternalApiErrorCode } from '@llmbugfix/api-contract';
import { TaskService, TaskServiceError, type ExternalTaskRepository, type ExternalTaskQueue, type TaskListFilters } from './task-service.js';

export type V1Request = {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  bodyError?: 'syntax' | 'shape';
  requestId?: string;
};
export type V1Response = { status: number; body: unknown; headers?: Record<string, string> };
export type V1RoutesOptions = {
  repo: ExternalTaskRepository;
  queue?: ExternalTaskQueue;
  dataRoot?: string;
  dryRun?: boolean;
  allowedRepositoryHosts?: string[];
  capabilities?: () => unknown;
};

const header = (headers: V1Request['headers'], name: string): string | undefined => {
  const wanted = name.toLowerCase();
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
  return Array.isArray(value) ? value[0] : value;
};

function errorResponse(error: unknown, requestId: string): V1Response {
  let status = 500;
  let code: ExternalApiErrorCode = 'INTERNAL_ERROR';
  let message = 'Internal server error';
  let details: Record<string, unknown> | undefined;
  if (error instanceof TaskServiceError) { status = error.status; code = error.code; message = error.message; details = Object.keys(error.details).length ? error.details : undefined; }
  const body = ExternalApiErrorSchema.parse({ error: { code, message, ...(details ? { details } : {}) }, requestId });
  return { status, body };
}

const pathTask = (pathname: string): { taskId: string; action?: string } | null => {
  const match = pathname.match(/^\/api\/v1\/tasks\/([^/]+)(?:\/(events|result|cancel|retry))?$/u);
  if (!match) return null;
  try { return { taskId: decodeURIComponent(match[1]), action: match[2] }; } catch { return null; }
};

export class V1Routes {
  readonly service: TaskService;
  constructor(options: V1RoutesOptions) {
    this.service = new TaskService(options);
  }

  async handle(request: V1Request): Promise<V1Response | null> {
    const requestId = request.requestId ?? newId();
    try {
      if (request.pathname === '/api/v1/capabilities' && request.method === 'GET') return { status: 200, body: this.service.capabilities() };
      if (request.pathname === '/api/v1/tasks' && request.method === 'POST') {
        if (request.bodyError === 'syntax') return errorResponse(new TaskServiceError('INVALID_JSON', 400, 'Request body must be valid JSON'), requestId);
        if (request.bodyError === 'shape') return errorResponse(new TaskServiceError('INVALID_REQUEST', 400, 'Request body must be a JSON object'), requestId);
        const key = header(request.headers, 'idempotency-key');
        const created = await this.service.create(request.body ?? {}, key);
        const body = ExternalTaskSubmissionSchema.parse({ ...created.task, idempotent: created.idempotent });
        return { status: 202, headers: { location: created.task.links.self }, body };
      }
      if (request.pathname === '/api/v1/tasks' && request.method === 'GET') {
        const limit = request.query.get('limit') === null ? 20 : Number(request.query.get('limit'));
        const statusValue = request.query.get('status') ?? undefined;
        const taskTypeValue = request.query.get('taskType') ?? undefined;
        const status = statusValue && ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(statusValue) ? statusValue as TaskListFilters['status'] : statusValue ? (() => { throw new TaskServiceError('INVALID_REQUEST', 400, 'status is invalid'); })() : undefined;
        const taskType = taskTypeValue && ['bugfix', 'development'].includes(taskTypeValue) ? taskTypeValue as TaskListFilters['taskType'] : taskTypeValue ? (() => { throw new TaskServiceError('INVALID_REQUEST', 400, 'taskType is invalid'); })() : undefined;
        const page = this.service.list({ ...(status ? { status } : {}), ...(taskType ? { taskType } : {}) }, limit, request.query.get('cursor') ?? undefined);
        return { status: 200, body: ExternalTaskListSchema.parse(page) };
      }
      const target = pathTask(request.pathname);
      if (!target) return null;
      if (!target.action && request.method === 'GET') return { status: 200, body: this.service.get(target.taskId) };
      if (target.action === 'events' && request.method === 'GET') {
        const afterRaw = request.query.get('after');
        const limitRaw = request.query.get('limit');
        const after = afterRaw === null ? 0 : afterRaw.trim() ? Number(afterRaw) : Number.NaN;
        const limit = limitRaw === null ? 20 : limitRaw.trim() ? Number(limitRaw) : Number.NaN;
        const page = this.service.events(target.taskId, after, limit);
        return { status: 200, body: ExternalTaskEventPageSchema.parse(page) };
      }
      if (target.action === 'result' && request.method === 'GET') {
        const result = this.service.result(target.taskId);
        return { status: result.ready ? 200 : 202, body: result.ready ? result.result : { task: result.task, result: null } };
      }
      if (target.action === 'cancel' && request.method === 'POST') return { status: 200, body: await this.service.cancel(target.taskId) };
      if (target.action === 'retry' && request.method === 'POST') return { status: 202, body: await this.service.retry(target.taskId) };
      return { status: 405, body: { error: { code: 'INVALID_REQUEST', message: 'Method not allowed', details: {} }, requestId } };
    } catch (error) { return errorResponse(error, requestId); }
  }
}

export const createV1Routes = (options: V1RoutesOptions): V1Routes => new V1Routes(options);

/** Function form is convenient for small HTTP adapters and keeps the route
 * module independent from Node's IncomingMessage/ServerResponse classes. */
export const handleV1Request = async (routes: V1Routes, request: V1Request): Promise<V1Response | null> => routes.handle(request);
