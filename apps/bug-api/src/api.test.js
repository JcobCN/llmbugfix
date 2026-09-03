import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId } from '@llmbugfix/shared';
import { openDatabase, SQLiteBugRepository } from '@llmbugfix/bug-repository';
import { FakeIntakeModel, IntakeService } from '@llmbugfix/intake-agent';
import { BugApiServer } from './index.js';
describe('Bug API routes', () => {
    let db;
    let server;
    const userId = newId();
    beforeEach(() => {
        db = openDatabase(':memory:');
        const repo = new SQLiteBugRepository(db);
        repo.createUser({ id: userId, displayName: 'QA Tester', email: 'tester@internal.local' });
        server = new BugApiServer({}, repo, new IntakeService(new FakeIntakeModel()));
    });
    afterEach(() => db.close());
    it('creates, interviews, patches and explicitly submits a conversation', async () => {
        const created = await server.inject({ method: 'POST', url: '/api/bugs/conversations', body: { reporterId: userId } });
        expect(created.status).toBe(201);
        const id = created.data.id;
        const message = await server.inject({ method: 'POST', url: `/api/bugs/conversations/${id}/messages`, body: { content: '前端登录按钮点击无响应，页面提示错误' } });
        expect(message.status, message.raw).toBe(200);
        expect(message.data.turn.questions.length).toBeLessThanOrEqual(3);
        const patched = await server.inject({ method: 'PATCH', url: `/api/bugs/conversations/${id}/draft`, body: { draft: { title: '用户登录异常', executionTarget: 'frontend', actualBehavior: '登录按钮一直 loading', expectedBehavior: '跳转首页' } } });
        expect(patched.status).toBe(200);
        expect(patched.data.draft.executionTarget).toBe('frontend');
        const rejected = await server.inject({ method: 'POST', url: `/api/bugs/conversations/${id}/submit`, body: {} });
        expect(rejected.status).toBe(400);
        const submitted = await server.inject({ method: 'POST', url: `/api/bugs/conversations/${id}/submit`, body: { confirmed: true } });
        expect(submitted.status).toBe(201);
        expect(submitted.data.bugKey).toMatch(/^BUG-\d{6}$/);
        const list = await server.inject({ url: '/api/bugs' });
        expect(list.status).toBe(200);
        expect(list.data.bugs).toHaveLength(1);
        expect(list.data.bugs[0].status).toBe('NEEDS_INFO');
        expect(list.data.bugs[0].key).toMatch(/^BUG-/);
        const filtered = await server.inject({ url: '/api/bugs?target=frontend&status=NEEDS_INFO' });
        expect(filtered.data.bugs).toHaveLength(1);
        const detail = await server.inject({ url: `/api/bugs/${submitted.data.bugKey}` });
        expect(detail.status).toBe(200);
        expect(detail.data.bug.status).toBe('NEEDS_INFO');
        expect(detail.data.progress.status).toBe('NEEDS_INFO');
        expect(detail.data.messages.length).toBeGreaterThan(0);
        expect((await server.inject({ url: '/api/health/live' })).status).toBe(200);
        expect((await server.inject({ url: '/api/health/ready' })).status).toBe(200);
        const cancelled = await server.inject({ method: 'POST', url: `/api/bugs/${submitted.data.bugKey}/cancel` });
        expect(cancelled.status, cancelled.raw).toBe(200);
        expect(cancelled.data.bug.status).toBe('CANCELLED');
        expect(cancelled.data.semantic).toBe('removed_from_queue');
        expect((await server.inject({ method: 'POST', url: `/api/bugs/${submitted.data.bugKey}/retry` })).status).toBe(409);
    });
    it('keeps Chat and editable Markdown synchronized through revisioned reconciliation', async () => {
        const created = await server.inject({ method: 'POST', url: '/api/bugs/conversations', body: { reporterId: userId } });
        const id = created.data.id;
        expect(created.data.document.content).toContain('## Actual Behavior');
        const first = await server.inject({ method: 'POST', url: `/api/bugs/conversations/${id}/messages`, body: { content: '前端登录页面点击登录后停留在原页面，正常应该进入首页。' } });
        expect(first.status, first.raw).toBe(200);
        expect(first.data.document.revision).toBeGreaterThan(created.data.document.revision);
        expect(first.data.document.content).toContain('停留在原页面');
        const edited = first.data.document.content.replace(/(## Actual Behavior\n)[^\n]+/u, '$1页面显示白屏');
        const saved = await server.inject({ method: 'PUT', url: `/api/bugs/conversations/${id}/document`, body: { content: edited, baseRevision: first.data.document.revision } });
        expect(saved.status, saved).toBe(200);
        expect(saved.data.syncStatus).toBe('dirty');
        const staleMessage = await server.inject({ method: 'POST', url: `/api/bugs/conversations/${id}/messages`, body: { content: '这条消息来自旧页面版本。', documentRevision: first.data.document.revision } });
        expect(staleMessage.status).toBe(409);
        expect(staleMessage.data.code).toBe('DOCUMENT_REVISION_CONFLICT');
        expect(staleMessage.data.document.revision).toBe(saved.data.revision);
        const reconciled = await server.inject({ method: 'POST', url: `/api/bugs/conversations/${id}/messages`, body: { content: '补充：这个问题每次都能复现。' } });
        expect(reconciled.status, reconciled.raw).toBe(200);
        expect(reconciled.data.draft.actualBehavior).toContain('页面显示白屏');
        expect(reconciled.data.document.syncStatus).toBe('synced');
        const submitted = await server.inject({ method: 'POST', url: `/api/bugs/conversations/${id}/submit`, body: { confirm: true } });
        expect(submitted.status, submitted.raw).toBe(201);
        expect(submitted.data.bugKey).toMatch(/^BUG-/);
        expect(submitted.data.document.syncStatus).toBe('synced');
    });
    it('detects an external Markdown filesystem edit on the next message', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-api-'));
        try {
            const localServer = new BugApiServer({ DATA_ROOT: root }, new SQLiteBugRepository(db), new IntakeService(new FakeIntakeModel()));
            const created = await localServer.inject({ method: 'POST', url: '/api/bugs/conversations', body: { reporterId: userId } });
            const filename = path.join(root, 'intake-documents', created.data.id, 'bug-report.md');
            fs.writeFileSync(filename, '# 外部修改\n\n## Actual Behavior\n外部文件事实\n');
            const response = await localServer.inject({ method: 'POST', url: `/api/bugs/conversations/${created.data.id}/messages`, body: { content: '继续补充信息。' } });
            expect(response.status, response.raw).toBe(200);
            expect(response.data.draft.actualBehavior).toBe('外部文件事实');
        }
        finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=api.test.js.map