(() => {
  const $ = (x) => document.getElementById(x);
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
  const expanded = new Set();
  const logState = new Map();
  const scrollPositions = new Map();
  let bugsById = new Map();
  let firstLoad = true;

  const bugId = (bug) => String(bug.id || bug.key || bug.bugKey);
  const jobFor = (bug) => bug.job || null;
  const isRunning = (bug) => String(jobFor(bug)?.status || '').toUpperCase() === 'RUNNING';
  const statusClass = (value) => String(value || 'NONE').toLowerCase().replace(/[^a-z0-9_-]/g, '-');

  function eventState(id) {
    if (!logState.has(id)) logState.set(id, { events: [], after: 0, first: 0, hasMore: false, loading: false, autoScroll: true });
    return logState.get(id);
  }

  function rowMarkup(bug) {
    const id = bugId(bug);
    const job = jobFor(bug);
    const jobStatus = job?.status || bug.jobStatus || '—';
    const opened = expanded.has(id);
    const attempt = job?.attempt === undefined ? '' : `attempt ${esc(job.attempt)}`;
    const worker = job?.workerId ? ` · ${esc(job.workerId)}` : '';
    const heartbeat = job?.heartbeatAt ? `<small class="heartbeat">${esc(job.heartbeatAt)}</small>` : '';
    return `<tr class="bug-row" data-bug-id="${esc(id)}">
      <td class="bug-key-cell"><button class="log-toggle" type="button" data-log-toggle="${esc(id)}" aria-expanded="${opened}" aria-controls="worker-log-${esc(id)}" aria-label="${opened ? 'Collapse' : 'Expand'} worker log">${opened ? '▼' : '▶'}</button><a class="link" href="/bugs/${encodeURIComponent(id)}">${esc(bug.key || bug.bugKey)}</a></td>
      <td>${esc(bug.title)}</td>
      <td>${esc(bug.target || bug.executionTarget)}</td>
      <td><span class="status-pill status-${statusClass(bug.status)}">${esc(bug.status)}</span></td>
      <td><span class="status-pill job-status status-${statusClass(jobStatus)}">${esc(jobStatus)}</span><small class="job-meta">${attempt}${worker}</small>${heartbeat}</td>
      <td>${esc(bug.completeness)}%</td>
      <td>${esc(bug.created || bug.createdAt)}</td>
      <td>${esc(bug.fixBranch || '—')}</td>
    </tr>
    <tr class="log-row" data-log-row="${esc(id)}"${opened ? '' : ' hidden'}><td colspan="8"><section id="worker-log-${esc(id)}" class="worker-log-panel" aria-label="Worker log for ${esc(bug.key || bug.bugKey)}">${logMarkup(id)}</section></td></tr>`;
  }

  function logMarkup(id) {
    const state = eventState(id);
    const controls = `<div class="worker-log-toolbar"><strong>Worker log</strong><label><input type="checkbox" class="auto-scroll" data-log-id="${esc(id)}"${state.autoScroll ? ' checked' : ''}> Auto-scroll</label>${state.hasMore ? `<button type="button" class="load-earlier" data-log-id="${esc(id)}">Load earlier</button>` : ''}</div>`;
    if (state.error && !state.events.length) return `${controls}<p class="log-empty">${esc(state.error)}</p>`;
    if (!state.events.length && !state.loading) return `${controls}<p class="log-empty">No Worker logs yet.</p>`;
    const body = state.events.map((event) => {
      const tool = event.tool ? `<span class="log-tool">${esc(event.tool)}</span>` : '';
      const error = event.isError ? ' log-error' : '';
      const counter = event.turnIndex == null ? '' : ` · turn ${esc(event.turnIndex)}`;
      return `<li class="worker-event${error}"><time>${esc(event.occurredAt)}</time><span class="log-role">${esc(event.role)}</span><span class="log-type">${esc(event.eventType)}</span>${tool}<span class="log-summary">${esc(event.summary)}</span><small>${counter}</small></li>`;
    }).join('');
    return `${controls}<div class="worker-log-scroll" data-log-scroll="${esc(id)}"><ol>${body}</ol>${state.loading ? '<p class="log-loading">Loading…</p>' : ''}</div>`;
  }

  function renderLog(id, keepScroll = true) {
    const row = [...document.querySelectorAll('[data-log-row]')].find((item) => item.dataset.logRow === id);
    const panel = row?.querySelector('.worker-log-panel');
    if (!panel) return;
    const scroll = panel.querySelector('.worker-log-scroll');
    const atBottom = !scroll || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 24;
    const previousTop = scroll?.scrollTop ?? 0;
    panel.innerHTML = logMarkup(id);
    const next = panel.querySelector('.worker-log-scroll');
    if (next && eventState(id).autoScroll && (!keepScroll || atBottom)) next.scrollTop = next.scrollHeight;
    else if (next && !eventState(id).autoScroll) next.scrollTop = previousTop;
  }

  function renderRows() {
    const rows = $('rows');
    rows.querySelectorAll('[data-log-scroll]').forEach((element) => scrollPositions.set(element.dataset.logScroll, element.scrollTop));
    rows.innerHTML = [...bugsById.values()].map(rowMarkup).join('');
    $('table').hidden = bugsById.size === 0;
    for (const id of expanded) {
      renderLog(id, true);
      const scroll = rows.querySelector(`[data-log-scroll="${id}"]`);
      if (scroll && !eventState(id).autoScroll && scrollPositions.has(id)) scroll.scrollTop = scrollPositions.get(id);
    }
  }

  async function fetchEvents(id, mode = 'initial') {
    const state = eventState(id);
    if (state.loading) return;
    state.loading = true;
    renderLog(id);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (mode === 'poll') params.set('after', String(state.after));
      // A very large before cursor asks the API for the newest bounded page;
      // subsequent polling uses after and never reloads the whole log.
      if (mode === 'initial') params.set('before', String(Number.MAX_SAFE_INTEGER));
      if (mode === 'earlier' && state.first > 0) params.set('before', String(state.first));
      const response = await fetch(`/api/bugs/${encodeURIComponent(id)}/events?${params}`);
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Unable to load worker logs');
      const incoming = Array.isArray(data.events) ? data.events : [];
      const bySequence = new Map(state.events.map((event) => [event.sequence, event]));
      incoming.forEach((event) => bySequence.set(event.sequence, event));
      state.events = [...bySequence.values()].sort((a, b) => Number(a.sequence) - Number(b.sequence)).slice(-1000);
      if (incoming.length) {
        state.after = Math.max(state.after, Number(data.nextAfter ?? incoming[incoming.length - 1].sequence) || 0);
        if (mode !== 'poll') state.first = Number(data.firstSequence ?? incoming[0].sequence) || state.first;
      }
      state.hasMore = mode === 'poll' ? state.hasMore || Boolean(data.hasMore) : Boolean(data.hasMore);
      delete state.error;
    } catch (error) {
      state.error = error.message || 'Unable to load worker logs';
    } finally {
      state.loading = false;
      renderLog(id, false);
    }
  }

  async function load({ initial = false } = {}) {
    const state = $('state');
    if (initial) {
      state.className = 'loading';
      state.textContent = 'Loading bugs…';
    }
    try {
      const p = new URLSearchParams();
      [['q', 'q'], ['target', 'target'], ['status', 'status']].forEach(([a, b]) => {
        const value = $(b).value.trim();
        if (value) p.set(a, value);
      });
      const response = await fetch('/api/bugs?' + p);
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Unable to load bugs');
      bugsById = new Map((data.bugs || []).map((bug) => [bugId(bug), bug]));
      for (const id of [...expanded]) if (!bugsById.has(id)) expanded.delete(id);
      if (!bugsById.size) {
        $('table').hidden = true;
        state.className = 'empty';
        state.textContent = 'No bugs match these filters.';
        return;
      }
      state.className = '';
      state.textContent = '';
      renderRows();
      firstLoad = false;
    } catch (error) {
      if (firstLoad) {
        state.className = 'error';
        state.textContent = error.message || 'Unable to load bugs';
      }
    }
  }

  $('rows').addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-log-toggle]');
    const earlier = event.target.closest('.load-earlier');
    if (earlier) { void fetchEvents(earlier.dataset.logId, 'earlier'); return; }
    if (!toggle) return;
    const id = toggle.dataset.logToggle;
    if (!id) return;
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    renderRows();
    if (expanded.has(id)) void fetchEvents(id, 'initial');
  });
  $('rows').addEventListener('change', (event) => {
    const checkbox = event.target.closest('.auto-scroll');
    if (checkbox) eventState(checkbox.dataset.logId).autoScroll = checkbox.checked;
  });

  $('refresh').onclick = () => void load();
  ['q', 'target', 'status'].forEach((key) => { $(key).onchange = () => void load({ initial: true }); });
  setInterval(() => { if (!document.hidden) void load(); }, 2000);
  setInterval(() => {
    if (document.hidden) return;
    for (const id of expanded) if (isRunning(bugsById.get(id))) void fetchEvents(id, 'poll');
  }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(); });
  void load({ initial: true });
})();
