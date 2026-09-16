import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId } from '@llmbugfix/shared';
import { openDatabase, SQLiteBugRepository } from '@llmbugfix/bug-repository';
import { JobQueue } from '@llmbugfix/job-queue';
import { FakeIntakeModel, IntakeService, type DocumentReconciliationInput, type IntakeModel, type IntakeModelInput, type IntakeTurnResult } from '@llmbugfix/intake-agent';
import { BugApiServer } from './index.js';
import { resolveWebRoute } from '../../bug-web/src/index.js';

describe('Bug API routes', () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: SQLiteBugRepository;
  let server: BugApiServer;
  const userId = newId();

  beforeEach(() => {
    db = openDatabase(':memory:');
    repository = new SQLiteBugRepository(db);
    repository.createUser({ id: userId, displayName: 'QA Tester', email: 'tester@internal.local' });
    server = new BugApiServer({}, repository, new IntakeService(new FakeIntakeModel()));
  });
  afterEach(() => db.close());

  it('creates, interviews, patches and explicitly submits a conversation', async () => {
    const created = await server.inject<{ id: string }>({ method: 'POST', url: '/api/bugs/conversations', body: { reporterId: userId } });
    expect(created.status).toBe(201);
    const id = created.data.id;

    const message = await server.inject<{ turn: { questions: unknown[] } }>({ method: 'POST', url: `/api/bugs/conversations/${id}/messages`, body: { content: '前端登录按钮点击无响应，页面提示错误' } });
    expect(message.status, message.raw).toBe(200);
    expect(message.data.turn.questions.length).toBeLessThanOrEqual(3);

    const patched = await server.inject<{ draft: { executionTarget: string } }>({ method: 'PATCH', url: `/api/bugs/conversations/${id}/draft`, body: { draft: { title: '用户登录异常', executionTarget: 'frontend', actualBehavior: '登录按钮一直 loading', expectedBehavior: '跳转首页' } } });
    expect(patched.status).toBe(200);
    expect(patched.data.draft.executionTarget).toBe('frontend');

    const rejected = await server.inject<{ code: string; completeness: { score: number; readyForConfirmation: boolean }; draft: Record<string, unknown> }>({ method: 'POST', url: `/api/bugs/conversations/${id}/submit`, body: { confirm: true } });
    expect(rejected.status, rejected.raw).toBe(422);
    expect(rejected.data.code).toBe('GIT_REPOSITORY_REQUIRED');
    expect(rejected.data.completeness.readyForConfirmation).toBe(false);
    expect(rejected.data.completeness.score).toBeLessThan(65);
    expect(rejected.data.draft).toMatchObject({ actualBehavior: '登录按钮一直 loading' });
    expect(repository.getConversation(id)?.status).toBe('active');
    expect(repository.listBugs()).toHaveLength(0);

    await server.inject({ method: 'PATCH', url: `/api/bugs/conversations/${id}/draft`, body: { draft: { component: 'login', environmentProfile: { name: 'storefront', repositoryUrl: 'https://git.example.test/team/storefront.git' } } } });
    const submitted = await server.inject<{ bugKey: string; status: string; bug: { title: string } }>({ method: 'POST', url: `/api/bugs/conversations/${id}/submit`, body: { confirmed: true } });
    expect(submitted.status, submitted.raw).toBe(201);
    expect(submitted.data.bugKey).toMatch(/^BUG-\d{6}$/);
    expect(submitted.data.status).toBe('QUEUED');
    expect(submitted.data.bug.title).toBe('[storefront]-[用户登录异常]');

    const list = await server.inject<{ bugs: unknown[] }>({ url: '/api/bugs' });
    expect(list.status).toBe(200);
    expect(list.data.bugs).toHaveLength(1);
    expect((list.data.bugs[0] as { status: string; key: string; completeness: number }).status).toBe('QUEUED');
    expect((list.data.bugs[0] as { key: string }).key).toMatch(/^BUG-/);
    const filtered = await server.inject<{ bugs: unknown[] }>({ url: '/api/bugs?target=frontend&status=QUEUED' });
    expect(filtered.data.bugs).toHaveLength(1);
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-api-dashboard-')); const artifactDir = path.join(artifactRoot, 'agent-results', submitted.data.bugKey); fs.mkdirSync(artifactDir, { recursive: true }); fs.writeFileSync(path.join(artifactDir, 'git-result.json'), JSON.stringify({ success: false, branch: `ai/${submitted.data.bugKey}-login-fix`, commitSha: null, mergeRequestUrl: null, pushed: false, error: 'DRY_RUN' }));
    const dashboardServer = new BugApiServer({ DATA_ROOT: artifactRoot }, repository, new IntakeService(new FakeIntakeModel()));
    const dashboardList = await dashboardServer.inject<{ bugs: Array<{ fixBranch: string | null; branch: string | null }> }>({ url: '/api/bugs' });
    expect(dashboardList.data.bugs[0]).toMatchObject({ fixBranch: `ai/${submitted.data.bugKey}-login-fix`, branch: `ai/${submitted.data.bugKey}-login-fix` });
    const detail = await server.inject<{ bug: { status: string }; progress: { status: string }; messages: unknown[]; document: { content: string } }>({ url: `/api/bugs/${submitted.data.bugKey}` });
    expect(detail.status).toBe(200);
    expect(detail.data.bug.status).toBe('QUEUED');
    expect(detail.data.progress.status).toBe('QUEUED');
    expect(detail.data.messages.length).toBeGreaterThan(0);
    expect(detail.data.document.content).toMatch(/^# /u);
    const job = repository.enqueueJob(submitted.data.bugKey);
    repository.appendWorkerEvent({ bugId: submitted.data.bugKey, jobId: job.id, role: 'fixer', eventType: 'tool_execution_start', tool: 'bash', summary: 'pnpm test' });
    const events = await server.inject<{ events: Array<{ sequence: number; tool: string; summary: string }>; nextAfter: number }>({ url: `/api/bugs/${submitted.data.bugKey}/events?before=9007199254740991&limit=10` });
    expect(events.status, events.raw).toBe(200);
    expect(events.data.events).toMatchObject([{ sequence: 1, tool: 'bash', summary: 'pnpm test' }]);
    expect(events.data.nextAfter).toBe(1);
    expect((await server.inject({ url: `/api/bugs/${submitted.data.bugKey}/events?after=-1` })).status).toBe(400);
    expect((await server.inject({ url: `/api/bugs/${submitted.data.bugKey}/events?limit=101` })).status).toBe(400);
    expect((await server.inject({ url: '/api/health/live' })).status).toBe(200);
    expect((await server.inject({ url: '/api/health/ready' })).status).toBe(200);
    const cancelled = await server.inject<{ bug: { status: string }; semantic: string }>({ method: 'POST', url: `/api/bugs/${submitted.data.bugKey}/cancel` });
    expect(cancelled.status, cancelled.raw).toBe(200);
    expect(cancelled.data.bug.status).toBe('CANCELLED');
    expect(cancelled.data.semantic).toBe('removed_from_queue');
    expect((await server.inject({ method: 'POST', url: `/api/bugs/${submitted.data.bugKey}/retry` })).status).toBe(409);
  });

  it('creates and submits a development task without bug reproduction fields', async () => {
    const created = await server.inject<{ id: string; draft: { taskType: string } }>({ method: 'POST', url: '/api/bugs/conversations', body: { reporterId: userId, taskType: 'development' } });
    expect(created.data.draft.taskType).toBe('development');
    await server.inject({ method: 'PATCH', url: `/api/bugs/conversations/${created.data.id}/draft`, body: { draft: { objective: 'Add CSV export', requirements: ['Export filtered rows'], acceptanceCriteria: ['Clicking Export downloads the filtered rows'], component: 'orders', executionTarget: 'frontend', environmentProfile: { name: 'orders-web', repositoryUrl: 'https://git.example.test/orders-web.git' } } } });
    const submitted = await server.inject<{ bug: { taskType: string; objective: string; actualBehavior: string } }>({ method: 'POST', url: `/api/bugs/conversations/${created.data.id}/submit`, body: { confirmed: true } });
    expect(submitted.status, submitted.raw).toBe(201);
    expect(submitted.data.bug).toMatchObject({ taskType: 'development', objective: 'Add CSV export', actualBehavior: '' });
  });

  it('does not claim cancellation for a state outside the cancellation transitions', async () => {
    const created = await server.inject<{ id: string }>({ method: 'POST', url: '/api/bugs/conversations', body: { reporterId: userId } });
    await server.inject({ method: 'PATCH', url: `/api/bugs/conversations/${created.data.id}/draft`, body: { draft: { title: 'validation cancellation', actualBehavior: 'broken', expectedBehavior: 'works', executionTarget: 'frontend', component: 'login', environmentProfile: { name: 'storefront', repositoryUrl: 'https://git.example.test/team/storefront.git' } } } });
    const submitted = await server.inject<{ bugKey: string }>({ method: 'POST', url: `/api/bugs/conversations/${created.data.id}/submit`, body: { confirm: true } });
    const repository = (server as unknown as { repo: SQLiteBugRepository }).repo;
    // Submit already leaves a valid Bug in QUEUED; advance only through the
    // legal worker states before asserting that VALIDATING is not cancellable.
    for (const status of ['PREPARING_ENV', 'FIXING', 'VALIDATING'] as const) repository.changeBugStatus(submitted.data.bugKey, status);
    const cancelled = await server.inject<{ status: string; cancellable: boolean }>({ method: 'POST', url: `/api/bugs/${submitted.data.bugKey}/cancel` });
    expect(cancelled.status).toBe(409); expect(cancelled.data.cancellable).toBe(false);
    expect((await server.inject<{ status: string }>({ url: `/api/bugs/${submitted.data.bugKey}/progress` })).data.status).toBe('VALIDATING');
  });

  it('rejects an unapproved project/profile before creating an executable bug', async () => {
    const repo = new SQLiteBugRepository(db);
    const protectedServer = new BugApiServer({}, {
      repo,
      intake: new IntakeService(new FakeIntakeModel()),
      environments: {
        listProfiles: () => [{ id: 'frontend-main', name: 'Frontend', target: 'frontend' }],
        resolveProfile: (_target: string, profileId?: string) => { if (profileId !== 'frontend-main') throw new Error('profile is not approved'); return {}; },
      },
    });
    const created = await protectedServer.inject<{ id: string }>({ method: 'POST', url: '/api/bugs/conversations', body: { reporterId: userId } });
    await protectedServer.inject({ method: 'PATCH', url: `/api/bugs/conversations/${created.data.id}/draft`, body: { draft: { title: 'bad mapping', actualBehavior: 'broken', expectedBehavior: 'works', executionTarget: 'frontend', environmentProfileId: '/tmp/reporter-path', environmentProfile: { repositoryUrl: 'https://git.example.test/team/storefront.git' } } } });
    const submitted = await protectedServer.inject<{ code: string }>({ method: 'POST', url: `/api/bugs/conversations/${created.data.id}/submit`, body: { confirm: true } });
    expect(submitted.status).toBe(422);
    expect(submitted.data.code).toBe('ENVIRONMENT_PROFILE_INVALID');
    expect(repo.listBugs()).toHaveLength(0);
  });

  it('creates a generated profile from a confirmed remote-repository proposal', async () => {
    const repo = new SQLiteBugRepository(db); const provisioned: unknown[] = [];
    const dynamicServer = new BugApiServer({}, {
      repo,
      intake: new IntakeService(new FakeIntakeModel()),
      environments: {
        listProfiles: () => [],
        provisionProfile: async (proposal) => { provisioned.push(proposal); return { id: 'remote-1234567890abcdef', target: proposal.target }; },
        resolveProfile: (target, id) => { if (target !== 'frontend' || id !== 'remote-1234567890abcdef') throw new Error('generated profile not found'); return {}; },
      },
    });
    const created = await dynamicServer.inject<{ id: string }>({ method: 'POST', url: '/api/bugs/conversations', body: { reporterId: userId } });
    await dynamicServer.inject({ method: 'PATCH', url: `/api/bugs/conversations/${created.data.id}/draft`, body: { draft: { title: 'generated profile', actualBehavior: 'button is stuck', expectedBehavior: 'button works', executionTarget: 'frontend', environmentProfile: { name: 'Storefront', repositoryUrl: 'https://git.example.test/team/storefront.git', target: 'frontend' } } } });
    const submitted = await dynamicServer.inject<{ bug: { environmentProfileId: string; executionTarget: string } }>({ method: 'POST', url: `/api/bugs/conversations/${created.data.id}/submit`, body: { confirm: true } });
    expect(submitted.status, submitted.raw).toBe(201); expect(submitted.data.bug.environmentProfileId).toBe('remote-1234567890abcdef'); expect(submitted.data.bug.executionTarget).toBe('frontend');
    expect(provisioned).toEqual([expect.objectContaining({ repositoryUrl: 'https://git.example.test/team/storefront.git', target: 'frontend' })]);
  });

  it('keeps an incomplete intake active, then creates one queued Bug and one Job after supplementation', async () => {
    const queue = new JobQueue(repository, fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-api-queue-')));
    const queuedServer = new BugApiServer({}, { repo: repository, intake: new IntakeService(new FakeIntakeModel()), queue });
    const created = await queuedServer.inject<{ id: string }>({ method: 'POST', url: '/api/bugs/conversations', body: { reporterId: userId } });
    const id = created.data.id;
    await queuedServer.inject({ method: 'PATCH', url: `/api/bugs/conversations/${id}/draft`, body: { draft: { actualBehavior: '按钮卡住', expectedBehavior: '正常跳转', component: 'login', environmentProfileId: 'remote-existing-profile' } } });
    const rejected = await queuedServer.inject<{ code: string; completeness: { score: number; missingCriticalInformation: string[] }; conversation: { status: string } }>({ method: 'POST', url: `/api/bugs/conversations/${id}/submit`, body: { confirm: true } });
    expect(rejected.status, rejected.raw).toBe(422);
    expect(rejected.data.code).toBe('GIT_REPOSITORY_REQUIRED');
    expect(rejected.data.completeness.missingCriticalInformation).toContain('environmentProfile.repositoryUrl');
    expect(rejected.data.completeness.score).toBeLessThan(65);
    expect(rejected.data.conversation.status).toBe('active');
    expect(repository.listBugs()).toHaveLength(0);
    expect(queue.listJobs()).toHaveLength(0);

    const supplemented = await queuedServer.inject({ method: 'PATCH', url: `/api/bugs/conversations/${id}/draft`, body: { draft: { environmentProfile: { name: 'storefront', repositoryUrl: 'https://git.example.test/team/storefront.git' } } } });
    expect(supplemented.status, supplemented.raw).toBe(200);
    const submitted = await queuedServer.inject<{ bugKey: string; status: string; job: { id: string } }>({ method: 'POST', url: `/api/bugs/conversations/${id}/submit`, body: { confirm: true } });
    expect(submitted.status, submitted.raw).toBe(201);
    expect(submitted.data.status).toBe('QUEUED');
    expect(submitted.data.job?.id).toBeTruthy();
    expect(repository.listBugs()).toHaveLength(1);
    expect(queue.listJobs()).toHaveLength(1);

    const repeated = await queuedServer.inject<{ bugKey: string; idempotent: boolean }>({ method: 'POST', url: `/api/bugs/conversations/${id}/submit`, body: { confirm: true } });
    expect(repeated.status, repeated.raw).toBe(200);
    expect(repeated.data.idempotent).toBe(true);
    expect(repeated.data.bugKey).toBe(submitted.data.bugKey);
    expect(repository.listBugs()).toHaveLength(1);
    expect(queue.listJobs()).toHaveLength(1);
  });

  it('keeps Chat and editable Markdown synchronized through revisioned reconciliation', async () => {
    const created = await server.inject<{ id: string; document: { content: string; revision: number; sha256: string } }>({ method: 'POST', url: '/api/bugs/conversations', body: { reporterId: userId } });
    const id = created.data.id; expect(created.data.document.content).toContain('## Actual Behavior');
    const first = await server.inject<{ document: { content: string; revision: number; sha256: string }; draft: { actualBehavior?: string } }>({ method: 'POST', url: `/api/bugs/conversations/${id}/messages`, body: { content: '前端登录页面点击登录后停留在原页面，正常应该进入首页。' } });
    expect(first.status, first.raw).toBe(200); expect(first.data.document.revision).toBeGreaterThan(created.data.document.revision); expect(first.data.document.content).toContain('停留在原页面');
    const edited = first.data.document.content.replace(/(## Actual Behavior\n)[^\n]+/u, '$1页面显示白屏');
    const saved = await server.inject<{ revision: number; syncStatus: string }>({ method: 'PUT', url: `/api/bugs/conversations/${id}/document`, body: { content: edited, baseRevision: first.data.document.revision } });
    expect(saved.status, saved as unknown as string).toBe(200); expect(saved.data.syncStatus).toBe('dirty');
    const staleMessage = await server.inject<{ code: string; document: { revision: number } }>({ method: 'POST', url: `/api/bugs/conversations/${id}/messages`, body: { content: '这条消息来自旧页面版本。', documentRevision: first.data.document.revision } });
    expect(staleMessage.status).toBe(409); expect(staleMessage.data.code).toBe('DOCUMENT_REVISION_CONFLICT'); expect(staleMessage.data.document.revision).toBe(saved.data.revision);
    const reconciled = await server.inject<{ document: { content: string; syncStatus: string }; draft: { actualBehavior?: string } }>({ method: 'POST', url: `/api/bugs/conversations/${id}/messages`, body: { content: '补充：这个问题每次都能复现。' } });
    expect(reconciled.status, reconciled.raw).toBe(200); expect(reconciled.data.draft.actualBehavior).toContain('页面显示白屏'); expect(reconciled.data.document.syncStatus).toBe('synced');
    await server.inject({ method: 'PATCH', url: `/api/bugs/conversations/${id}/draft`, body: { draft: { component: 'login', environmentProfile: { name: 'storefront', repositoryUrl: 'https://git.example.test/team/storefront.git' } } } });
    const submitted = await server.inject<{ document: { syncStatus: string }; bugKey: string }>({ method: 'POST', url: `/api/bugs/conversations/${id}/submit`, body: { confirm: true } });
    expect(submitted.status, submitted.raw).toBe(201); expect(submitted.data.bugKey).toMatch(/^BUG-/); expect(submitted.data.document.syncStatus).toBe('synced');
  });

  it('detects an external Markdown filesystem edit on the next message', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-api-'));
    try {
      const localServer = new BugApiServer({ DATA_ROOT: root }, new SQLiteBugRepository(db), new IntakeService(new FakeIntakeModel()));
      const created = await localServer.inject<{ id: string; document: { revision: number } }>({ method: 'POST', url: '/api/bugs/conversations', body: { reporterId: userId } });
      const filename = path.join(root, 'intake-documents', created.data.id, 'bug-report.md'); fs.writeFileSync(filename, '# 外部修改\n\n## Actual Behavior\n外部文件事实\n');
      const response = await localServer.inject<{ draft: { actualBehavior?: string }; document: { revision: number } }>({ method: 'POST', url: `/api/bugs/conversations/${created.data.id}/messages`, body: { content: '继续补充信息。' } });
      expect(response.status, response.raw).toBe(200); expect(response.data.draft.actualBehavior).toBe('外部文件事实');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('persists reconciliation conflicts and refuses submit until the document is fixed', async () => {
    const conflictIntake = new IntakeService(new FakeIntakeModel(), { reconcile: (_input: DocumentReconciliationInput) => ({ fieldUpdates: {}, explicitClears: [], conflicts: [{ field: 'actualBehavior', reason: 'ambiguous edit', previousValue: 'old', documentValue: 'new' }], observations: [], reporterHypotheses: [] }) });
    const conflictServer = new BugApiServer({}, new SQLiteBugRepository(db), conflictIntake);
    const created = await conflictServer.inject<{ id: string; document: { content: string; revision: number; sha256: string; reconciledSha256: string } }>({ method: 'POST', url: '/api/bugs/conversations', body: { reporterId: userId } });
    const dirtyContent = `${created.data.document.content}\n## User Notes\nambiguous`; const saved = await conflictServer.inject<{ revision: number }>({ method: 'PUT', url: `/api/bugs/conversations/${created.data.id}/document`, body: { content: dirtyContent, baseRevision: created.data.document.revision } });
    const message = await conflictServer.inject<{ code: string; document: { revision: number; reconciledRevision: number; sha256: string; reconciledSha256: string; syncStatus: string } }>({ method: 'POST', url: `/api/bugs/conversations/${created.data.id}/messages`, body: { content: '继续说明问题。' } });
    expect(message.status, message.raw).toBe(409); expect(message.data.code).toBe('DOCUMENT_RECONCILIATION_REQUIRED'); expect(message.data.document.syncStatus).toBe('conflict'); expect(message.data.document.reconciledRevision).toBe(created.data.document.revision); expect(message.data.document.reconciledSha256).toBe(created.data.document.reconciledSha256); expect(message.data.document.revision).toBe(saved.data.revision); expect(message.data.document.sha256).not.toBe(message.data.document.reconciledSha256);
    const submit = await conflictServer.inject<{ code: string; document: { syncStatus: string } }>({ method: 'POST', url: `/api/bugs/conversations/${created.data.id}/submit`, body: { confirm: true } });
    expect(submit.status, submit.raw).toBe(409); expect(submit.data.code).toBe('DOCUMENT_RECONCILIATION_REQUIRED'); expect(submit.data.document.syncStatus).toBe('conflict');
  });

  it('re-reads and retries once when Chat CAS loses a concurrent Markdown edit', async () => {
    let release!: () => void; let entered!: () => void; let calls = 0;
    const started = new Promise<void>((resolve) => { entered = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayedModel = { complete: async (input: IntakeModelInput): Promise<IntakeTurnResult> => { calls += 1; if (calls === 1) { entered(); await gate; } return new FakeIntakeModel().complete(input); } };
    const concurrentServer = new BugApiServer({}, new SQLiteBugRepository(db), new IntakeService(delayedModel));
    const created = await concurrentServer.inject<{ id: string; document: { content: string; revision: number } }>({ method: 'POST', url: '/api/bugs/conversations', body: { reporterId: userId } });
    const request = concurrentServer.inject<{ document: { content: string; revision: number; syncStatus: string } }>({ method: 'POST', url: `/api/bugs/conversations/${created.data.id}/messages`, body: { content: '描述一个页面问题。' } });
    await started; const userEdit = `${created.data.document.content}\n\n## User Notes\nconcurrent edit must survive`; const saved = await concurrentServer.inject<{ revision: number }>({ method: 'PUT', url: `/api/bugs/conversations/${created.data.id}/document`, body: { content: userEdit, baseRevision: created.data.document.revision } });
    release(); const result = await request;
    expect(calls).toBe(2); expect(saved.data.revision).toBe(created.data.document.revision + 1); expect(result.status, result.raw).toBe(200); expect(result.data.document.content).toContain('concurrent edit must survive'); expect(result.data.document.syncStatus).toBe('synced');
  });

  it('returns a conflict without overwriting a second edit during the one permitted retry', async () => {
    let releaseFirst!: () => void; let releaseSecond!: () => void; let enteredFirst!: () => void; let enteredSecond!: () => void; let calls = 0;
    const firstStarted = new Promise<void>((resolve) => { enteredFirst = resolve; }); const secondStarted = new Promise<void>((resolve) => { enteredSecond = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; }); const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const delayedModel = { complete: async (input: IntakeModelInput): Promise<IntakeTurnResult> => { calls += 1; if (calls === 1) { enteredFirst(); await firstGate; } else if (calls === 2) { enteredSecond(); await secondGate; } return new FakeIntakeModel().complete(input); } };
    const concurrentServer = new BugApiServer({}, new SQLiteBugRepository(db), new IntakeService(delayedModel));
    const created = await concurrentServer.inject<{ id: string; document: { content: string; revision: number } }>({ method: 'POST', url: '/api/bugs/conversations', body: { reporterId: userId } });
    const request = concurrentServer.inject<{ code: string; document: { content: string; revision: number; syncStatus: string } }>({ method: 'POST', url: `/api/bugs/conversations/${created.data.id}/messages`, body: { content: '描述一个页面问题。' } });
    await firstStarted;
    const firstEdit = await concurrentServer.inject<{ revision: number }>({ method: 'PUT', url: `/api/bugs/conversations/${created.data.id}/document`, body: { content: `${created.data.document.content}\n\n## User Notes\nfirst concurrent edit`, baseRevision: created.data.document.revision } });
    releaseFirst(); await secondStarted;
    const secondEdit = await concurrentServer.inject<{ revision: number }>({ method: 'PUT', url: `/api/bugs/conversations/${created.data.id}/document`, body: { content: `${created.data.document.content}\n\n## User Notes\nsecond concurrent edit must survive`, baseRevision: firstEdit.data.revision } });
    releaseSecond(); const result = await request;
    expect(calls).toBe(2); expect(result.status, result.raw).toBe(409); expect(result.data.code).toBe('DOCUMENT_REVISION_CONFLICT'); expect(result.data.document.revision).toBe(secondEdit.data.revision); expect(result.data.document.syncStatus).toBe('conflict'); expect(result.data.document.content).toContain('second concurrent edit must survive');
  });

  it('streams chat progress over SSE with stage, progress and result events', async () => {
    const turn: IntakeTurnResult = { fieldUpdates: { actualBehavior: '页面坏了' }, observations: [], reporterHypotheses: [], contradictions: [], possibleSensitiveData: false, executionTargetConfidence: 0, questions: [{ field: 'expectedBehavior', text: '预期是什么？', importance: 'high' }], readyForConfirmation: false };
    const progressModel: IntakeModel = {
      async complete(input: IntakeModelInput): Promise<IntakeTurnResult> {
        input.onProgress?.({ type: 'model_delta', chars: 6, partialQuestions: ['预期是什么？'] });
        return turn;
      },
    };
    const streamingServer = new BugApiServer({}, new SQLiteBugRepository(db), new IntakeService(progressModel));
    const created = await streamingServer.inject<{ id: string }>({ method: 'POST', url: '/api/bugs/conversations', body: { reporterId: userId } });
    const streamed = await streamingServer.inject<{ messages: Array<{ role: string }>; turn: { questions: unknown[] } }>({ method: 'POST', url: `/api/bugs/conversations/${created.data.id}/messages/stream`, body: { content: '页面坏了' } });
    expect(streamed.status, streamed.raw).toBe(200);
    expect(streamed.headers['content-type']).toContain('text/event-stream');
    const blocks = streamed.raw.split('\n\n').filter(Boolean);
    const names = blocks.map((block) => block.match(/^event: (.+)$/m)?.[1]);
    expect(names).toContain('stage');
    expect(names).toContain('progress');
    expect(names).toContain('result');
    const stages = blocks.filter((block) => block.startsWith('event: stage')).map((block) => JSON.parse(block.match(/^data: (.+)$/m)![1]).stage);
    expect(stages).toEqual(['received', 'analyzing', 'finalizing']);
    const progress = JSON.parse(blocks.find((block) => block.startsWith('event: progress'))!.match(/^data: (.+)$/m)![1]);
    expect(progress.questions).toEqual(['预期是什么？']);
    const result = JSON.parse(blocks.find((block) => block.startsWith('event: result'))!.match(/^data: (.+)$/m)![1]);
    expect(result.messages.map((message: { role: string }) => message.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(result.turn.questions[0].text).toBe('预期是什么？');
    // The JSON endpoint keeps its exact contract alongside the stream.
    const json = await streamingServer.inject<{ messages: Array<{ role: string }> }>({ method: 'POST', url: `/api/bugs/conversations/${created.data.id}/messages`, body: { content: '再补充一句' } });
    expect(json.status, json.raw).toBe(200);
    expect(json.data.messages).toHaveLength(5);
  });

  it('reports stream pipeline failures as SSE error events with a status', async () => {
    const failingModel: IntakeModel = { async complete(): Promise<IntakeTurnResult> { throw new Error('Intake LLM exploded'); } };
    const failingServer = new BugApiServer({}, new SQLiteBugRepository(db), new IntakeService(failingModel));
    const created = await failingServer.inject<{ id: string }>({ method: 'POST', url: '/api/bugs/conversations', body: { reporterId: userId } });
    const missing = await failingServer.inject({ method: 'POST', url: `/api/bugs/conversations/${created.data.id}/messages/stream`, body: {} });
    expect(missing.status).toBe(400);
    const streamed = await failingServer.inject<{ error: string; status: number }>({ method: 'POST', url: `/api/bugs/conversations/${created.data.id}/messages/stream`, body: { content: '页面坏了' } });
    expect(streamed.status).toBe(200);
    const errorBlock = streamed.raw.split('\n\n').find((block) => block.startsWith('event: error'));
    expect(errorBlock).toBeDefined();
    const payload = JSON.parse(errorBlock!.match(/^data: (.+)$/m)![1]);
    expect(payload.status).toBe(500);
    expect(payload.error).toContain('Intake LLM exploded');
  });

  it('exposes candidate artifacts and retries FIX_CANDIDATE as a queued job', async () => {
    const conversation = repository.createConversation({ id: newId(), reporterId: userId, status: 'active', draft: {}, completeness: { score: 85, dimensions: { problem: 25, reproduction: 30, environment: 10, evidence: 10, impact: 10 }, missingCriticalInformation: [], recommendedQuestions: [], readyForSubmission: true } });
    const bug = repository.createBug({ title: 'Candidate retry', productArea: null, component: null, bugType: 'functional', executionTarget: 'frontend', environmentProfileId: 'frontend-main', severity: 'medium', actualBehavior: 'Button is stuck', expectedBehavior: 'Button responds', reproduction: { reproducible: true, frequency: 'always', prerequisites: [], steps: ['Click button'], testData: [] }, environment: { environmentName: 'test', appVersion: '1.0', buildNumber: null, commitSha: null, additionalInfo: {} }, evidence: { errorMessages: [], stackTraces: [], logs: [], screenshots: [], videos: [], networkTraces: [], jsonFiles: [], otherFiles: [] }, impact: { affectedUsers: null, scope: 'some_users', blocksTesting: false, workaroundExists: false, workaround: null }, regression: { isRegression: false, lastKnownGoodVersion: null, suspectedVersion: null }, observations: [], reporterHypotheses: [], reporter: { userId, displayName: 'QA Tester' }, intake: { completenessScore: 85, confidence: 1, missingInformation: [], conversationId: conversation.id, llmSummary: 'Candidate' } });
    for (const status of ['COLLECTING', 'READY_FOR_CONFIRMATION', 'SUBMITTED', 'TRIAGING', 'QUEUED', 'PREPARING_ENV', 'FIXING', 'FIX_CANDIDATE'] as const) repository.changeBugStatus(bug.bugKey, status);
    const queue = new JobQueue(repository, fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-api-queue-')));
    const job = queue.enqueueJob(bug.id, bug.bugKey); const running = queue.claimNextJob('api-test-worker'); expect(running?.status).toBe('RUNNING'); queue.failJob(job.id, 'completion format failed', 'api-test-worker', running!.leaseToken!);
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-api-artifacts-')); const artifactDir = path.join(artifactRoot, 'agent-results', bug.bugKey); fs.mkdirSync(artifactDir, { recursive: true }); fs.writeFileSync(path.join(artifactDir, 'candidate.json'), '{"bugKey":"' + bug.bugKey + '"}\n'); fs.writeFileSync(path.join(artifactDir, 'diff.patch'), 'candidate patch\n');
    const candidateServer = new BugApiServer({ DATA_ROOT: artifactRoot }, { repo: repository, queue, intake: new IntakeService(new FakeIntakeModel()) });
    const artifacts = await candidateServer.inject<{ files: string[]; artifacts: Record<string, unknown> }>({ url: `/api/bugs/${bug.bugKey}/artifacts` });
    expect(artifacts.status).toBe(200); expect(artifacts.data.files).toContain('candidate.json'); expect(artifacts.data.files).toContain('diff.patch');
    const retried = await candidateServer.inject<{ bug: { status: string }; job: { status: string }; automatic: boolean }>({ method: 'POST', url: `/api/bugs/${bug.bugKey}/retry` });
    expect(retried.status, retried.raw).toBe(200); expect(retried.data.bug.status).toBe('QUEUED'); expect(retried.data.job.status).toBe('QUEUED'); expect(retried.data.automatic).toBe(false);
    expect(repository.getBug(bug.bugKey)).toMatchObject({ bugKey: bug.bugKey });
    expect((repository.database.prepare('SELECT status FROM bug_reports WHERE bug_key = ?').get(bug.bugKey) as { status: string }).status).toBe('QUEUED');
  });

  it('serves pages and static assets with correct MIME types and headers via pageRenderer', async () => {
    const webServer = new BugApiServer({}, { repo: repository, intake: new IntakeService(new FakeIntakeModel()), pageRenderer: resolveWebRoute });

    const intake = await webServer.inject({ method: 'GET', url: '/' });
    expect(intake.status).toBe(200);
    expect(intake.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(intake.headers['x-content-type-options']).toBe('nosniff');
    expect(intake.raw).toContain('Development Task Intake');
    expect(intake.raw).toContain('<script src="/static/intake.js"></script>');

    const dashboard = await webServer.inject({ method: 'GET', url: '/dashboard' });
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(dashboard.raw).toContain('Bug Dashboard');
    expect(dashboard.raw).toContain('<script src="/static/dashboard.js"></script>');

    const detail = await webServer.inject({ method: 'GET', url: '/bugs/BUG-000123' });
    expect(detail.status).toBe(200);
    expect(detail.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(detail.raw).toContain('Bug detail');
    expect(detail.raw).toContain('<script src="/static/detail.js"></script>');

    const js = await webServer.inject({ method: 'GET', url: '/static/intake.js' });
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(js.headers['x-content-type-options']).toBe('nosniff');
    expect(js.headers['cache-control']).toBe('no-cache');
    expect(js.raw).toContain('let pageState');

    const css = await webServer.inject({ method: 'GET', url: '/static/intake.css' });
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.headers['cache-control']).toBe('no-cache');

    const unknownStatic = await webServer.inject({ method: 'GET', url: '/static/nonexistent.js' });
    expect(unknownStatic.status).toBe(404);

    const nonGetStatic = await webServer.inject({ method: 'POST', url: '/static/intake.js' });
    expect(nonGetStatic.status).toBe(404);

    // Legacy string-return pageRenderer backward compatibility
    const legacyServer = new BugApiServer({}, { repo: repository, pageRenderer: (path) => (path === '/legacy' ? '<h1>Legacy</h1>' : undefined) });
    const legacy = await legacyServer.inject({ method: 'GET', url: '/legacy' });
    expect(legacy.status).toBe(200);
    expect(legacy.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(legacy.raw).toBe('<h1>Legacy</h1>');
  });
});
