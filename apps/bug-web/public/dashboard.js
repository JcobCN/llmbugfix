(() => {
  const $ = (x) => document.getElementById(x);
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);

  async function load() {
    const state = $('state');
    state.className = 'loading';
    state.textContent = 'Loading bugs…';
    $('table').hidden = true;
    try {
      const p = new URLSearchParams();
      [['q', 'q'], ['target', 'target'], ['status', 'status']].forEach(([a, b]) => {
        const v = $(b).value.trim();
        if (v) p.set(a, v);
      });
      const r = await fetch('/api/bugs?' + p);
      const d = await r.json();
      if (!r.ok) throw Error(d.error || 'Unable to load bugs');
      const bugs = d.bugs || [];
      if (!bugs.length) {
        state.className = 'empty';
        state.textContent = 'No bugs match these filters.';
        return;
      }
      state.textContent = '';
      $('rows').innerHTML = bugs.map((b) => (
        '<tr><td><a class="link" href="/bugs/' + encodeURIComponent(b.id || b.key) + '">' +
        esc(b.key || b.bugKey) + '</a></td><td>' +
        esc(b.title) + '</td><td>' +
        esc(b.target || b.executionTarget) + '</td><td>' +
        esc(b.status) + '</td><td>' +
        esc(b.completeness) + '%</td><td>' +
        esc(b.created || b.createdAt) + '</td><td>' +
        esc(b.fixBranch || '—') + '</td></tr>'
      )).join('');
      $('table').hidden = false;
    } catch (e) {
      state.className = 'error';
      state.textContent = e.message || 'Unable to load bugs';
    }
  }

  $('refresh').onclick = load;
  ['q', 'target', 'status'].forEach((k) => $(k).onchange = load);
  load();
})();
