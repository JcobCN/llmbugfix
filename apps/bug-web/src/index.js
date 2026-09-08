/** Dependency-free browser pages. Intake deliberately exposes conversation + Markdown only. */
const intakeClientScript = String.raw `(() => {
  let id = '';
  let conversation = null;
  let documentState = null;
  let conflictDocument = null;
  let localDirty = false;
  let saveTimer = null;
  let saving = null;
  let pageState = 'loading';

  const $ = (id) => document.getElementById(id);
  const showError = (message) => {
    $('error').textContent = message || '';
    $('error').hidden = !message;
  };
  const setDocumentState = (save, sync) => {
    if (save) {
      $('document-save-state').textContent = save;
      $('document-save-state').className = 'state-' + save;
    }
    $('document-sync-state').textContent = sync;
    $('document-sync-state').className = 'state-' + sync;
  };
  const setControlsDisabled = (disabled) => {
    ['message', 'send', 'markdown-editor', 'continue', 'submit', 'reload-server-document'].forEach((key) => {
      $(key).disabled = disabled;
    });
  };
  const setPageState = (next, action) => {
    pageState = next;
    const labels = {
      loading: '正在创建会话…',
      ready: '可继续补充',
      busy: action === 'submit' ? '正在提交…' : '处理中…',
      error: '加载失败，请重试',
      submitted: '已提交'
    };
    $('state').textContent = labels[next] || next;
    setControlsDisabled(next !== 'ready');
    $('retry-init').disabled = next !== 'error';
    $('message').readOnly = next === 'submitted';
    $('markdown-editor').readOnly = next === 'submitted';
    $('send').textContent = next === 'busy' && action !== 'submit' ? '处理中…' : '发送';
    $('submit').textContent = next === 'busy' && action === 'submit' ? '正在提交…' : next === 'submitted' ? '已提交' : '确认提交';
  };
  const handleDocumentConflict = (error) => {
    conflictDocument = error && error.data && error.data.document || null;
    setDocumentState('conflict', 'conflict');
    $('reload-server-document').hidden = !conflictDocument;
    showError('文档版本冲突：本地编辑已保留。请先复制需要保留的内容，再载入服务端最新版本并手动合并。');
  };
  async function api(path, options) {
    const response = await fetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = Error(data.error || 'Request failed');
      error.data = data;
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function render(value) {
    conversation = value;
    const messages = value.messages || [];
    $('messages').innerHTML = messages.map((message) => '<div class="message ' + esc(message.role) + '">' + esc(message.content) + '</div>').join('') || '<p class="muted">还没有消息。</p>';
    const completeness = value.completeness || {};
    $('score').textContent = String(completeness.score ?? 0);
    $('missing').textContent = completeness.missingCriticalInformation && completeness.missingCriticalInformation.length
      ? 'Missing: ' + completeness.missingCriticalInformation.join(', ')
      : 'Information looks complete.';
    $('messages').scrollTop = $('messages').scrollHeight;
    const documentValue = value.document;
    if (documentValue) {
      documentState = documentValue;
      if (!localDirty && !conflictDocument && pageState !== 'submitted') {
        $('markdown-editor').value = documentValue.content;
        setDocumentState('saved', documentValue.syncStatus || 'synced');
      }
    }
  }
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const stageLabels = {
    received: '已收到消息',
    reconciling_document: '正在合并 Markdown 修改…',
    analyzing: '正在分析你的描述…',
    finalizing: '正在更新报告…'
  };
  let stageLabel = '正在发送…';
  let lastEventAt = 0;
  function beginTyping(userContent) {
    const messages = $('messages');
    if (messages.innerHTML.indexOf('还没有消息') >= 0 || messages.innerHTML.indexOf('正在创建会话') >= 0) messages.innerHTML = '';
    messages.innerHTML += '<div class="message user" id="pending-user">' + esc(userContent) + '</div>'
      + '<div class="message assistant pending" id="pending-typing"><div class="typing-status" id="typing-status">正在发送…</div><div class="typing-content" id="typing-content"></div></div>';
    messages.scrollTop = messages.scrollHeight;
  }
  function updateTyping(status, partial) {
    const statusElement = document.getElementById('typing-status');
    const contentElement = document.getElementById('typing-content');
    if (statusElement && status) statusElement.textContent = status;
    if (contentElement && partial !== undefined) contentElement.textContent = partial;
    $('messages').scrollTop = $('messages').scrollHeight;
  }
  function removePendingMessages() {
    ['pending-user', 'pending-typing'].forEach((key) => {
      const element = document.getElementById(key);
      if (element && element.remove) element.remove();
    });
  }
  async function sendMessageRequest(content) {
    const response = await fetch('/api/bugs/conversations/' + id + '/messages/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, documentRevision: documentState && documentState.revision })
    });
    const contentType = (response.headers && response.headers.get && response.headers.get('content-type')) || '';
    if (!response.ok || contentType.indexOf('text/event-stream') < 0 || !response.body) {
      const data = await response.json().catch(() => ({}));
      if (response.ok) return data;
      const error = Error(data.error || 'Request failed');
      error.data = data;
      error.status = response.status;
      throw error;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;
    let failure = null;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
        let event = 'message';
        const dataLines = [];
        block.split('\n').forEach((line) => {
          if (line.indexOf('event:') === 0) event = line.slice(6).trim();
          else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trim());
        });
        if (!dataLines.length) continue;
        let data;
        try { data = JSON.parse(dataLines.join('\n')); } catch { continue; }
        lastEventAt = Date.now();
        if (event === 'result') result = data;
        else if (event === 'error') failure = data;
        else if (event === 'stage') {
          stageLabel = stageLabels[data.stage] || data.stage || stageLabel;
          updateTyping(stageLabel);
        } else if (event === 'progress') {
          updateTyping(undefined, (data.questions || []).map((question, index) => (index + 1) + '. ' + question).join('\n'));
        }
      }
    }
    if (failure) {
      const error = Error(failure.error || 'Request failed');
      error.data = failure;
      error.status = failure.status || 500;
      throw error;
    }
    if (!result) throw Error('连接中断，请重试。');
    return result;
  }
  function setEditorDirty() {
    if (pageState === 'submitted' || pageState === 'busy' || pageState === 'loading' || pageState === 'error') return;
    localDirty = true;
    if (conflictDocument) {
      setDocumentState('conflict', 'conflict');
      return;
    }
    setDocumentState('dirty', 'dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void saveDocument().catch(() => {}); }, 700);
  }
  async function saveDocument() {
    if (pageState === 'submitted') return saving || Promise.resolve();
    if (conflictDocument) {
      const error = Error('请先处理文档版本冲突，再发送消息或提交。');
      error.status = 409;
      throw error;
    }
    if (!id || !documentState || !localDirty) return saving || Promise.resolve();
    if (saving) return saving;
    saving = (async () => {
      setDocumentState('saving', 'dirty');
      const content = $('markdown-editor').value;
      const baseRevision = documentState.revision;
      try {
        const saved = await api('/api/bugs/conversations/' + id + '/document', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, baseRevision })
        });
        documentState = saved;
        localDirty = $('markdown-editor').value !== content;
        if (localDirty) {
          setDocumentState('dirty', 'dirty');
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => { void saveDocument().catch(() => {}); }, 0);
        } else {
          setDocumentState('saved', saved.syncStatus || 'dirty');
        }
        showError('');
      } catch (error) {
        if (error.status === 409) handleDocumentConflict(error);
        else showError(error.message);
        throw error;
      } finally {
        saving = null;
      }
    })();
    return saving;
  }
  async function flushDocument() {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveDocument();
  }
  async function init() {
    if (pageState === 'submitted') return;
    clearTimeout(saveTimer);
    saveTimer = null;
    id = '';
    setPageState('loading');
    $('retry-init').hidden = true;
    $('messages').innerHTML = '<p class="muted">正在创建会话…</p>';
    try {
      const created = await api('/api/bugs/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      if (!created || !created.id) throw Error('Conversation id was not returned');
      id = created.id;
      conflictDocument = null;
      localDirty = false;
      render(created);
      showError('');
      $('retry-init').hidden = true;
      setPageState('ready');
    } catch (error) {
      id = '';
      setPageState('error');
      $('messages').innerHTML = '<p class="muted">会话创建失败，请重试加载。</p>';
      $('retry-init').hidden = false;
      showError(error.message || 'Unable to create conversation.');
    }
  }
  async function send() {
    if (pageState !== 'ready' || !id) return;
    const input = $('message');
    const content = input.value.trim();
    if (!content) return;
    setPageState('busy', 'send');
    beginTyping(content);
    stageLabel = '正在发送…';
    lastEventAt = Date.now();
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      const stalled = Date.now() - lastEventAt > 12000;
      updateTyping(stageLabel + ' · ' + seconds + ' 秒' + (stalled ? ' · 等待服务器响应…' : ''));
    }, 1000);
    try {
      await flushDocument();
      const updated = await sendMessageRequest(content);
      input.value = '';
      localDirty = false;
      render(updated);
      showError('');
    } catch (error) {
      removePendingMessages();
      if (error.status === 409 && error.data && error.data.document) handleDocumentConflict(error);
      else showError(error.message);
    } finally {
      clearInterval(ticker);
      if (pageState !== 'submitted') setPageState('ready');
    }
  }
  function renderSubmitted(result) {
    clearTimeout(saveTimer);
    saveTimer = null;
    localDirty = false;
    conflictDocument = null;
    if (result.document) {
      documentState = result.document;
      setDocumentState('saved', documentState.syncStatus || 'synced');
    }
    const bug = result.bug || {};
    const bugKey = String(result.bugKey || bug.bugKey || '');
    const status = String(result.status || bug.status || 'UNKNOWN');
    const completeness = result.completeness || {};
    const score = completeness.score ?? (bug.intake && bug.intake.completenessScore) ?? 0;
    const detailUrl = '/bugs/' + encodeURIComponent(bugKey);
    $('bug-key').textContent = bugKey || '未返回 Bug Key';
    $('bug-key-link').href = detailUrl;
    $('bug-detail-link').href = detailUrl;
    $('submitted-status').textContent = status;
    $('submitted-score').textContent = String(score) + '/100';
    if (status === 'QUEUED') {
      $('submitted-explanation').textContent = '已进入修复队列。若当前服务已配置 repair worker，它会自动开始处理；请在详情页查看实时状态和修复结果。';
    } else if (status === 'NEEDS_INFO') {
      $('submitted-explanation').textContent = '报告已创建，但信息仍不充分；请查看 Bug 详情了解还需要补充的内容。';
    } else {
      $('submitted-explanation').textContent = '当前状态为 ' + status + '，可在详情页查看最新进度。';
    }
    $('success-card').hidden = false;
    setPageState('submitted');
    $('state').textContent = '已提交 ' + (bugKey || 'Bug');
    showError('');
  }
  async function submit() {
    if (pageState !== 'ready' || !id) return;
    if (!confirm('确认提交会创建正式 Bug。请确认 Markdown 报告内容无误后继续。')) return;
    setPageState('busy', 'submit');
    try {
      await flushDocument();
      const result = await api('/api/bugs/conversations/' + id + '/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true })
      });
      renderSubmitted(result);
    } catch (error) {
      if (error.status === 409 && error.data && error.data.document) handleDocumentConflict(error);
      else showError(error.message);
    } finally {
      if (pageState !== 'submitted') setPageState('ready');
    }
  }
  $('markdown-editor').addEventListener('input', setEditorDirty);
  $('reload-server-document').onclick = () => {
    if (pageState === 'submitted' || !conflictDocument) return;
    $('markdown-editor').value = conflictDocument.content;
    documentState = conflictDocument;
    conflictDocument = null;
    localDirty = false;
    $('reload-server-document').hidden = true;
    setDocumentState('saved', documentState.syncStatus || 'dirty');
    showError('已载入服务端最新版本。请重新应用需要保留的本地修改后再保存。');
  };
  $('retry-init').onclick = () => { void init(); };
  $('send').onclick = () => { void send(); };
  $('submit').onclick = () => { void submit(); };
  $('continue').onclick = () => { if (pageState === 'ready') $('message').focus(); };
  $('message').onkeydown = (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void send();
    }
  };
  init();
})()`;
export function renderIndexHtml() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bug Intake</title><style>
body{margin:0;font:14px system-ui,sans-serif;color:#182230;background:#f5f7fb}header{padding:16px 24px;background:#182230;color:#fff;display:flex;justify-content:space-between;align-items:center;gap:16px}header a{color:#fff} .layout{display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:1280px;margin:16px auto;padding:0 16px}.panel{background:#fff;border:1px solid #dce2ea;border-radius:10px;padding:16px;min-height:calc(100vh - 130px);display:flex;flex-direction:column}#messages{flex:1;overflow:auto}.message{padding:10px 12px;border-radius:8px;margin:8px 0;max-width:85%;white-space:pre-wrap}.user{background:#e0edff;margin-left:auto}.assistant{background:#f0f2f6}.message.pending{border:1px dashed #bcc7d5;background:#fafbfe}.typing-status{color:#637083;font-size:12px;margin-bottom:4px}.typing-status::after{content:'…';animation:typing-blink 1.2s infinite}.typing-content{white-space:pre-wrap;min-height:1em}@keyframes typing-blink{0%,80%,100%{opacity:.2}40%{opacity:1}}.composer{display:flex;gap:8px;margin-top:10px}.composer textarea{flex:1;min-height:58px;resize:vertical}textarea{font:inherit;width:100%;padding:10px;border:1px solid #bcc7d5;border-radius:6px;box-sizing:border-box;resize:vertical}button{border:0;border-radius:5px;padding:9px 14px;cursor:pointer;background:#2563eb;color:#fff}button:disabled{opacity:.55;cursor:wait}.submit{background:#16834b;width:100%;margin-top:12px}.muted{color:#637083}.error{color:#b42318;background:#fff0f0;padding:8px;border-radius:5px}.score{font-size:24px;font-weight:700}.document-meta{display:flex;justify-content:space-between;gap:8px;color:#637083;font-size:12px;margin:4px 0 8px}.state-dirty{color:#a15c00}.state-conflict{color:#b42318}.state-synced{color:#16834b}.success-card{border:2px solid #16834b;background:#f1fbf5;border-radius:10px;padding:16px;margin:16px auto;max-width:1280px}.success-card h2{margin-top:0}.success-card a{color:#155eef}.success-actions{display:flex;gap:10px;flex-wrap:wrap}.success-actions a{display:inline-block;padding:9px 12px;border:1px solid #155eef;border-radius:5px;text-decoration:none}@media(max-width:800px){.layout{grid-template-columns:1fr}.panel{min-height:unset}.success-actions{flex-direction:column}.success-actions a{width:100%;box-sizing:border-box}}
</style></head><body><header><strong>Bug Intake</strong><span><span id="state" role="status" aria-live="polite">正在创建会话…</span> · <a href="/dashboard">Dashboard</a></span></header><main><section id="success-card" class="success-card" role="status" aria-live="polite" aria-atomic="true" hidden><h2>Bug 已提交</h2><p><strong>Bug Key：</strong><a id="bug-key-link" href="#"><span id="bug-key"></span></a></p><p><strong>状态：</strong><span id="submitted-status"></span></p><p><strong>完整度：</strong><span id="submitted-score"></span></p><p id="submitted-explanation"></p><nav class="success-actions" aria-label="已提交报告操作"><a id="bug-detail-link" href="#">查看 Bug 详情</a><a href="/dashboard">前往 Dashboard</a><a href="/">创建新报告</a></nav></section><div class="layout"><section class="panel"><h2>Chat</h2><div id="error" class="error" role="alert" aria-live="assertive" hidden></div><div id="messages"><p class="muted">正在创建会话…</p></div><div class="composer"><textarea id="message" aria-label="Describe the bug" placeholder="请直接描述你遇到的问题…"></textarea><button id="send" type="button">发送</button></div></section><section class="panel"><h2>Bug Report (Markdown)</h2><div class="document-meta"><span>可直接编辑报告内容</span><span>保存：<b id="document-save-state">saved</b> · 同步：<b id="document-sync-state">synced</b></span></div><textarea id="markdown-editor" aria-label="Editable Markdown bug report" spellcheck="false" placeholder="# 未命名问题"></textarea><button id="reload-server-document" type="button" hidden>载入服务端最新版本</button><div class="score">Completeness: <span id="score">0</span>/100</div><p id="missing" class="muted">等待对话信息…</p><p class="muted">你可以继续补充，也可以直接修改右侧 Markdown；确认提交前会自动保存并检查同步状态。</p><button id="continue" type="button">继续补充</button><button id="submit" class="submit" type="button">确认提交</button><button id="retry-init" type="button" hidden>重试加载</button></section></div></main><script>${intakeClientScript}</script></body></html>`;
}
/** Dashboard is deliberately server-rendered as a tiny dependency-free page.
 * All state comes from the API, so refreshes never expose a stale in-memory UI. */
export function renderDashboardHtml() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bug Dashboard</title><style>
body{margin:0;background:#f5f7fb;color:#182230;font:14px system-ui,sans-serif}header{background:#182230;color:#fff;padding:18px 24px;display:flex;justify-content:space-between;align-items:center}main{max-width:1280px;margin:20px auto;padding:0 16px}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}input,select,button{font:inherit;padding:8px;border:1px solid #bcc7d5;border-radius:5px;background:#fff}button{background:#2563eb;border:0;color:#fff;cursor:pointer}.table{overflow:auto;background:#fff;border:1px solid #dce2ea;border-radius:10px}table{border-collapse:collapse;width:100%;min-width:760px}th,td{text-align:left;padding:12px;border-bottom:1px solid #edf0f4}th{background:#f7f9fc}.link{color:#155eef;cursor:pointer}.empty,.loading,.error{padding:28px;text-align:center}.error{color:#b42318;background:#fff0f0;border-radius:6px}</style></head><body><header><strong>Bug Dashboard</strong><a href="/" style="color:#fff">New report</a></header><main><div class="toolbar"><input id="q" placeholder="Search key or title"><select id="target"><option value="">All targets</option><option value="frontend">Frontend</option><option value="backend">Backend</option></select><select id="status"><option value="">All statuses</option><option>QUEUED</option><option>FIXING</option><option>FIX_READY</option><option>FAILED</option><option>NEEDS_INFO</option><option>READY_FOR_HUMAN_REVIEW</option></select><button id="refresh">Refresh</button></div><div id="state" class="loading">Loading bugs…</div><div id="table" class="table" hidden><table><thead><tr><th>Bug Key</th><th>Title</th><th>Target</th><th>Status</th><th>Completeness</th><th>Created</th><th>Fix Branch</th></tr></thead><tbody id="rows"></tbody></table></div></main><script>(()=>{const $=x=>document.getElementById(x),esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));async function load(){const state=$('state');state.className='loading';state.textContent='Loading bugs…';$('table').hidden=true;try{const p=new URLSearchParams();[['q','q'],['target','target'],['status','status']].forEach(([a,b])=>{const v=$(b).value.trim();if(v)p.set(a,v)});const r=await fetch('/api/bugs?'+p);const d=await r.json();if(!r.ok)throw Error(d.error||'Unable to load bugs');const bugs=d.bugs||[];if(!bugs.length){state.className='empty';state.textContent='No bugs match these filters.';return}state.textContent='';$('rows').innerHTML=bugs.map(b=>'<tr><td><a class="link" href="/bugs/'+encodeURIComponent(b.id||b.key)+'">'+esc(b.key||b.bugKey)+'</a></td><td>'+esc(b.title)+'</td><td>'+esc(b.target||b.executionTarget)+'</td><td>'+esc(b.status)+'</td><td>'+esc(b.completeness)+'%</td><td>'+esc(b.created||b.createdAt)+'</td><td>'+esc(b.fixBranch||'—')+'</td></tr>').join('');$('table').hidden=false}catch(e){state.className='error';state.textContent=e.message||'Unable to load bugs'}}$('refresh').onclick=load;['q','target','status'].forEach(k=>$(k).onchange=load);load()})()</script></body></html>`;
}
/** Detail view renders the tester-facing Markdown report first; the structured
 * projection stays one toggle away for developers. Inline code and fenced blocks
 * use \x60 (backtick) because this script is embedded in a template literal. */
const detailClientScript = String.raw `
  const app = document.getElementById('app');
  const toggle = document.getElementById('view-toggle');
  let mode = 'markdown';
  let detail = null;
  const esc = (x) => String(x ?? '—').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const json = (x) => x == null ? '—' : JSON.stringify(x, null, 2);
  const section = (title, value) => '<section class="card"><h2>' + title + '</h2><div class="value">' + esc(typeof value === 'string' ? value : json(value)) + '</div></section>';
  const inline = (text) => esc(text)
    .replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  function renderMarkdown(source) {
    const lines = String(source ?? '').split(/\r?\n/);
    const out = [];
    let list = null;
    let code = null;
    let paragraph = [];
    const flushParagraph = () => { if (paragraph.length) { out.push('<p>' + inline(paragraph.join(' ')) + '</p>'); paragraph = []; } };
    const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
    const closeCode = () => { if (code) { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = null; } };
    for (const line of lines) {
      if (code !== null) { if (/^\s*\x60\x60\x60/.test(line)) closeCode(); else code.push(line); continue; }
      if (/^\s*\x60\x60\x60/.test(line)) { flushParagraph(); closeList(); code = []; continue; }
      if (!line.trim()) { flushParagraph(); closeList(); continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushParagraph(); closeList(); out.push('<hr>'); continue; }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) { flushParagraph(); closeList(); out.push('<h' + heading[1].length + '>' + inline(heading[2].trim()) + '</h' + heading[1].length + '>'); continue; }
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) { flushParagraph(); closeList(); out.push('<blockquote>' + inline(quote[1]) + '</blockquote>'); continue; }
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) { flushParagraph(); if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + inline(bullet[1].trim()) + '</li>'); continue; }
      const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ordered) { flushParagraph(); if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + inline(ordered[1].trim()) + '</li>'); continue; }
      closeList();
      paragraph.push(line.trim());
    }
    closeCode(); flushParagraph(); closeList();
    return out.join('\n');
  }
  function metaHtml(d) {
    const b = d.bug || d;
    const items = ['Bug Key: ' + (b.bugKey || d.key || '—'), 'Status: ' + (d.status || b.status || '—'), 'Completeness: ' + (d.completeness ?? (b.intake && b.intake.completenessScore) ?? 0) + '%'];
    if (d.branch) items.push('Branch: ' + d.branch);
    if (d.commit) items.push('Commit: ' + d.commit);
    return '<div class="meta">' + items.map((item) => '<span>' + esc(item) + '</span>').join('') + '</div>';
  }
  function structuredHtml(d) {
    const b = d.bug || d;
    return '<div class="grid">' + section('Summary', d.summary || b.actualBehavior) + section('Execution target / profile', (d.target || b.executionTarget) + ' / ' + (d.profile || b.environmentProfileId || '—')) + section('Completeness', (d.completeness ?? (b.intake && b.intake.completenessScore) ?? 0) + '%') + '</div>'
      + section('Reproduction', d.reproduction || b.reproduction)
      + section('Environment', d.environment || b.environment)
      + section('Evidence', d.evidence || b.evidence)
      + section('Attachments', d.attachments || [])
      + section('Conversation', d.messages || d.conversation || [])
      + section('Agent progress', d.progress || d.status)
      + section('Fix result', d.fix)
      + section('Validation result', d.validation)
      + section('Review result', d.review)
      + section('Branch / commit', { branch: d.branch, commit: d.commit });
  }
  function render() {
    if (!detail) return;
    const markdownView = document.getElementById('markdown-view');
    const structuredView = document.getElementById('structured-view');
    markdownView.hidden = mode !== 'markdown';
    structuredView.hidden = mode !== 'structured';
    toggle.textContent = mode === 'markdown' ? '开发视图（结构化数据）' : '测试视图（Markdown 报告）';
    if (mode === 'markdown') {
      const content = detail.document && detail.document.content ? String(detail.document.content) : '';
      markdownView.innerHTML = metaHtml(detail) + (content.trim() ? renderMarkdown(content) : '<p class="muted">暂无 Markdown 报告，可切换到开发视图查看结构化数据。</p>');
    } else {
      structuredView.innerHTML = structuredHtml(detail);
    }
  }
  toggle.onclick = () => { mode = mode === 'markdown' ? 'structured' : 'markdown'; render(); };
  async function load() {
    try {
      if (!id) throw Error('A bug id is required');
      const r = await fetch('/api/bugs/' + encodeURIComponent(id));
      const d = await r.json();
      if (!r.ok) throw Error(d.error || 'Unable to load bug');
      detail = d;
      const b = d.bug || d;
      document.getElementById('heading').textContent = b.bugKey || d.key || 'Bug detail';
      document.getElementById('loading').hidden = true;
      render();
    } catch (e) {
      app.innerHTML = '<div class="error">' + esc(e.message || 'Unable to load bug') + '</div>';
    }
  }
  load();
`;
/** Detail view intentionally renders all pipeline sections, including sections
 * that are not available until the worker reaches that stage. */
export function renderDetailHtml(bugId = '') {
    // Keep the value a JavaScript string (not an HTML entity encoded string),
    // then neutralize script-breaking characters inside that string literal.
    const serializedBugId = JSON.stringify(bugId || '').replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bug detail</title><style>body{margin:0;background:#f5f7fb;color:#182230;font:14px system-ui,sans-serif}header{background:#182230;color:#fff;padding:18px 24px;display:flex;align-items:center;gap:12px}header button{background:#2563eb;color:#fff;border:0;border-radius:5px;padding:6px 12px;cursor:pointer;font:inherit}main{max-width:1100px;margin:20px auto;padding:0 16px}.card{background:#fff;border:1px solid #dce2ea;border-radius:10px;padding:16px;margin:12px 0}h2{margin:0 0 10px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.label{color:#637083;font-size:12px}.value{white-space:pre-wrap;margin-top:4px}.loading,.error,.empty{padding:30px;text-align:center}.error{color:#b42318;background:#fff0f0}.meta{display:flex;gap:14px;flex-wrap:wrap;color:#637083;font-size:12px;margin:0 0 12px}.muted{color:#637083}.markdown{background:#fff;border:1px solid #dce2ea;border-radius:10px;padding:20px 24px;line-height:1.7}.markdown h1{font-size:22px;margin:16px 0 10px}.markdown h2{font-size:18px;margin:18px 0 8px;padding-bottom:6px;border-bottom:1px solid #edf0f4}.markdown h3{font-size:15px;margin:14px 0 6px}.markdown h4,.markdown h5,.markdown h6{font-size:14px;margin:12px 0 6px}.markdown p{margin:8px 0}.markdown ul,.markdown ol{margin:8px 0;padding-left:24px}.markdown li{margin:4px 0}.markdown blockquote{margin:8px 0;padding:4px 12px;border-left:3px solid #bcc7d5;color:#42506b}.markdown code{background:#f0f2f6;border-radius:4px;padding:1px 5px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px}.markdown pre{background:#0f172a;color:#e2e8f0;border-radius:8px;padding:14px;overflow:auto}.markdown pre code{background:none;color:inherit;padding:0}.markdown a{color:#155eef}.markdown hr{border:0;border-top:1px solid #edf0f4;margin:14px 0}</style></head><body><header><a href="/dashboard" style="color:#fff">← Dashboard</a> <strong id="heading">Bug detail</strong><button id="view-toggle" type="button">开发视图（结构化数据）</button></header><main id="app"><div id="loading" class="loading">Loading bug detail…</div><section id="markdown-view" class="markdown" hidden></section><div id="structured-view" hidden></div></main><script>(() => { const id = ${serializedBugId};${detailClientScript}})()</script></body></html>`;
}
//# sourceMappingURL=index.js.map