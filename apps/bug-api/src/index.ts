import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { newId, now } from '@llmbugfix/shared';
import { BugReportSchema, type BugReportDraft, type BugConversation, type EnvironmentProfileProposal } from '@llmbugfix/bug-domain';
import { DocumentPathError, DocumentRevisionConflictError, SQLiteBugDocumentStore, type BugDocumentStore, type DocumentSnapshot as StoredDocumentSnapshot, type SQLiteBugRepository, type BugRepository } from '@llmbugfix/bug-repository';
import { IntakeService, applyDocumentReconciliation, mergeBugDocument, mergeDraft, normalizeBugTitle, type IntakeProgressEvent } from '@llmbugfix/intake-agent';
import { evaluateCompleteness, hasGitRepositoryAddress } from '@llmbugfix/intake-policy';
import { createLogger, safeLogContext } from '@llmbugfix/shared';
import { createAttachmentRoutes } from './attachment-routes.js';

type QueueJobLike = { id: string; bugId: string; status: string; attempt?: number; error?: string | null; startedAt?: string | null; finishedAt?: string | null; heartbeatAt?: string | null; workerId?: string | null };
/** Public, deliberately bounded worker-log event shape.  The repository owns
 * persistence; the API keeps this type permissive so older workers can be
 * upgraded independently of the web process. */
type WorkerEventLike = {
  sequence: number;
  occurredAt: string;
  role: string;
  eventType: string;
  tool: string | null;
  isError: boolean;
  turnIndex: number | null;
  toolCallCount: number | null;
  summary: string;
  jobId?: string | null;
};
export type QueueLike = {
  enqueueJob(bugId: string, bugKey?: string, priority?: number): unknown;
  listJobs?: () => QueueJobLike[];
  getJob?: (id: string) => QueueJobLike;
  retryJob?: (id: string) => QueueJobLike;
  cancelJob?: (id: string) => QueueJobLike;
  recoverStaleJobs?: (timeoutMs?: number) => QueueJobLike[];
};
type ProvisionedEnvironmentProfile = { id: string; target: 'frontend' | 'backend' };
type EnvironmentSource = {
  listProfiles(): unknown[];
  resolveProfile?: (target: string, requestedProfileId?: string) => unknown;
  /** Creates a local checkout + generated profile after the reporter confirms. */
  provisionProfile?: (proposal: EnvironmentProfileProposal & { target: 'frontend' | 'backend' }) => Promise<ProvisionedEnvironmentProfile> | ProvisionedEnvironmentProfile;
};
export type PageResponse = {
  body: string | Buffer;
  contentType: string;
  headers?: Record<string, string>;
  status?: number;
};
export type PageRendererResult = string | PageResponse;
export type PageRenderer = (pathname: string) => PageRendererResult | undefined;
export type ApiDependencies = { repo: BugRepository; intake?: IntakeService; queue?: QueueLike; environments?: EnvironmentSource; attachments?: Parameters<typeof createAttachmentRoutes>[0]['attachments']; pageRenderer?: PageRenderer; documentStore?: BugDocumentStore };
export type InjectRequest = { method?: string; url: string; headers?: Record<string, string>; body?: unknown };
export type InjectResponse<T = unknown> = { status: number; headers: Record<string, string>; data: T; raw: string };
export const DEFAULT_API_CONFIG = {
  DRY_RUN: true,
  FIXER_TIMEOUT_MS: 2_700_000,
  REVIEWER_TIMEOUT_MS: 900_000,
  ENVIRONMENT_TIMEOUT_MS: 600_000,
  PIPELINE_TIMEOUT_MS: 5_400_000,
  DATA_ROOT: 'data',
  LLM_HOST: 'disabled://local',
  VISION_HOST: 'disabled://local',
  GIT_HOST: 'localhost',
  GIT_ALLOWED_HOSTS: 'localhost',
} as const;

/** Safe startup defaults. Secrets are deliberately not accepted as log context. */
export function resolveApiConfig(value: unknown = {}): Record<string, unknown> {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const numberValue = (name: string, fallback: number): number => {
    const candidate = input[name];
    if (candidate === undefined || candidate === null || candidate === '') return fallback;
    const result = Number(candidate);
    if (!Number.isFinite(result) || result <= 0) throw new Error(`${name} must be a positive number`);
    return result;
  };
  const bool = input.DRY_RUN === undefined ? DEFAULT_API_CONFIG.DRY_RUN : input.DRY_RUN === true || input.DRY_RUN === 'true';
  const resolved = { ...DEFAULT_API_CONFIG, ...input, DRY_RUN: bool, FIXER_TIMEOUT_MS: numberValue('FIXER_TIMEOUT_MS', DEFAULT_API_CONFIG.FIXER_TIMEOUT_MS), REVIEWER_TIMEOUT_MS: numberValue('REVIEWER_TIMEOUT_MS', DEFAULT_API_CONFIG.REVIEWER_TIMEOUT_MS), ENVIRONMENT_TIMEOUT_MS: numberValue('ENVIRONMENT_TIMEOUT_MS', DEFAULT_API_CONFIG.ENVIRONMENT_TIMEOUT_MS), PIPELINE_TIMEOUT_MS: numberValue('PIPELINE_TIMEOUT_MS', DEFAULT_API_CONFIG.PIPELINE_TIMEOUT_MS), DATA_ROOT: typeof input.DATA_ROOT === 'string' && input.DATA_ROOT ? input.DATA_ROOT : DEFAULT_API_CONFIG.DATA_ROOT } as Record<string, unknown>;
  // A configured push destination must be explicitly allow-listed. Disabled
  // adapters are accepted so offline startup remains the safe default.
  const gitHost = typeof resolved.GIT_HOST === 'string' ? resolved.GIT_HOST : '';
  const allowed = String(input.GIT_ALLOWED_HOSTS ?? DEFAULT_API_CONFIG.GIT_HOST).split(',').map((host) => host.trim()).filter(Boolean);
  if (gitHost && !gitHost.startsWith('disabled://') && !gitHost.startsWith('/') && !gitHost.startsWith('file:')) {
    const hostname = (() => { try { return new URL(gitHost.includes('://') ? gitHost : `ssh://${gitHost}`).hostname; } catch { return gitHost.split('/')[0].split(':')[0]; } })();
    if (!['localhost', '127.0.0.1', '::1'].includes(hostname) && !allowed.includes(hostname) && !allowed.includes(gitHost)) throw new Error(`GIT_HOST is not in GIT_ALLOWED_HOSTS: ${hostname}`);
  }
  return resolved;
}

const jsonBody = async (request: http.IncomingMessage): Promise<Record<string, unknown>> => {
  let data = ''; for await (const chunk of request) data += String(chunk);
  if (!data.trim()) return {};
  const parsed: unknown = JSON.parse(data); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Request body must be a JSON object');
  return parsed as Record<string, unknown>;
};
const send = (response: http.ServerResponse, status: number, body: unknown): void => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, idempotency-key', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,OPTIONS' }); response.end(JSON.stringify(body)); };
const sendPage = (response: http.ServerResponse, result: PageRendererResult): void => {
  if (typeof result === 'string') {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
    });
    response.end(result);
    return;
  }
  const status = result.status ?? 200;
  const headers: Record<string, string> = {
    'content-type': result.contentType,
    'x-content-type-options': 'nosniff',
    ...(result.headers ?? {}),
  };
  response.writeHead(status, headers);
  response.end(result.body);
};

/** An in-flight message failure carrying the exact JSON error payload to return. */
class MessageProcessingError extends Error {
  constructor(readonly status: number, readonly payload: Record<string, unknown>) { super(String(payload.error ?? 'Message processing failed')); }
}
type SseEmit = (event: string, data: unknown) => void;
const conversationResponse = (repo: BugRepository, conversation: BugConversation, document?: StoredDocumentSnapshot | null) => ({ ...conversation, messages: repo.listMessages(conversation.id), ...(document ? { document } : {}) });

function updateConversation(repo: BugRepository, id: string, draft: BugReportDraft, completeness: ReturnType<typeof evaluateCompleteness>, status?: BugConversation['status']): BugConversation {
  const candidate = repo.getConversation(id); if (!candidate) throw new Error('Conversation not found');
  return repo.updateConversation(id, { draft, completeness, status: status ?? candidate.status });
}

export class BugApiServer {
  private readonly server: http.Server;
  private readonly repo: BugRepository;
  private readonly intake: IntakeService;
  private readonly environments?: EnvironmentSource;
  private readonly queue?: QueueLike;
  private readonly pageRenderer?: PageRenderer;
  private readonly apiConfig: ReturnType<typeof resolveApiConfig>;
  private readonly attachmentRoutes?: ReturnType<typeof createAttachmentRoutes>;
  private readonly documentStore?: BugDocumentStore;
  private readonly logger = createLogger('bug-api');
  private readonly manualFields = new Map<string, Set<string>>();
  constructor(private readonly config: unknown, repoOrDeps?: SQLiteBugRepository | ApiDependencies, intake?: IntakeService, private readonly attachmentService?: unknown, queue?: QueueLike, envResolver?: EnvironmentSource) {
    this.apiConfig = resolveApiConfig(config);
    const dependencyValue = repoOrDeps ?? (config as ApiDependencies);
    if (!dependencyValue || typeof dependencyValue !== 'object') throw new Error('BugApiServer requires repository dependencies');
    if ('repo' in dependencyValue) { this.repo = dependencyValue.repo; this.intake = dependencyValue.intake ?? intake ?? new IntakeService(); this.environments = dependencyValue.environments; this.queue = dependencyValue.queue ?? queue; this.pageRenderer = dependencyValue.pageRenderer; this.attachmentRoutes = dependencyValue.attachments ? createAttachmentRoutes({ attachments: dependencyValue.attachments, repo: this.repo }) : undefined; this.documentStore = dependencyValue.documentStore ?? this.makeDocumentStore(this.repo); }
    else { this.repo = dependencyValue as SQLiteBugRepository; this.intake = intake ?? new IntakeService(); this.environments = envResolver; this.queue = queue; this.attachmentRoutes = this.attachmentService && typeof this.attachmentService === 'object' ? createAttachmentRoutes({ attachments: this.attachmentService as Parameters<typeof createAttachmentRoutes>[0]['attachments'], repo: this.repo }) : undefined; this.documentStore = this.makeDocumentStore(this.repo); }
    this.server = http.createServer((request, response) => { void this.handle(request, response); });
  }
  private makeDocumentStore(repo: BugRepository): BugDocumentStore | undefined {
    const database = (repo as unknown as { database?: unknown }).database;
    if (!database || typeof (database as { prepare?: unknown }).prepare !== 'function') return undefined;
    return new SQLiteBugDocumentStore(database as import('@llmbugfix/bug-repository').SqliteDatabase, String(this.apiConfig.DATA_ROOT));
  }
  async inject<T = unknown>(request: InjectRequest): Promise<InjectResponse<T>> {
    const { Readable } = await import('node:stream');
    const rawBody = request.body === undefined ? '' : typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    const incoming = new Readable({ read() { if (rawBody) this.push(Buffer.from(rawBody)); this.push(null); } }) as unknown as http.IncomingMessage;
    incoming.method = (request.method ?? 'GET').toUpperCase();
    incoming.url = request.url;
    incoming.headers = { 'content-type': 'application/json', ...(request.headers ?? {}) };
    let status = 200; let raw = ''; const headers: Record<string, string> = {};
    const outgoing = { writeHead(code: number, values?: Record<string, string>) { status = code; if (values) Object.assign(headers, values); return this; }, write(chunk?: string | Buffer) { if (chunk) raw += chunk.toString(); return true; }, flushHeaders() {}, once() { return this; }, end(chunk?: string | Buffer) { if (chunk) raw += chunk.toString(); } } as unknown as http.ServerResponse;
    await this.handle(incoming, outgoing);
    let data: unknown = raw; try { data = JSON.parse(raw); } catch { /* non-JSON response */ }
    return { status, headers, data: data as T, raw };
  }
  listen(port = 0, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        const address = this.server.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });
  }
  close(): Promise<void> { return new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve())); }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method === 'OPTIONS') { send(response, 204, {}); return; }
    const parsed = new URL(request.url ?? '/', 'http://localhost'); const path = parsed.pathname; const method = request.method ?? 'GET';
    try {
      if (path === '/api/health' || path === '/api/health/live' || path === '/healthz') { send(response, 200, { status: 'ok', live: true, time: now() }); return; }
      if (path === '/api/health/ready' || path === '/readyz') {
        const ready = this.isReady(); send(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', checks: { database: ready, queue: this.queue ? true : 'not_configured' }, config: { dryRun: this.apiConfig.DRY_RUN } }); return;
      }
      if (path === '/api/environments' && method === 'GET') { send(response, 200, { environments: this.environments?.listProfiles?.() ?? [] }); return; }
      if (path === '/api/ops/jobs' && method === 'GET') { send(response, 200, { jobs: this.queue?.listJobs?.() ?? [], automaticRetry: false }); return; }
      if (path === '/api/ops/recover' && method === 'POST') {
        if (!this.queue?.recoverStaleJobs) { send(response, 501, { error: 'Queue recovery is unavailable' }); return; }
        const body = await jsonBody(request); const timeout = body.staleTimeoutMs === undefined ? undefined : Number(body.staleTimeoutMs); if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) { send(response, 400, { error: 'staleTimeoutMs must be positive' }); return; }
        const recovered = this.queue.recoverStaleJobs(timeout); send(response, 200, { recovered, retried: false, manualRetryRequired: recovered.map((job) => job.id) }); return;
      }
      if (this.attachmentRoutes && (/^\/api\/bugs\/[^/]+\/attachments$/.test(path) || path === '/internal/vision/analyze')) { const attachment = await this.attachmentRoutes({ method, pathname: path, body: await this.optionalBody(request) }); if (attachment) { send(response, attachment.status, attachment.body); return; } }
      const conversationMatch = path.match(/^\/api\/(?:bugs\/)?conversations\/([^/]+)(?:\/(messages\/stream|messages|draft|document|submit))?$/);
      if (path === '/api/bugs/conversations' || path === '/api/conversations') {
        if (method !== 'POST') { send(response, 405, { error: 'Method not allowed' }); return; }
        const body = await this.optionalBody(request); const userId = typeof body.reporterId === 'string' ? String(body.reporterId) : undefined;
        let user = userId ? this.repo.getUser(userId) : null; if (!user) user = this.repo.createUser({ displayName: 'Reporter', email: null });
        const completeness = evaluateCompleteness({});
        const conversation = this.repo.createConversation({ reporterId: user.id, status: 'active', draft: {}, completeness });
        if (this.documentStore) this.documentStore.create(conversation.id, mergeBugDocument('', {}, completeness));
        this.repo.appendMessage({ conversationId: conversation.id, role: 'assistant', content: '请直接描述你遇到的问题，包括做了什么、实际发生什么，以及期望结果。', metadata: {} });
        send(response, 201, conversationResponse(this.repo, conversation, this.readDocument(conversation.id))); return;
      }
      if (conversationMatch) { await this.handleConversation(conversationMatch[1], conversationMatch[2], method, request, response); return; }
      const bugMatch = path.match(/^\/api\/bugs\/([^/]+)(?:\/(retry|cancel|progress|artifacts|events))?$/);
      if (path === '/api/bugs' && method === 'GET') {
        const all = this.repo.listBugs(); const status = parsed.searchParams.get('status'); const target = parsed.searchParams.get('target') ?? parsed.searchParams.get('executionTarget'); const query = (parsed.searchParams.get('q') ?? parsed.searchParams.get('search') ?? '').toLowerCase();
        const bugs = all.filter((bug) => (!status || this.statusFor(bug) === status) && (!target || bug.executionTarget === target) && (!query || `${bug.bugKey} ${bug.title}`.toLowerCase().includes(query))).map((bug) => this.dashboardItem(bug));
        send(response, 200, { bugs, items: bugs, total: bugs.length, filters: { status: status ?? null, target: target ?? null, q: query || null } }); return;
      }
      if (bugMatch) { await this.handleBug(bugMatch[1], bugMatch[2], method, response, parsed.searchParams); return; }
      const page = method === 'GET' ? this.pageRenderer?.(path) : undefined;
      if (page !== undefined) { sendPage(response, page); return; }
      send(response, 404, { error: 'Route not found' });
    } catch (error) { this.logger.error(safeLogContext({ path, method, error: error instanceof Error ? error.message : String(error) }), 'request failed'); send(response, error instanceof SyntaxError ? 400 : 500, { error: error instanceof Error ? error.message : String(error) }); }
  }
  private async optionalBody(request: http.IncomingMessage): Promise<Record<string, unknown>> { if (request.method !== 'POST' && request.method !== 'PATCH' && request.method !== 'PUT') return {}; return jsonBody(request); }
  private readDocument(id: string): StoredDocumentSnapshot | null {
    if (!this.documentStore) return null;
    try { return this.documentStore.refresh(id); } catch { return null; }
  }
  private documentResponse(id: string, fallback?: StoredDocumentSnapshot | null): Record<string, unknown> {
    const document = fallback ?? this.readDocument(id);
    return document ? { document } : {};
  }
  private markDocumentConflict(id: string, document: StoredDocumentSnapshot): StoredDocumentSnapshot {
    if (!this.documentStore?.markConflict) return document;
    try { return this.documentStore.markConflict(id, document.revision, document.sha256); } catch (error) {
      // A newer user edit won while conflict metadata was being recorded. Preserve and
      // return that newest snapshot; never attempt to write the stale generated document.
      if (error instanceof DocumentRevisionConflictError) return error.snapshot;
      throw error;
    }
  }
  private async persistGeneratedDocument(id: string, base: StoredDocumentSnapshot, content: string): Promise<StoredDocumentSnapshot> {
    if (content === base.content) return this.documentStore!.markReconciled(id, base.revision, base.sha256);
    const written = this.documentStore!.write(id, content, base.revision);
    return this.documentStore!.markReconciled(id, written.revision, written.sha256);
  }
  /** Shared chat-message pipeline used by both the JSON and the SSE endpoints. */
  private async runMessagePipeline(conversation: BugConversation, body: Record<string, unknown>, content: string, document: StoredDocumentSnapshot | undefined, emit?: SseEmit): Promise<Record<string, unknown>> {
    const id = conversation.id;
    const recentMessages = this.repo.listMessages(id);
    const editFields = [...(this.manualFields.get(id) ?? new Set<string>()), ...(Array.isArray(body.userEditedFields) ? body.userEditedFields.map(String) : [])];
    const onProgress = emit ? (event: IntakeProgressEvent) => {
      if (event.type === 'stage') emit('stage', { stage: event.stage });
      else emit('progress', { chars: event.chars, questions: event.partialQuestions });
    } : undefined;
    let processed!: Awaited<ReturnType<IntakeService['processUserMessage']>>;
    let processingDraft = conversation.draft;
    let persisted = false;
    // LLM/reconciliation work is intentionally outside the document lock. If the reporter
    // edits the document while it is running, retry once from the newly-read snapshot;
    // repeated edits return a conflict and the newest file is never overwritten.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      processed = await this.intake.processUserMessage(processingDraft, recentMessages, content, editFields, document ? { currentDraft: processingDraft, markdown: document.content, documentRevision: document.revision, documentSha256: document.sha256, reconciledSha256: document.reconciledSha256, syncStatus: document.syncStatus } : undefined, onProgress);
      if (processed.documentReconciliation?.conflicts.length) {
        document = document ? this.markDocumentConflict(id, document) : document;
        throw new MessageProcessingError(409, { error: 'DOCUMENT_RECONCILIATION_REQUIRED', code: 'DOCUMENT_RECONCILIATION_REQUIRED', conflicts: processed.documentReconciliation.conflicts, ...this.documentResponse(id, document) });
      }
      if (!document || processed.documentContent === undefined) { persisted = true; break; }
      try { document = await this.persistGeneratedDocument(id, document, processed.documentContent); persisted = true; break; } catch (error) {
        if (!(error instanceof DocumentRevisionConflictError) || attempt === 1) {
          const snapshot = error instanceof DocumentRevisionConflictError ? this.markDocumentConflict(id, error.snapshot) : document;
          throw new MessageProcessingError(409, { error: 'DOCUMENT_REVISION_CONFLICT', code: 'DOCUMENT_REVISION_CONFLICT', document: snapshot });
        }
        document = this.documentStore?.refresh(id);
        if (!document) throw error;
        processingDraft = conversation.draft;
      }
    }
    if (!persisted) throw new MessageProcessingError(409, { error: 'DOCUMENT_REVISION_CONFLICT', code: 'DOCUMENT_REVISION_CONFLICT', ...this.documentResponse(id, document) });
    emit?.('stage', { stage: 'finalizing' });
    this.repo.appendMessage({ conversationId: id, role: 'user', content, metadata: {} });
    this.repo.appendMessage({ conversationId: id, role: 'assistant', content: processed.reply, metadata: { askedFields: processed.turn.questions.map((q) => q.field), turn: processed.turn } });
    const updated = updateConversation(this.repo, id, processed.updatedDraft, processed.completeness, processed.completeness.readyForConfirmation ? 'awaiting_confirmation' : 'active');
    return { ...conversationResponse(this.repo, updated, document), turn: processed.turn, document: document ?? undefined };
  }
  /** SSE variant of the chat pipeline: stage/progress/heartbeat events, then result or error. */
  private async streamMessagePipeline(conversation: BugConversation, body: Record<string, unknown>, content: string, document: StoredDocumentSnapshot | undefined, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const id = conversation.id;
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, idempotency-key', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,OPTIONS' });
    if (typeof response.flushHeaders === 'function') response.flushHeaders();
    let closed = false;
    const emit: SseEmit = (event, data) => {
      if (closed || response.writableEnded || response.destroyed) return;
      try { response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { closed = true; }
    };
    response.once('close', () => { closed = true; });
    const startedAt = Date.now();
    emit('stage', { stage: 'received' });
    const heartbeat = setInterval(() => emit('heartbeat', { elapsedMs: Date.now() - startedAt }), 2_000);
    try {
      const payload = await this.runMessagePipeline(conversation, body, content, document, emit);
      emit('result', payload);
    } catch (error) {
      if (!(error instanceof MessageProcessingError)) this.logger.error(safeLogContext({ path: `/api/bugs/conversations/${id}/messages/stream`, method: 'POST', error: error instanceof Error ? error.message : String(error) }), 'request failed');
      emit('error', error instanceof MessageProcessingError ? { status: error.status, ...error.payload } : { status: 500, error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearInterval(heartbeat);
      if (!closed && !response.writableEnded) response.end();
    }
  }
  private async handleConversation(id: string, action: string | undefined, method: string, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const conversation = this.repo.getConversation(id); if (!conversation) { send(response, 404, { error: 'Conversation not found' }); return; }
    if (!action && method === 'GET') { send(response, 200, conversationResponse(this.repo, conversation, this.readDocument(id))); return; }
    if (action === 'messages' && method === 'POST') {
      const body = await jsonBody(request); const content = typeof body.content === 'string' ? body.content.trim() : ''; if (!content) { send(response, 400, { error: 'content is required' }); return; }
      if (conversation.status === 'submitted') { send(response, 409, { error: 'Conversation has already been submitted' }); return; }
      let document = this.documentStore?.refresh(id);
      if (document && body.documentRevision !== undefined && (!Number.isInteger(body.documentRevision) || Number(body.documentRevision) !== document.revision)) { send(response, 409, { error: 'DOCUMENT_REVISION_CONFLICT', code: 'DOCUMENT_REVISION_CONFLICT', document }); return; }
      try { send(response, 200, await this.runMessagePipeline(conversation, body, content, document)); } catch (error) { if (error instanceof MessageProcessingError) { send(response, error.status, error.payload); return; } throw error; }
      return;
    }
    if (action === 'messages/stream' && method === 'POST') {
      const body = await jsonBody(request); const content = typeof body.content === 'string' ? body.content.trim() : ''; if (!content) { send(response, 400, { error: 'content is required' }); return; }
      if (conversation.status === 'submitted') { send(response, 409, { error: 'Conversation has already been submitted' }); return; }
      let document = this.documentStore?.refresh(id);
      if (document && body.documentRevision !== undefined && (!Number.isInteger(body.documentRevision) || Number(body.documentRevision) !== document.revision)) { send(response, 409, { error: 'DOCUMENT_REVISION_CONFLICT', code: 'DOCUMENT_REVISION_CONFLICT', document }); return; }
      await this.streamMessagePipeline(conversation, body, content, document, request, response);
      return;
    }
    if (action === 'draft' && method === 'GET') { send(response, 200, { draft: conversation.draft, completeness: conversation.completeness, ...this.documentResponse(id) }); return; }
    if (action === 'draft' && (method === 'PATCH' || method === 'POST')) {
      const body = await jsonBody(request); const patch = (body.draft && typeof body.draft === 'object' ? body.draft : body) as BugReportDraft; const edited = Array.isArray(body.userEditedFields) ? body.userEditedFields.map(String) : Object.keys(patch); const fields = this.manualFields.get(id) ?? new Set<string>(); edited.forEach((field) => fields.add(field)); this.manualFields.set(id, fields);
      const draft = mergeDraft(conversation.draft, patch, edited);
      const completeness = evaluateCompleteness(draft); let document = this.documentStore?.refresh(id);
      if (document) { try { document = await this.persistGeneratedDocument(id, document, mergeBugDocument(document.content, draft, completeness)); } catch (error) { if (error instanceof DocumentRevisionConflictError) { send(response, 409, { error: error.code, code: error.code, ...this.documentResponse(id, error.snapshot) }); return; } throw error; } }
      const updated = updateConversation(this.repo, id, draft, completeness); send(response, 200, conversationResponse(this.repo, updated, document)); return;
    }
    if (action === 'document' && method === 'GET') { const document = this.documentStore ? this.documentStore.refresh(id) : null; if (!document) { send(response, 404, { error: 'Document store is unavailable' }); return; } send(response, 200, document); return; }
    if (action === 'document' && method === 'PUT') {
      if (!this.documentStore) { send(response, 501, { error: 'Document store is unavailable' }); return; }
      if (conversation.status === 'submitted') { send(response, 409, { error: 'DOCUMENT_IMMUTABLE', code: 'DOCUMENT_IMMUTABLE' }); return; }
      const body = await jsonBody(request); if (typeof body.content !== 'string' || !Number.isInteger(body.baseRevision)) { send(response, 400, { error: 'content and integer baseRevision are required' }); return; }
      try { send(response, 200, this.documentStore.write(id, body.content, Number(body.baseRevision))); } catch (error) { if (error instanceof DocumentRevisionConflictError) { send(response, 409, { error: error.code, code: error.code, document: error.snapshot }); return; } if (error instanceof DocumentPathError) { send(response, 400, { error: error.message, code: error.code }); return; } throw error; }
      return;
    }
    if (action === 'submit' && method === 'POST') { await this.submit(conversation, request, response); return; }
    send(response, 405, { error: 'Method not allowed' });
  }
  private async submit(conversation: BugConversation, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const existing = this.repo.listBugs().find((bug) => bug.intake.conversationId === conversation.id);
    if (existing) { send(response, 200, { bug: existing, bugKey: existing.bugKey, idempotent: true, ...this.documentResponse(conversation.id) }); return; }
    const body = await jsonBody(request); if (body.confirm !== true && body.confirmed !== true) { send(response, 400, { error: 'Explicit confirmation is required', completeness: conversation.completeness }); return; }
    if (conversation.status === 'submitted') { send(response, 409, { error: 'Conversation has already been submitted' }); return; }
    let document = this.documentStore?.refresh(conversation.id);
    let draft = conversation.draft;
    if (document && (document.sha256 !== document.reconciledSha256 || document.revision !== document.reconciledRevision || document.syncStatus !== 'synced')) {
      const reconciliation = await this.intake.reconcileDocument({ currentDraft: draft, markdown: document.content, documentRevision: document.revision, documentSha256: document.sha256 });
      if (reconciliation.conflicts.length) { document = this.markDocumentConflict(conversation.id, document); send(response, 409, { error: 'DOCUMENT_RECONCILIATION_REQUIRED', code: 'DOCUMENT_RECONCILIATION_REQUIRED', conflicts: reconciliation.conflicts, document }); return; }
      draft = applyDocumentReconciliation(draft, reconciliation);
      try { document = this.documentStore!.markReconciled(conversation.id, document.revision, document.sha256); } catch (error) { if (error instanceof DocumentRevisionConflictError) { send(response, 409, { error: error.code, code: error.code, document: error.snapshot }); return; } throw error; }
    }
    // body.draft remains a compatibility escape hatch for old clients. New clients only send
    // { confirm: true }; their execution state always comes from the reconciled document.
    if (body.draft && typeof body.draft === 'object') {
      draft = mergeDraft(draft, body.draft as BugReportDraft);
      const completenessForDocument = evaluateCompleteness(draft);
      if (document) {
        try { document = await this.persistGeneratedDocument(conversation.id, document, mergeBugDocument(document.content, draft, completenessForDocument)); } catch (error) { if (error instanceof DocumentRevisionConflictError) { send(response, 409, { error: error.code, code: error.code, document: error.snapshot }); return; } throw error; }
      }
    }
    // Intake is authoritative at the submission boundary. Evaluate the same
    // policy used by the conversation pipeline before doing any provisioning
    // or creating a Bug row; a high score alone is not sufficient when a core
    // fact is still missing.
    const completeness = evaluateCompleteness(draft);
    if (!hasGitRepositoryAddress(draft)) {
      const updated = updateConversation(this.repo, conversation.id, draft, completeness, 'active');
      send(response, 422, {
        error: '必须提供项目的 Git 仓库远程地址后才能提交 Bug',
        code: 'GIT_REPOSITORY_REQUIRED',
        status: updated.status,
        completeness,
        draft: updated.draft,
        conversation: conversationResponse(this.repo, updated, this.readDocument(conversation.id)),
        ...this.documentResponse(conversation.id, document),
      });
      return;
    }
    if (!completeness.readyForConfirmation || completeness.score < 65) {
      const updated = updateConversation(this.repo, conversation.id, draft, completeness, 'active');
      send(response, 422, {
        error: '补充所有必填信息后才能提交 Bug',
        code: 'INTAKE_INCOMPLETE',
        status: updated.status,
        completeness,
        draft: updated.draft,
        conversation: conversationResponse(this.repo, updated, this.readDocument(conversation.id)),
        ...this.documentResponse(conversation.id, document),
      });
      return;
    }
    if (this.environments?.provisionProfile && draft.environmentProfile?.repositoryUrl) {
      const target = draft.executionTarget === 'frontend' || draft.executionTarget === 'backend'
        ? draft.executionTarget : draft.environmentProfile.target;
      if (target !== 'frontend' && target !== 'backend') { send(response, 422, { error: '请先确认问题属于前端还是后端，再创建项目运行配置', code: 'ENVIRONMENT_TARGET_REQUIRED' }); return; }
      try {
        const profile = await this.environments.provisionProfile({ ...draft.environmentProfile, target });
        draft = mergeDraft(draft, { executionTarget: profile.target, environmentProfileId: profile.id });
      } catch (error) {
        send(response, 422, { error: error instanceof Error ? error.message : String(error), code: 'REPOSITORY_CLONE_FAILED' }); return;
      }
    }
    const finalCompleteness = evaluateCompleteness(draft); const user = this.repo.getUser(conversation.reporterId); if (!user) { send(response, 500, { error: 'Reporter not found' }); return; }
    if (this.environments?.resolveProfile) {
      if (!draft.environmentProfileId) { send(response, 422, { error: '请提供项目的 Git 仓库远程地址，或选择已有项目配置后再提交', code: 'ENVIRONMENT_PROFILE_REQUIRED', environments: this.environments.listProfiles() }); return; }
      try { this.environments.resolveProfile(draft.executionTarget ?? 'unknown', draft.environmentProfileId); }
      catch (error) { send(response, 422, { error: error instanceof Error ? error.message : String(error), code: 'ENVIRONMENT_PROFILE_INVALID', environments: this.environments.listProfiles() }); return; }
    }
    const title = normalizeBugTitle(draft);
    if (!title) { send(response, 422, { error: '无法根据项目/模块和问题现象生成有效标题', code: 'INVALID_BUG_TITLE' }); return; }
    draft = mergeDraft(draft, { title });
    const environment = { environmentName: draft.environment?.environmentName ?? null, appVersion: draft.environment?.appVersion ?? null, buildNumber: draft.environment?.buildNumber ?? null, commitSha: draft.environment?.commitSha ?? null, ...(draft.environment?.frontend ? { frontend: { route: draft.environment.frontend.route ?? null, browser: draft.environment.frontend.browser ?? null, browserVersion: draft.environment.frontend.browserVersion ?? null, os: draft.environment.frontend.os ?? null, resolution: draft.environment.frontend.resolution ?? null } } : {}), ...(draft.environment?.backend ? { backend: { service: draft.environment.backend.service ?? null, endpoint: draft.environment.backend.endpoint ?? null, method: draft.environment.backend.method ?? null, statusCode: draft.environment.backend.statusCode ?? null } } : {}), additionalInfo: draft.environment?.additionalInfo ?? {} };
    const evidence = { errorMessages: draft.evidence?.errorMessages ?? [], stackTraces: draft.evidence?.stackTraces ?? [], logs: draft.evidence?.logs ?? [], screenshots: draft.evidence?.screenshots ?? [], videos: draft.evidence?.videos ?? [], networkTraces: draft.evidence?.networkTraces ?? [], jsonFiles: draft.evidence?.jsonFiles ?? [], otherFiles: draft.evidence?.otherFiles ?? [] };
    const impact = { affectedUsers: draft.impact?.affectedUsers ?? null, scope: draft.impact?.scope ?? 'unknown', blocksTesting: draft.impact?.blocksTesting ?? null, workaroundExists: draft.impact?.workaroundExists ?? null, workaround: draft.impact?.workaround ?? null };
    const regression = { isRegression: draft.regression?.isRegression ?? null, lastKnownGoodVersion: draft.regression?.lastKnownGoodVersion ?? null, suspectedVersion: draft.regression?.suspectedVersion ?? null };
    const report = BugReportSchema.parse({ id: newId(), bugKey: `BUG-${Date.now()}`, title, productArea: draft.productArea ?? null, component: draft.component ?? null, bugType: draft.bugType ?? 'unknown', executionTarget: draft.executionTarget ?? 'unknown', environmentProfileId: draft.environmentProfileId ?? null, severity: draft.severity ?? 'unknown', actualBehavior: draft.actualBehavior ?? 'Not provided', expectedBehavior: draft.expectedBehavior ?? null, reproduction: { reproducible: draft.reproduction?.reproducible ?? null, frequency: draft.reproduction?.frequency ?? 'unknown', prerequisites: draft.reproduction?.prerequisites ?? [], steps: draft.reproduction?.steps ?? [], testData: draft.reproduction?.testData ?? [] }, environment, evidence, impact, regression, observations: draft.observations ?? [], reporterHypotheses: draft.reporterHypotheses ?? [], reporter: { userId: user.id, displayName: user.displayName }, intake: { completenessScore: finalCompleteness.score, confidence: 0.5, missingInformation: finalCompleteness.missingCriticalInformation, conversationId: conversation.id, llmSummary: draft.actualBehavior ?? '' }, createdAt: now(), updatedAt: now() });
    const created = this.repo.createBug({ ...report, id: undefined, bugKey: undefined } as unknown as Parameters<BugRepository['createBug']>[0]); const afterSubmit = (() => { try { return this.repo.changeBugStatus(created.bugKey, 'COLLECTING'); } catch { return created; } })();
    let final = afterSubmit; let finalStatus: string = 'DRAFT'; try { final = this.repo.changeBugStatus(created.bugKey, 'READY_FOR_CONFIRMATION'); finalStatus = 'READY_FOR_CONFIRMATION'; final = this.repo.changeBugStatus(created.bugKey, 'SUBMITTED'); finalStatus = 'SUBMITTED'; final = this.repo.changeBugStatus(created.bugKey, 'TRIAGING'); finalStatus = 'TRIAGING'; final = this.repo.changeBugStatus(created.bugKey, 'QUEUED'); finalStatus = 'QUEUED'; } catch { /* repositories may expose a reduced state machine */ }
    let job: unknown = null; if (finalStatus === 'QUEUED' && this.queue) job = this.queue.enqueueJob(final.id, final.bugKey);
    updateConversation(this.repo, conversation.id, draft, finalCompleteness, 'submitted'); send(response, 201, { bug: final, bugKey: final.bugKey, status: finalStatus, job, completeness: finalCompleteness, ...this.documentResponse(conversation.id, document) });
  }
  private async handleBug(id: string, action: string | undefined, method: string, response: http.ServerResponse, searchParams?: URLSearchParams): Promise<void> {
    const bug = this.repo.getBug(id); if (!bug) { send(response, 404, { error: 'Bug report not found' }); return; }
    if (!action && method === 'GET') { send(response, 200, this.detailFor(bug)); return; }
    if (action === 'progress' && method === 'GET') { const jobs = this.jobsFor(bug); send(response, 200, { bugKey: bug.bugKey, status: this.statusFor(bug), jobs, latest: jobs.at(-1) ?? null }); return; }
    if (action === 'events' && method === 'GET') {
      const query = this.parseWorkerEventQuery(searchParams ?? new URLSearchParams());
      if ('error' in query) { send(response, 400, { error: query.error }); return; }
      send(response, 200, this.workerEventsResponse(bug, query)); return;
    }
    if (action === 'artifacts' && method === 'GET') { const artifacts = this.artifactsFor(bug.bugKey); send(response, 200, { bugKey: bug.bugKey, files: Object.keys(artifacts), artifacts }); return; }
    if (action === 'cancel' && method === 'POST') { this.cancelBug(bug, response); return; }
    if (action === 'retry' && method === 'POST') { this.retryBug(bug, response); return; }
    send(response, 405, { error: 'Method not allowed' });
  }

  private isReady(): boolean { try { this.repo.listBugs(); return true; } catch { return false; } }
  private jobsFor(bug: { id: string }): QueueJobLike[] {
    const listed = this.queue?.listJobs?.();
    if (listed) return listed.filter((job) => job.bugId === bug.id);
    // The standalone API is also used without a queue adapter (for example
    // during recovery). Read the durable row so an INTERRUPTED job is still
    // visible instead of accidentally looking like there is no job.
    const database = (this.repo as unknown as { database?: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } } }).database;
    if (!database) return [];
    try {
      return (database.prepare('SELECT * FROM jobs WHERE bug_id = ? ORDER BY created_at ASC').all(bug.id) as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id), bugId: String(row.bug_id), status: String(row.status), priority: Number(row.priority ?? 0), attempt: Number(row.attempt ?? 0),
        createdAt: String(row.created_at), startedAt: row.started_at == null ? null : String(row.started_at), finishedAt: row.finished_at == null ? null : String(row.finished_at),
        heartbeatAt: row.heartbeat_at == null ? null : String(row.heartbeat_at), error: row.error == null ? null : String(row.error), workerId: row.worker_id == null ? null : String(row.worker_id),
      }));
    } catch { return []; }
  }
  private statusFor(bug: any): string { if (typeof bug.status === 'string') return bug.status; const database = (this.repo as unknown as { database?: { prepare: (sql: string) => { get: (...args: string[]) => unknown } } }).database; if (!database) return 'DRAFT'; const row = database.prepare('SELECT status FROM bug_reports WHERE id = ? OR bug_key = ?').get(bug.id, bug.bugKey) as { status?: string } | undefined; return row?.status ?? 'DRAFT'; }
  private dashboardItem(bug: any): Record<string, unknown> { const jobs = this.jobsFor(bug); const latest = jobs.at(-1); const git = this.artifactsFor(bug.bugKey)['git-result.json'] as { branch?: string | null } | undefined; const branch = git?.branch ?? null; return { ...bug, key: bug.bugKey, target: bug.executionTarget, status: this.statusFor(bug), completeness: bug.intake?.completenessScore ?? 0, created: bug.createdAt, fixBranch: branch, branch, job: latest ?? null, jobStatus: latest?.status ?? null }; }

  private parseWorkerEventQuery(params: URLSearchParams): { after: number; before?: number; limit: number } | { error: string } {
    const readCursor = (name: string): number | undefined | string => {
      const raw = params.get(name);
      if (raw === null || raw === '') return undefined;
      if (!/^\d+$/.test(raw)) return `${name} must be a non-negative integer`;
      const value = Number(raw);
      return Number.isSafeInteger(value) ? value : `${name} is too large`;
    };
    const after = readCursor('after'); if (typeof after === 'string') return { error: after };
    const before = readCursor('before'); if (typeof before === 'string') return { error: before };
    const rawLimit = params.get('limit');
    const limit = rawLimit === null || rawLimit === '' ? 100 : Number(rawLimit);
    if (!/^\d+$/.test(rawLimit ?? '100') || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return { error: 'limit must be an integer between 1 and 100' };
    if (after !== undefined && before !== undefined) return { error: 'after and before cannot be used together' };
    return { after: after ?? 0, ...(before === undefined ? {} : { before }), limit };
  }

  private workerEventsResponse(bug: { id: string }, query: { after: number; before?: number; limit: number }): Record<string, unknown> {
    const events = this.listWorkerEvents(bug.id, query);
    const last = events.at(-1)?.sequence ?? query.after;
    const first = events[0]?.sequence ?? query.before ?? 0;
    return {
      events,
      // Cursors are numeric and scoped to this bug.  A client can use
      // nextAfter for polling and firstSequence as `before` for history.
      nextAfter: last,
      firstSequence: first,
      hasMore: events.length >= query.limit,
    };
  }

  private listWorkerEvents(bugId: string, query: { after: number; before?: number; limit: number }): WorkerEventLike[] {
    const repositoryQuery = query.before === undefined ? query : { before: query.before, limit: query.limit };
    return this.normalizeWorkerEvents(this.repo.listWorkerEvents(bugId, repositoryQuery));
  }

  private normalizeWorkerEvents(value: unknown): WorkerEventLike[] {
    if (!Array.isArray(value)) return [];
    return value.map((entry, index) => {
      const row = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
      const number = (keys: string[]): number | null => { const candidate = keys.map((key) => row[key]).find((item) => typeof item === 'number' || (typeof item === 'string' && /^\d+$/.test(item))); return candidate === undefined ? null : Number(candidate); };
      const string = (keys: string[], fallback: string): string => { const candidate = keys.map((key) => row[key]).find((item) => typeof item === 'string'); return candidate === undefined ? fallback : candidate; };
      const sequence = number(['sequence', 'seq', 'eventSequence', 'event_seq']) ?? index + 1;
      return {
        sequence,
        occurredAt: string(['occurredAt', 'createdAt', 'timestamp', 'occurred_at'], now()),
        role: string(['role', 'agentRole', 'agent_role'], 'worker'),
        eventType: string(['eventType', 'type', 'event_type'], 'event'),
        tool: (() => { const item = ['tool', 'toolName', 'tool_name'].map((key) => row[key]).find((candidate) => typeof candidate === 'string'); return item === undefined ? null : item; })(),
        isError: row.isError === true || row.isError === 1 || row.isError === 'true' || row.isError === '1' || row.is_error === true || row.is_error === 1 || row.is_error === 'true' || row.is_error === '1' || row.error === true || row.error === 1 || row.error === 'true' || row.error === '1',
        turnIndex: number(['turnIndex', 'turn', 'turn_index']),
        toolCallCount: number(['toolCallCount', 'toolCalls', 'tool_call_count', 'tool_calls']),
        summary: string(['summary', 'message', 'detail'], ''),
        jobId: (() => { const item = row.jobId ?? row.job_id; return typeof item === 'string' ? item : null; })(),
      };
    });
  }
  private detailFor(bug: any): Record<string, unknown> {
    const jobs = this.jobsFor(bug); let conversation: BugConversation | null = null; let messages: unknown[] = []; if (bug.intake?.conversationId) { conversation = this.repo.getConversation(bug.intake.conversationId); if (conversation) messages = this.repo.listMessages(conversation.id); }
    const document = (() => {
      if (bug.intake?.conversationId) { const snapshot = this.readDocument(bug.intake.conversationId); if (snapshot) return snapshot; }
      return conversation ? { content: mergeBugDocument('', conversation.draft ?? {}, conversation.completeness), revision: null, sha256: null, syncStatus: 'generated' } : null;
    })();
    const attachments = (() => { try { return this.repo.listAttachments(bug.bugKey); } catch { return []; } })();
    const artifactData = this.artifactsFor(bug.bugKey); const git = artifactData['git-result.json']; const status = this.statusFor(bug); const publicBug = { ...bug, status };
    return { bug: publicBug, key: bug.bugKey, title: bug.title, summary: bug.intake?.llmSummary ?? bug.actualBehavior, profile: bug.environmentProfileId, target: bug.executionTarget, document, reproduction: bug.reproduction, environment: bug.environment, evidence: bug.evidence, attachments, conversation, messages, completeness: bug.intake?.completenessScore ?? 0, progress: { status, jobs }, fix: artifactData['agent-result.json'] ?? null, validation: artifactData['validation.json'] ?? null, review: artifactData['review.json'] ?? null, branch: (git as { branch?: string | null } | undefined)?.branch ?? null, commit: (git as { commitSha?: string | null } | undefined)?.commitSha ?? null, artifacts: Object.keys(artifactData), status };
  }
  private artifactsFor(bugKey: string): Record<string, unknown> {
    const root = typeof this.apiConfig.DATA_ROOT === 'string' ? this.apiConfig.DATA_ROOT : 'data'; const dir = path.resolve(root, 'agent-results', bugKey); const result: Record<string, unknown> = {};
    try { for (const filename of fs.readdirSync(dir)) { if (!/^(bug|fix-task|environment|agent-result|candidate(?:-used)?|validation|review|git-result|pipeline)\.json$|^diff\.patch$/.test(filename)) continue; const full = path.join(dir, filename); const stat = fs.statSync(full); if (!stat.isFile() || stat.size > 2_000_000) continue; const content = fs.readFileSync(full, 'utf8'); result[filename] = filename.endsWith('.json') ? JSON.parse(content) : content; } } catch { /* artifacts are optional until a worker starts */ }
    return result;
  }
  private cancelBug(bug: any, response: http.ServerResponse): void {
    const jobs = this.jobsFor(bug); const running = jobs.find((job) => job.status === 'RUNNING'); const queued = jobs.find((job) => job.status === 'QUEUED');
    const status = this.statusFor(bug); const safeBug = ['QUEUED', 'NEEDS_INFO', 'PREPARING_ENV', 'FIXING'].includes(status);
    // A running queue row alone is not enough: VALIDATING/REVIEWING/PUSHING
    // are deliberately not cancellable, so never report a state the DB did
    // not accept.
    if (!safeBug) { send(response, 409, { error: `Bug ${bug.bugKey} is not safely cancellable`, status, cancellable: false }); return; }
    let job: unknown = null;
    try { if ((running || queued) && this.queue?.cancelJob) job = this.queue.cancelJob((running ?? queued)!.id); } catch (error) { send(response, 409, { error: error instanceof Error ? error.message : String(error), status, cancellable: false }); return; }
    let updated = bug;
    try { updated = this.repo.changeBugStatus(bug.bugKey, 'CANCELLED', 'manual_cancel'); } catch (error) { send(response, 409, { error: error instanceof Error ? error.message : String(error), status, cancellable: false }); return; }
    send(response, 200, { bug: { ...updated, status: 'CANCELLED' }, job, cancelled: true, status: 'CANCELLED', semantic: running ? 'interrupt_requested' : 'removed_from_queue' });
  }
  private retryBug(bug: any, response: http.ServerResponse): void {
    const status = this.statusFor(bug); const failedStatuses = ['FIX_FAILED', 'FIX_CANDIDATE', 'ENVIRONMENT_FAILED', 'VALIDATION_FAILED', 'REVIEW_REJECTED', 'PUSH_FAILED', 'BLOCKED']; const jobs = this.jobsFor(bug); const candidate = [...jobs].reverse().find((job) => job.status === 'FAILED' || job.status === 'INTERRUPTED');
    if (!failedStatuses.includes(status) && !candidate) { send(response, 409, { error: 'Manual retry is only available for a failed or interrupted job', status, retryable: false }); return; }
    let job: unknown = null; if (candidate && this.queue?.retryJob) job = this.queue.retryJob(candidate.id);
    let updated = bug; if (failedStatuses.includes(status)) { try { updated = this.repo.changeBugStatus(bug.bugKey, 'QUEUED', 'manual_retry'); } catch { /* queue retry is still returned */ } }
    if (!candidate && this.queue) job = this.queue.enqueueJob(updated.id, updated.bugKey);
    send(response, 200, { bug: { ...updated, status: failedStatuses.includes(status) ? 'QUEUED' : status }, job, retried: true, automatic: false });
  }
}
