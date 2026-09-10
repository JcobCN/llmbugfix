(() => {
  let id = '';
  let conversation = null;
  let documentState = null;
  let conflictDocument = null;
  let localDirty = false;
  let saveTimer = null;
  let saving = null;
  let pageState = 'loading';
  let submissionReady = false;

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
  const isSubmissionReady = (completeness) => {
    const value = completeness || {};
    const score = Number(value.score ?? 0);
    const missing = Array.isArray(value.missingCriticalInformation) ? value.missingCriticalInformation : [];
    // Keep the client gate aligned with the authoritative policy. A high score
    // never overrides a reported critical omission.
    if (value.readyForConfirmation !== undefined) return value.readyForConfirmation === true && score >= 65 && missing.length === 0;
    return score >= 65 && missing.length === 0;
  };
  const updateSubmitGate = (completeness) => {
    if (completeness) submissionReady = isSubmissionReady(completeness);
    const submitButton = $('submit');
    if (!submitButton) return;
    submitButton.disabled = pageState !== 'ready' || !submissionReady;
    submitButton.title = submissionReady ? '信息已完整，可以提交。' : '请先补齐关键缺失信息。';
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
    updateSubmitGate();
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
    submissionReady = isSubmissionReady(completeness);
    $('score').textContent = String(completeness.score ?? 0);
    const missing = Array.isArray(completeness.missingCriticalInformation) ? completeness.missingCriticalInformation : [];
    $('missing').textContent = missing.length
      ? '提交前还需要补充：' + missing.join('、')
      : submissionReady ? '信息已完整，可以提交。' : '当前完整度不足 65 分，请继续补充信息。';
    $('missing').className = submissionReady ? 'ready-hint' : 'missing-hint';
    updateSubmitGate();
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
  function renderSubmissionFailure(error) {
    const data = error && error.data || {};
    if (data.completeness) {
      conversation = conversation ? { ...conversation, ...(data.draft ? { draft: data.draft } : {}), completeness: data.completeness } : conversation;
      if (data.document) documentState = data.document;
      const completeness = data.completeness;
      submissionReady = isSubmissionReady(completeness);
      $('score').textContent = String(completeness.score ?? 0);
      const missing = Array.isArray(completeness.missingCriticalInformation) ? completeness.missingCriticalInformation : [];
      $('missing').textContent = missing.length
        ? '提交前还需要补充：' + missing.join('、')
        : '当前完整度不足 65 分，请继续补充信息。';
      $('missing').className = 'missing-hint';
    }
    showError((data.code === 'INTAKE_INCOMPLETE' ? '信息不足，暂不能提交：' : '') + (error.message || 'Request failed'));
    updateSubmitGate();
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
    if (!submissionReady) {
      renderSubmissionFailure({ message: '请先补齐页面列出的关键缺失信息。', data: { code: 'INTAKE_INCOMPLETE', completeness: conversation && conversation.completeness } });
      return;
    }
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
      else if (error.status === 422 && error.data && error.data.code === 'INTAKE_INCOMPLETE') renderSubmissionFailure(error);
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
})()
