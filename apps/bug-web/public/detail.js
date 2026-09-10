(() => {
  const getBugIdFromLocation = () => {
    const pathname = (typeof window !== 'undefined' && window.location && window.location.pathname)
      || (typeof location !== 'undefined' && location.pathname)
      || '';
    const match = String(pathname).match(/^\/bugs\/([^/]+)$/);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return '';
    }
  };

  const app = document.getElementById('app');
  const toggle = document.getElementById('view-toggle');
  let mode = 'markdown';
  let detail = null;
  const esc = (x) => String(x ?? '—').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
  const json = (x) => (x == null ? '—' : JSON.stringify(x, null, 2));
  const section = (title, value) =>
    '<section class="card"><h2>' + title + '</h2><div class="value">' + esc(typeof value === 'string' ? value : json(value)) + '</div></section>';
  const inline = (text) => esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  function renderMarkdown(source) {
    const lines = String(source ?? '').split(/\r?\n/);
    const out = [];
    let list = null;
    let code = null;
    let paragraph = [];
    const flushParagraph = () => {
      if (paragraph.length) {
        out.push('<p>' + inline(paragraph.join(' ')) + '</p>');
        paragraph = [];
      }
    };
    const closeList = () => {
      if (list) {
        out.push('</' + list + '>');
        list = null;
      }
    };
    const closeCode = () => {
      if (code) {
        out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
        code = null;
      }
    };
    for (const line of lines) {
      if (code !== null) {
        if (/^\s*```/.test(line)) closeCode();
        else code.push(line);
        continue;
      }
      if (/^\s*```/.test(line)) {
        flushParagraph();
        closeList();
        code = [];
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        closeList();
        continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        flushParagraph();
        closeList();
        out.push('<hr>');
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        closeList();
        out.push('<h' + heading[1].length + '>' + inline(heading[2].trim()) + '</h' + heading[1].length + '>');
        continue;
      }
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        closeList();
        out.push('<blockquote>' + inline(quote[1]) + '</blockquote>');
        continue;
      }
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        flushParagraph();
        if (list !== 'ul') {
          closeList();
          out.push('<ul>');
          list = 'ul';
        }
        out.push('<li>' + inline(bullet[1].trim()) + '</li>');
        continue;
      }
      const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ordered) {
        flushParagraph();
        if (list !== 'ol') {
          closeList();
          out.push('<ol>');
          list = 'ol';
        }
        out.push('<li>' + inline(ordered[1].trim()) + '</li>');
        continue;
      }
      closeList();
      paragraph.push(line.trim());
    }
    closeCode();
    flushParagraph();
    closeList();
    return out.join('\n');
  }

  function metaHtml(d) {
    const b = d.bug || d;
    const items = [
      'Bug Key: ' + (b.bugKey || d.key || '—'),
      'Status: ' + (d.status || b.status || '—'),
      'Completeness: ' + (d.completeness ?? (b.intake && b.intake.completenessScore) ?? 0) + '%'
    ];
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
      const id = getBugIdFromLocation();
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
})();
