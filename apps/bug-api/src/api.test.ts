import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newId } from '@llmbugfix/shared';
import { openDatabase, SQLiteBugRepository } from '@llmbugfix/bug-repository';
import { FakeIntakeModel, IntakeService } from '@llmbugfix/intake-agent';
import { BugApiServer } from './index.js';

describe('Bug API routes', () => {
  let db: ReturnType<typeof openDatabase>;
  let server: BugApiServer;
  const userId = newId();

  beforeEach(() => {
    db = openDatabase(':memory:');
    const repo = new SQLiteBugRepository(db);
    repo.createUser({ id: userId, displayName: 'QA Tester', email: 'tester@internal.local' });
    server = new BugApiServer({}, repo, new IntakeService(new FakeIntakeModel()));
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

    const rejected = await server.inject({ method: 'POST', url: `/api/bugs/conversations/${id}/submit`, body: {} });
    expect(rejected.status).toBe(400);

    const submitted = await server.inject<{ bugKey: string }>({ method: 'POST', url: `/api/bugs/conversations/${id}/submit`, body: { confirmed: true } });
    expect(submitted.status).toBe(201);
    expect(submitted.data.bugKey).toMatch(/^BUG-\d{6}$/);

    const list = await server.inject<{ bugs: unknown[] }>({ url: '/api/bugs' });
    expect(list.status).toBe(200);
    expect(list.data.bugs).toHaveLength(1);
    expect((list.data.bugs[0] as { status: string; key: string; completeness: number }).status).toBe('NEEDS_INFO');
    expect((list.data.bugs[0] as { key: string }).key).toMatch(/^BUG-/);
    const filtered = await server.inject<{ bugs: unknown[] }>({ url: '/api/bugs?target=frontend&status=NEEDS_INFO' });
    expect(filtered.data.bugs).toHaveLength(1);
    const detail = await server.inject<{ bug: { status: string }; progress: { status: string }; messages: unknown[] }>({ url: `/api/bugs/${submitted.data.bugKey}` });
    expect(detail.status).toBe(200);
    expect(detail.data.bug.status).toBe('NEEDS_INFO');
    expect(detail.data.progress.status).toBe('NEEDS_INFO');
    expect(detail.data.messages.length).toBeGreaterThan(0);
    expect((await server.inject({ url: '/api/health/live' })).status).toBe(200);
    expect((await server.inject({ url: '/api/health/ready' })).status).toBe(200);
    const cancelled = await server.inject<{ bug: { status: string }; semantic: string }>({ method: 'POST', url: `/api/bugs/${submitted.data.bugKey}/cancel` });
    expect(cancelled.status, cancelled.raw).toBe(200);
    expect(cancelled.data.bug.status).toBe('CANCELLED');
    expect(cancelled.data.semantic).toBe('removed_from_queue');
    expect((await server.inject({ method: 'POST', url: `/api/bugs/${submitted.data.bugKey}/retry` })).status).toBe(409);
  });
});
