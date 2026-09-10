import { describe, expect, it, vi } from 'vitest';
import { clientScripts, getStaticAsset, renderDashboardHtml, renderDetailHtml, renderIndexHtml, resolveWebRoute } from './index.js';
const clientElementIds = [
    'error', 'document-save-state', 'document-sync-state', 'message', 'send', 'markdown-editor',
    'continue', 'submit', 'reload-server-document', 'state', 'messages', 'score', 'missing',
    'retry-init', 'success-card', 'bug-key', 'bug-key-link', 'bug-detail-link', 'submitted-status',
    'submitted-score', 'submitted-explanation', 'typing-status', 'typing-content', 'pending-user', 'pending-typing',
];
const detailElementIds = ['app', 'view-toggle', 'heading', 'loading', 'markdown-view', 'structured-view'];
function executeIntakeClient(responses) {
    const elements = new Map();
    for (const id of clientElementIds) {
        const element = {
            textContent: '', hidden: ['retry-init', 'success-card', 'reload-server-document'].includes(id), disabled: false,
            readOnly: false, value: '', href: '', className: '', innerHTML: '', scrollTop: 0, scrollHeight: 0, removed: false,
            listeners: {},
            addEventListener(type, listener) { this.listeners[type] = listener; },
            focus() { },
            remove() { this.removed = true; },
        };
        elements.set(id, element);
    }
    let responseIndex = 0;
    const fetchMock = vi.fn(async (...args) => {
        const value = responses[responseIndex++];
        if (value instanceof Error)
            throw value;
        if (value && typeof value === 'object' && 'ok' in value)
            return value;
        return { ok: true, status: 200, json: async () => value, args };
    });
    const confirmMock = vi.fn(() => true);
    const script = clientScripts.intake;
    if (!script)
        throw new Error('Intake client script is missing');
    new Function('document', 'fetch', 'confirm', script)({ getElementById: (id) => elements.get(id) }, fetchMock, confirmMock);
    return { elements, fetchMock, confirmMock };
}
function executeDetailClient(detail, pathname = '/bugs/BUG-000123') {
    const elements = new Map();
    for (const id of detailElementIds) {
        const element = {
            textContent: '', hidden: id !== 'loading', disabled: false, readOnly: false, value: '', href: '',
            className: '', innerHTML: '', scrollTop: 0, scrollHeight: 0, removed: false, listeners: {},
            addEventListener(type, listener) { this.listeners[type] = listener; },
            focus() { }, remove() { },
        };
        elements.set(id, element);
    }
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => detail }));
    const script = clientScripts.detail;
    if (!script)
        throw new Error('Detail client script is missing');
    const fakeLocation = { pathname };
    new Function('document', 'fetch', 'location', 'window', script)({ getElementById: (id) => elements.get(id) }, fetchMock, fakeLocation, { location: fakeLocation });
    return { elements, fetchMock };
}
describe('bug detail page', () => {
    it('embeds a view toggle and both detail views in the page shell', () => {
        const html = renderDetailHtml('BUG-000001');
        expect(html).toContain('id="view-toggle"');
        expect(html).toContain('id="markdown-view"');
        expect(html).toContain('id="structured-view"');
        expect(html).toContain('<link rel="stylesheet" href="/static/detail.css">');
        expect(html).toContain('<script src="/static/detail.js"></script>');
        const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
        expect(scripts.length).toBeGreaterThan(0);
        for (const [, attrs, body] of scripts) {
            expect(attrs).toContain('src=');
            expect(body.trim()).toBe('');
        }
        expect(clientScripts.detail).toContain("let mode = 'markdown'");
        expect(clientScripts.detail).toContain('renderMarkdown');
        expect(clientScripts.detail).toContain('detail.document && detail.document.content');
        expect(clientScripts.detail).toContain('开发视图（结构化数据）');
    });
    it('shows the Markdown report for testers and toggles to structured data for developers', async () => {
        const detail = {
            bug: { bugKey: 'BUG-000123', intake: { completenessScore: 70 } },
            key: 'BUG-000123', status: 'FIX_READY', completeness: 70, branch: 'fix/BUG-000123', commit: 'abc123',
            document: { content: '# 登录异常\n\n## Actual Behavior\n按钮 **无响应** `<img src=x onerror=alert(1)>`\n\n## Reproduction\n1. 打开登录页\n2. 点击登录\n' },
            fix: { summary: 'patched' },
        };
        const { elements, fetchMock } = executeDetailClient(detail);
        await vi.waitFor(() => expect(elements.get('markdown-view')?.hidden).toBe(false));
        expect(fetchMock).toHaveBeenCalledWith('/api/bugs/BUG-000123');
        const markdown = elements.get('markdown-view').innerHTML;
        expect(markdown).toContain('<h1>登录异常</h1>');
        expect(markdown).toContain('<h2>Actual Behavior</h2>');
        expect(markdown).toContain('<strong>无响应</strong>');
        expect(markdown).toContain('<ol>');
        expect(markdown).toContain('<li>打开登录页</li>');
        expect(markdown).toContain('BUG-000123');
        expect(markdown).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(markdown).not.toContain('<img');
        expect(elements.get('structured-view')?.hidden).toBe(true);
        expect(elements.get('loading')?.hidden).toBe(true);
        expect(elements.get('heading')?.textContent).toBe('BUG-000123');
        elements.get('view-toggle')?.onclick?.();
        expect(elements.get('structured-view')?.hidden).toBe(false);
        expect(elements.get('markdown-view')?.hidden).toBe(true);
        expect(elements.get('view-toggle')?.textContent).toContain('测试视图');
        const structured = elements.get('structured-view').innerHTML;
        expect(structured).toContain('Fix result');
        expect(structured).toContain('BUG-000123');
        elements.get('view-toggle')?.onclick?.();
        expect(elements.get('markdown-view')?.hidden).toBe(false);
        expect(elements.get('structured-view')?.hidden).toBe(true);
    });
    it('falls back to a hint when the bug has no Markdown document', async () => {
        const detail = { bug: { bugKey: 'BUG-000001' }, key: 'BUG-000001', status: 'NEEDS_INFO' };
        const { elements } = executeDetailClient(detail);
        await vi.waitFor(() => expect(elements.get('markdown-view')?.hidden).toBe(false));
        expect(elements.get('markdown-view').innerHTML).toContain('暂无 Markdown 报告');
    });
});
describe('conversational intake page', () => {
    it('provides parseable client scripts without String.raw or inline embedding', () => {
        for (const [, script] of Object.entries(clientScripts)) {
            expect(script).toBeDefined();
            expect(() => new Function(script)).not.toThrow();
        }
    });
    it('serves HTML pages with external script links and no business inline scripts', () => {
        for (const html of [renderIndexHtml(), renderDashboardHtml(), renderDetailHtml('BUG-000001')]) {
            const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
            expect(scripts.length).toBeGreaterThan(0);
            for (const [, attrs, body] of scripts) {
                expect(attrs).toContain('src=');
                expect(body.trim()).toBe('');
            }
            expect(html).toMatch(/<link rel="stylesheet" href="\/static\/[^"]+\.css">/);
        }
    });
    it('safely parses bug id from location.pathname including encoded and malicious values', async () => {
        const detail = { bug: { bugKey: 'BUG-000123' }, key: 'BUG-000123', status: 'OPEN' };
        const standard = executeDetailClient(detail, '/bugs/BUG-000123');
        await vi.waitFor(() => expect(standard.elements.get('heading')?.textContent).toBe('BUG-000123'));
        expect(standard.fetchMock).toHaveBeenCalledWith('/api/bugs/BUG-000123');
        const encoded = executeDetailClient(detail, '/bugs/a%26b%3C%2Fscript%3E');
        await vi.waitFor(() => expect(encoded.fetchMock).toHaveBeenCalledWith('/api/bugs/a%26b%3C%2Fscript%3E'));
        const malformed = executeDetailClient(detail, '/bugs/%E0%A4%A');
        await vi.waitFor(() => expect(malformed.elements.get('app')?.innerHTML).toContain('A bug id is required'));
        const nonMatching = executeDetailClient(detail, '/dashboard');
        await vi.waitFor(() => expect(nonMatching.elements.get('app')?.innerHTML).toContain('A bug id is required'));
    });
    it('maps static assets with correct MIME types and cache headers', () => {
        const jsAsset = getStaticAsset('/static/intake.js');
        expect(jsAsset).toBeDefined();
        expect(jsAsset?.contentType).toBe('application/javascript; charset=utf-8');
        expect(jsAsset?.headers?.['cache-control']).toBe('no-cache');
        const cssAsset = getStaticAsset('/static/intake.css');
        expect(cssAsset).toBeDefined();
        expect(cssAsset?.contentType).toBe('text/css; charset=utf-8');
        expect(cssAsset?.headers?.['cache-control']).toBe('no-cache');
        expect(getStaticAsset('/static/nonexistent.js')).toBeUndefined();
        const rootRoute = resolveWebRoute('/');
        expect(rootRoute?.contentType).toBe('text/html; charset=utf-8');
        expect(rootRoute?.body).toContain('Bug Intake');
        const dashRoute = resolveWebRoute('/dashboard');
        expect(dashRoute?.contentType).toBe('text/html; charset=utf-8');
        expect(dashRoute?.body).toContain('Bug Dashboard');
        const detailRoute = resolveWebRoute('/bugs/BUG-123');
        expect(detailRoute?.contentType).toBe('text/html; charset=utf-8');
        expect(detailRoute?.body).toContain('Bug detail');
    });
    it('uses an editable Markdown document instead of a structured draft form', () => {
        const html = renderIndexHtml();
        expect(html).toContain('id="markdown-editor"');
        expect(html).toContain('document-save-state');
        expect(html).toContain('document-sync-state');
        expect(html).toContain('reload-server-document');
        expect(clientScripts.intake).toContain('flushDocument');
        expect(clientScripts.intake).toContain('handleDocumentConflict');
        expect(clientScripts.intake).toContain('setEditorDirty');
        expect(clientScripts.intake).toContain('saveTimer = setTimeout');
        expect(clientScripts.intake).toContain('await flushDocument()');
        expect(clientScripts.intake).toContain('error.data && error.data.document');
        expect(clientScripts.intake).toContain('本地编辑已保留');
        expect(clientScripts.intake).toContain("localDirty = $('markdown-editor').value !== content");
        expect(html).not.toContain('id="title"');
        expect(html).not.toContain('id="target"');
        expect(html).not.toContain('id="profile"');
        expect(html).not.toContain('id="actual"');
        expect(html).not.toContain('id="expected"');
        expect(html).not.toContain('id="steps"');
        expect(html).not.toContain('Save draft');
    });
    it('renders accessible navigation and a persistent submitted-result shell', () => {
        const html = renderIndexHtml();
        expect(html).toContain('href="/dashboard"');
        expect(html).toContain('>Dashboard</a>');
        expect(html).toContain('id="success-card"');
        expect(html).toContain('role="status"');
        expect(html).toContain('<h2>Bug 已提交</h2>');
        expect(html).toContain('id="bug-key-link"');
        expect(html).toContain('id="bug-detail-link"');
        expect(clientScripts.intake).toContain("$('state').textContent = '已提交 ' + (bugKey || 'Bug')");
        expect(html).toContain('查看 Bug 详情');
        expect(html).toContain('前往 Dashboard');
        expect(html).toContain('创建新报告');
        expect(clientScripts.intake).toContain("'/bugs/' + encodeURIComponent(bugKey)");
    });
    it('contains retry, pending, failure recovery, and post-submit write guards', () => {
        const html = renderIndexHtml();
        expect(html).toContain('id="retry-init"');
        expect(html).toContain('重试加载');
        expect(clientScripts.intake).toContain("loading: '正在创建会话…'");
        expect(clientScripts.intake).toContain("busy: action === 'submit' ? '正在提交…' : '处理中…'");
        expect(clientScripts.intake).toContain("if (pageState !== 'ready' || !id) return;");
        expect(clientScripts.intake).toContain("if (pageState === 'submitted') return saving || Promise.resolve();");
        expect(clientScripts.intake).toContain("if (pageState === 'submitted' || pageState === 'busy'");
        expect(clientScripts.intake).toContain("if (pageState !== 'submitted') setPageState('ready');");
        expect(clientScripts.intake).toContain('clearTimeout(saveTimer);\n    saveTimer = null;\n    localDirty = false;');
        expect(clientScripts.intake).toContain('若当前服务已配置 repair worker');
        expect(clientScripts.intake).toContain('查看实时状态和修复结果');
        expect(clientScripts.intake).toContain('报告已创建，但信息仍不充分');
        expect(clientScripts.intake).toContain('body: JSON.stringify({ confirm: true })');
    });
    it('enables initialization retry and reaches ready after a transient failure', async () => {
        const created = { id: 'conversation-1', messages: [], completeness: { score: 0 }, document: { content: '# Bug', revision: 0, syncStatus: 'synced' } };
        const { elements, fetchMock } = executeIntakeClient([new Error('network unavailable'), created]);
        await vi.waitFor(() => expect(elements.get('retry-init')?.hidden).toBe(false));
        expect(elements.get('retry-init')?.disabled).toBe(false);
        elements.get('retry-init')?.onclick?.();
        await vi.waitFor(() => expect(elements.get('state')?.textContent).toBe('可继续补充'));
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(elements.get('send')?.disabled).toBe(false);
    });
    it('renders submit results and blocks every subsequent conversation write', async () => {
        const created = { id: 'conversation-1', messages: [], completeness: { score: 80 }, document: { content: '# Bug', revision: 1, syncStatus: 'synced' } };
        const saved = { content: '# Updated bug', revision: 2, syncStatus: 'dirty' };
        const submitted = { bugKey: 'BUG-000123', status: 'QUEUED', completeness: { score: 82 }, document: { ...saved, syncStatus: 'synced' } };
        const { elements, fetchMock } = executeIntakeClient([created, saved, submitted]);
        await vi.waitFor(() => expect(elements.get('state')?.textContent).toBe('可继续补充'));
        elements.get('markdown-editor').value = saved.content;
        elements.get('markdown-editor')?.listeners.input?.();
        elements.get('submit')?.onclick?.();
        await vi.waitFor(() => expect(elements.get('state')?.textContent).toBe('已提交 BUG-000123'));
        expect(elements.get('success-card')?.hidden).toBe(false);
        expect(elements.get('bug-key')?.textContent).toBe('BUG-000123');
        expect(elements.get('submitted-status')?.textContent).toBe('QUEUED');
        expect(elements.get('submitted-score')?.textContent).toBe('82/100');
        expect(elements.get('bug-key-link')?.href).toBe('/bugs/BUG-000123');
        expect(elements.get('bug-detail-link')?.href).toBe('/bugs/BUG-000123');
        expect(elements.get('message')?.disabled).toBe(true);
        expect(elements.get('markdown-editor')?.readOnly).toBe(true);
        expect(elements.get('document-sync-state')?.textContent).toBe('synced');
        elements.get('message').value = 'must not send';
        elements.get('send')?.onclick?.();
        elements.get('submit')?.onclick?.();
        elements.get('markdown-editor')?.listeners.input?.();
        await Promise.resolve();
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    it('gates incomplete intake and keeps the editor usable after an API 422', async () => {
        const incomplete = {
            score: 55,
            readyForConfirmation: false,
            missingCriticalInformation: ['expectedBehavior', 'environmentProfile.repositoryUrl'],
        };
        const created = { id: 'conversation-1', messages: [], completeness: incomplete, document: { content: '# Bug', revision: 1, syncStatus: 'synced' } };
        const { elements, fetchMock } = executeIntakeClient([created]);
        await vi.waitFor(() => expect(elements.get('state')?.textContent).toBe('可继续补充'));
        expect(elements.get('submit')?.disabled).toBe(true);
        expect(elements.get('missing')?.textContent).toContain('expectedBehavior');
        expect(elements.get('missing')?.textContent).toContain('environmentProfile.repositoryUrl');
        elements.get('submit')?.onclick?.();
        await Promise.resolve();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(elements.get('error')?.textContent).toContain('请先补齐');
        expect(elements.get('success-card')?.hidden).toBe(true);
        const ready = { id: 'conversation-1', messages: [], completeness: { score: 70, readyForConfirmation: true, missingCriticalInformation: [] }, document: { content: '# Bug', revision: 1, syncStatus: 'synced' } };
        const failed = { ok: false, status: 422, headers: { get: () => 'application/json' }, json: async () => ({ error: '补充所有必填信息后才能提交 Bug', code: 'INTAKE_INCOMPLETE', completeness: incomplete, draft: {} }) };
        const retry = executeIntakeClient([ready, failed]);
        await vi.waitFor(() => expect(retry.elements.get('state')?.textContent).toBe('可继续补充'));
        expect(retry.elements.get('submit')?.disabled).toBe(false);
        retry.elements.get('submit')?.onclick?.();
        await vi.waitFor(() => expect(retry.elements.get('error')?.hidden).toBe(false));
        expect(retry.fetchMock).toHaveBeenCalledTimes(2);
        expect(retry.elements.get('success-card')?.hidden).toBe(true);
        expect(retry.elements.get('markdown-editor')?.readOnly).toBe(false);
        expect(retry.elements.get('submit')?.disabled).toBe(true);
        expect(retry.elements.get('missing')?.textContent).toContain('environmentProfile.repositoryUrl');
    });
    it('streams the chat reply with live progress and renders the final result', async () => {
        const created = { id: 'conversation-1', messages: [{ role: 'assistant', content: '请直接描述你遇到的问题。' }], completeness: { score: 0 }, document: { content: '# Bug', revision: 1, syncStatus: 'synced' } };
        const finalConversation = {
            id: 'conversation-1',
            messages: [
                { role: 'assistant', content: '请直接描述你遇到的问题。' },
                { role: 'user', content: '页面坏了' },
                { role: 'assistant', content: '1. 预期是什么？' },
            ],
            completeness: { score: 55 },
            document: { content: '# 页面坏了', revision: 2, syncStatus: 'synced' },
        };
        const ssePayload = [
            'event: stage\ndata: {"stage":"received"}',
            'event: stage\ndata: {"stage":"analyzing"}',
            'event: progress\ndata: {"chars":12,"questions":["预期是什么？"]}',
            'event: heartbeat\ndata: {"elapsedMs":2000}',
            'event: result\ndata: ' + JSON.stringify(finalConversation),
        ].join('\n\n') + '\n\n';
        const encoder = new TextEncoder();
        const streamResponse = {
            ok: true,
            status: 200,
            headers: { get: (name) => (name === 'content-type' ? 'text/event-stream' : '') },
            body: {
                getReader: () => {
                    let sent = false;
                    return { read: async () => { if (sent)
                            return { done: true, value: undefined }; sent = true; return { done: false, value: encoder.encode(ssePayload) }; } };
                },
            },
        };
        const { elements, fetchMock } = executeIntakeClient([created, streamResponse]);
        await vi.waitFor(() => expect(elements.get('state')?.textContent).toBe('可继续补充'));
        elements.get('message').value = '页面坏了';
        elements.get('send')?.onclick?.();
        await vi.waitFor(() => expect(elements.get('score')?.textContent).toBe('55'));
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[1][0]).toBe('/api/bugs/conversations/conversation-1/messages/stream');
        const messages = elements.get('messages').innerHTML;
        expect(messages).toContain('页面坏了');
        expect(messages).toContain('1. 预期是什么？');
        expect(messages).not.toContain('pending-typing');
        expect(elements.get('typing-status').textContent).toContain('正在分析');
        expect(elements.get('typing-content').textContent).toContain('预期是什么？');
        expect(elements.get('message').value).toBe('');
        expect(elements.get('error').hidden).toBe(true);
    });
    it('keeps the message in the composer and clears pending bubbles when the stream fails', async () => {
        const created = { id: 'conversation-1', messages: [], completeness: { score: 0 }, document: { content: '# Bug', revision: 1, syncStatus: 'synced' } };
        const ssePayload = [
            'event: stage\ndata: {"stage":"received"}',
            'event: error\ndata: {"status":500,"error":"Intake LLM exploded"}',
        ].join('\n\n') + '\n\n';
        const encoder = new TextEncoder();
        const streamResponse = {
            ok: true,
            status: 200,
            headers: { get: (name) => (name === 'content-type' ? 'text/event-stream' : '') },
            body: {
                getReader: () => {
                    let sent = false;
                    return { read: async () => { if (sent)
                            return { done: true, value: undefined }; sent = true; return { done: false, value: encoder.encode(ssePayload) }; } };
                },
            },
        };
        const { elements } = executeIntakeClient([created, streamResponse]);
        await vi.waitFor(() => expect(elements.get('state')?.textContent).toBe('可继续补充'));
        elements.get('message').value = '页面坏了';
        elements.get('send')?.onclick?.();
        await vi.waitFor(() => expect(elements.get('error').hidden).toBe(false));
        expect(elements.get('error').textContent).toContain('Intake LLM exploded');
        expect(elements.get('message').value).toBe('页面坏了');
        expect(elements.get('pending-typing').removed).toBe(true);
        expect(elements.get('pending-user').removed).toBe(true);
        expect(elements.get('state')?.textContent).toBe('可继续补充');
    });
});
//# sourceMappingURL=index.test.js.map