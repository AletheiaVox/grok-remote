// Worktrees page.
//
// Two tabs:
//   list  - filter / show / rm / gc the grok-managed git worktrees
//   db    - inspect & rebuild the local index db

import { api } from '../../lib/api';

let activeContainer = null;
let state = {
  tab:        'list',      // 'list' | 'db'
  loading:    false,
  error:      null,
  worktrees:  [],
  filters:    { repo: '', type: '', all: false },
  // id -> { showOpen, showText, showErr, rmConfirm, rmForce, rmDryRun, busy }
  rows:       new Map(),
  // gc form
  gc: {
    open: false, dryRun: false, maxAge: '', force: false,
    output: null, error: null, busy: false,
  },
  db: {
    statsText: null, statsErr: null,
    pathText:  null, pathErr:  null,
    rebuildText: null, rebuildErr: null,
    busy: false,
  },
};

export function mount(container) {
  activeContainer = container;
  state = {
    tab: 'list', loading: false, error: null, worktrees: [],
    filters: { repo: '', type: '', all: false },
    rows: new Map(),
    gc: { open: false, dryRun: false, maxAge: '', force: false, output: null, error: null, busy: false },
    db: { statsText: null, statsErr: null, pathText: null, pathErr: null, rebuildText: null, rebuildErr: null, busy: false },
  };
  render();
  refresh();
}

export function unmount() {
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

function render() {
  if (!activeContainer) return;
  const c = activeContainer;
  c.innerHTML = `
    <section class="system-page worktrees-page">
      <h2 class="system-page-title">Worktrees</h2>
      <p class="system-page-sub">
        Manage git worktrees created with <code>grok -w</code>. Switch to the
        db tab to inspect or rebuild grok's local index.
      </p>
      <nav class="worktrees-tabs">
        <button class="worktrees-tab" data-tab="list">list</button>
        <button class="worktrees-tab" data-tab="db">db</button>
      </nav>
      <div class="worktrees-body" data-role="body"></div>
    </section>
  `;
  for (const btn of c.querySelectorAll('.worktrees-tab')) {
    btn.addEventListener('click', () => {
      state.tab = btn.getAttribute('data-tab');
      renderBody();
    });
  }
  renderBody();
}

function renderBody() {
  if (!activeContainer) return;
  for (const btn of activeContainer.querySelectorAll('.worktrees-tab')) {
    btn.classList.toggle('worktrees-tab--active', btn.getAttribute('data-tab') === state.tab);
  }
  const body = activeContainer.querySelector('[data-role=body]');
  if (!body) return;
  if (state.tab === 'list') {
    body.innerHTML = renderListTab();
    bindListTab(body);
  } else {
    body.innerHTML = renderDbTab();
    bindDbTab(body);
  }
}

// ── list tab ────────────────────────────────────────────────────────────

function renderListTab() {
  const f = state.filters;
  return `
    <div class="worktrees-filters">
      <label class="worktrees-inline">
        repo
        <input class="worktrees-input" type="text" data-filter="repo" value="${escapeHtml(f.repo)}" placeholder="/path/to/repo">
      </label>
      <label class="worktrees-inline">
        type
        <input class="worktrees-input" type="text" data-filter="type" value="${escapeHtml(f.type)}" placeholder="fork, scratch...">
      </label>
      <label class="worktrees-inline">
        <input type="checkbox" data-filter="all" ${f.all ? 'checked' : ''}>
        include stale
      </label>
      <button class="worktrees-btn" data-act="refresh">refresh</button>
      <button class="worktrees-btn" data-act="toggle-gc">${state.gc.open ? 'hide gc' : 'gc'}</button>
    </div>
    ${state.gc.open ? renderGcForm() : ''}
    <div class="worktrees-status" data-role="status">${renderStatusText()}</div>
    <div class="worktrees-table-wrap">${renderTable()}</div>
  `;
}

function renderStatusText() {
  if (state.loading) return '<span class="worktrees-status--loading">loading...</span>';
  if (state.error)   return `<span class="worktrees-status--error">${escapeHtml(state.error)}</span>`;
  return '';
}

function renderTable() {
  if (!state.worktrees.length && !state.loading) {
    return `<div class="worktrees-empty">No worktrees.</div>`;
  }
  const headers = ['id', 'repo', 'branch', 'age', ''];
  const rows = state.worktrees.map(wt => renderWtRow(wt)).join('');
  return `
    <table class="worktrees-table">
      <thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderWtRow(wt) {
  const id = String(wt.id ?? wt.worktree_id ?? wt.path ?? '');
  const r  = getRow(id);
  const open = r.showOpen || r.rmConfirm;
  const cells = [
    truncate(id, 30),
    truncate(wt.repo ?? wt.source_repo ?? wt.source ?? '', 40),
    wt.branch ?? '',
    wt.age ?? wt.age_human ?? formatAge(wt.created_at ?? wt.created),
  ];
  const main = `
    <tr data-id="${escapeHtml(id)}" class="worktrees-row ${open ? 'worktrees-row--open' : ''}">
      ${cells.map(c => `<td>${escapeHtml(String(c))}</td>`).join('')}
      <td class="worktrees-row-actions">
        <button class="worktrees-btn worktrees-btn--small" data-act="show">${r.showOpen ? 'hide' : 'show'}</button>
        <button class="worktrees-btn worktrees-btn--small worktrees-btn--danger" data-act="rm">${r.rmConfirm ? 'cancel' : 'rm'}</button>
      </td>
    </tr>
  `;
  if (!open) return main;
  const sections = [];
  if (r.showOpen) sections.push(renderShowSection(r));
  if (r.rmConfirm) sections.push(renderRmSection(id, r));
  return main + `
    <tr data-detail-for="${escapeHtml(id)}" class="worktrees-detail">
      <td colspan="5">${sections.join('')}</td>
    </tr>
  `;
}

function renderShowSection(r) {
  if (r.showErr) {
    return `<div class="worktrees-detail-section">
      <div class="worktrees-detail-title">show</div>
      <div class="worktrees-error">${escapeHtml(r.showErr)}</div>
    </div>`;
  }
  if (r.showText == null) {
    return `<div class="worktrees-detail-section">
      <div class="worktrees-detail-title">show</div>
      <div class="worktrees-muted">loading...</div>
    </div>`;
  }
  return `<div class="worktrees-detail-section">
    <div class="worktrees-detail-title">show</div>
    <pre class="worktrees-pre">${escapeHtml(r.showText)}</pre>
  </div>`;
}

function renderRmSection(id, r) {
  return `<div class="worktrees-detail-section">
    <div class="worktrees-detail-title">remove worktree</div>
    <div class="worktrees-rm-row">
      <label class="worktrees-inline">
        <input type="checkbox" data-rm-input="force" ${r.rmForce ? 'checked' : ''}>
        force (allow uncommitted changes)
      </label>
      <label class="worktrees-inline">
        <input type="checkbox" data-rm-input="dryRun" ${r.rmDryRun ? 'checked' : ''}>
        dry run
      </label>
      <button class="worktrees-btn worktrees-btn--small worktrees-btn--danger" data-act="rm-confirm" ${r.busy ? 'disabled' : ''}>
        ${r.busy ? 'working...' : 'confirm remove'}
      </button>
    </div>
    ${r.rmErr ? `<div class="worktrees-error">${escapeHtml(r.rmErr)}</div>` : ''}
    ${r.rmOutput ? `<pre class="worktrees-pre">${escapeHtml(r.rmOutput)}</pre>` : ''}
  </div>`;
}

function renderGcForm() {
  const g = state.gc;
  return `
    <div class="worktrees-gc">
      <div class="worktrees-detail-title">garbage collect</div>
      <div class="worktrees-gc-row">
        <label class="worktrees-inline">
          <input type="checkbox" data-gc-input="dryRun" ${g.dryRun ? 'checked' : ''}>
          dry run
        </label>
        <label class="worktrees-inline">
          max age
          <input class="worktrees-input worktrees-input--small" type="text" data-gc-input="maxAge" value="${escapeHtml(g.maxAge)}" placeholder="7d, 48h">
        </label>
        <label class="worktrees-inline">
          <input type="checkbox" data-gc-input="force" ${g.force ? 'checked' : ''}>
          force
        </label>
        <button class="worktrees-btn" data-act="gc-run" ${g.busy ? 'disabled' : ''}>
          ${g.busy ? 'working...' : 'run'}
        </button>
      </div>
      ${g.error  ? `<div class="worktrees-error">${escapeHtml(g.error)}</div>` : ''}
      ${g.output ? `<pre class="worktrees-pre">${escapeHtml(g.output)}</pre>`  : ''}
    </div>
  `;
}

function bindListTab(root) {
  root.querySelector('[data-act=refresh]')?.addEventListener('click', refresh);
  root.querySelector('[data-act=toggle-gc]')?.addEventListener('click', () => {
    state.gc.open = !state.gc.open;
    renderBody();
  });
  for (const inp of root.querySelectorAll('[data-filter]')) {
    inp.addEventListener('change', () => {
      const k = inp.getAttribute('data-filter');
      if (inp.type === 'checkbox') state.filters[k] = inp.checked;
      else state.filters[k] = inp.value;
    });
    inp.addEventListener('input', () => {
      const k = inp.getAttribute('data-filter');
      if (inp.type !== 'checkbox') state.filters[k] = inp.value;
    });
  }

  for (const inp of root.querySelectorAll('[data-gc-input]')) {
    inp.addEventListener('change', () => {
      const k = inp.getAttribute('data-gc-input');
      if (inp.type === 'checkbox') state.gc[k] = inp.checked;
      else state.gc[k] = inp.value;
    });
    inp.addEventListener('input', () => {
      const k = inp.getAttribute('data-gc-input');
      if (inp.type !== 'checkbox') state.gc[k] = inp.value;
    });
  }
  root.querySelector('[data-act=gc-run]')?.addEventListener('click', runGc);

  for (const wt of state.worktrees) {
    const id = String(wt.id ?? wt.worktree_id ?? wt.path ?? '');
    const row = root.querySelector(`tr[data-id="${cssEscape(id)}"]`);
    if (!row) continue;
    row.querySelector('[data-act=show]')?.addEventListener('click', () => toggleShow(id));
    row.querySelector('[data-act=rm]')?.addEventListener('click', () => toggleRm(id));
    const detail = root.querySelector(`tr[data-detail-for="${cssEscape(id)}"]`);
    if (!detail) continue;
    detail.querySelector('[data-act=rm-confirm]')?.addEventListener('click', () => doRm(id));
    for (const inp of detail.querySelectorAll('[data-rm-input]')) {
      inp.addEventListener('change', () => {
        const k = inp.getAttribute('data-rm-input');
        const r = getRow(id);
        if (inp.type === 'checkbox') r[k === 'force' ? 'rmForce' : 'rmDryRun'] = inp.checked;
      });
    }
  }
}

// ── db tab ──────────────────────────────────────────────────────────────

function renderDbTab() {
  const d = state.db;
  return `
    <div class="worktrees-db">
      <div class="worktrees-db-row">
        <button class="worktrees-btn" data-act="db-stats" ${d.busy ? 'disabled' : ''}>stats</button>
        <button class="worktrees-btn" data-act="db-path"  ${d.busy ? 'disabled' : ''}>path</button>
        <button class="worktrees-btn worktrees-btn--danger" data-act="db-rebuild" ${d.busy ? 'disabled' : ''}>rebuild</button>
      </div>
      ${d.statsErr   ? `<div class="worktrees-error">stats: ${escapeHtml(d.statsErr)}</div>`     : ''}
      ${d.statsText  ? `<div class="worktrees-detail-title">stats</div><pre class="worktrees-pre">${escapeHtml(d.statsText)}</pre>` : ''}
      ${d.pathErr    ? `<div class="worktrees-error">path: ${escapeHtml(d.pathErr)}</div>`       : ''}
      ${d.pathText   ? `<div class="worktrees-detail-title">path</div><pre class="worktrees-pre">${escapeHtml(d.pathText)}</pre>`   : ''}
      ${d.rebuildErr ? `<div class="worktrees-error">rebuild: ${escapeHtml(d.rebuildErr)}</div>` : ''}
      ${d.rebuildText? `<div class="worktrees-detail-title">rebuild</div><pre class="worktrees-pre">${escapeHtml(d.rebuildText)}</pre>` : ''}
    </div>
  `;
}

function bindDbTab(root) {
  root.querySelector('[data-act=db-stats]')?.addEventListener('click', doDbStats);
  root.querySelector('[data-act=db-path]')?.addEventListener('click', doDbPath);
  root.querySelector('[data-act=db-rebuild]')?.addEventListener('click', doDbRebuild);
}

// ── actions ─────────────────────────────────────────────────────────────

async function refresh() {
  state.loading = true;
  state.error = null;
  renderBody();
  try {
    const opts = {
      all:  state.filters.all,
      repo: state.filters.repo.trim(),
      type: state.filters.type.trim(),
    };
    const resp = await api.worktrees.list(opts);
    const data = (resp && 'data' in resp) ? resp.data : resp;
    state.worktrees = normalizeWorktrees(data);
  } catch (err) {
    state.error = err.message || String(err);
    state.worktrees = [];
  } finally {
    state.loading = false;
    renderBody();
  }
}

async function toggleShow(id) {
  const r = getRow(id);
  r.showOpen = !r.showOpen;
  renderBody();
  if (r.showOpen && r.showText == null && !r.showErr) {
    try {
      const resp = await api.worktrees.show(id);
      r.showText = (resp && resp.output) || (typeof resp === 'string' ? resp : JSON.stringify(resp, null, 2));
    } catch (err) {
      r.showErr = err.message || String(err);
    }
    renderBody();
  }
}

function toggleRm(id) {
  const r = getRow(id);
  r.rmConfirm = !r.rmConfirm;
  if (!r.rmConfirm) {
    r.rmOutput = null;
    r.rmErr = null;
  }
  renderBody();
}

async function doRm(id) {
  const r = getRow(id);
  r.busy = true;
  r.rmErr = null;
  r.rmOutput = null;
  renderBody();
  try {
    const resp = await api.worktrees.rm(id, { force: r.rmForce, dryRun: r.rmDryRun });
    r.rmOutput = (resp && resp.output) || JSON.stringify(resp, null, 2);
  } catch (err) {
    r.rmErr = err.message || String(err);
  } finally {
    r.busy = false;
  }
  renderBody();
  if (!r.rmErr && !r.rmDryRun) {
    // Removed for real - refresh the list.
    setTimeout(refresh, 250);
  }
}

async function runGc() {
  const g = state.gc;
  if (!confirm(`Run grok worktree gc${g.dryRun ? ' (dry run)' : ''}?`)) return;
  g.busy = true;
  g.error = null;
  g.output = null;
  renderBody();
  try {
    const body = {};
    if (g.dryRun) body.dryRun = true;
    if (g.force)  body.force = true;
    if (g.maxAge && g.maxAge.trim()) body.maxAge = g.maxAge.trim();
    const resp = await api.worktrees.gc(body);
    g.output = (resp && resp.output) || JSON.stringify(resp, null, 2);
  } catch (err) {
    g.error = err.message || String(err);
  } finally {
    g.busy = false;
  }
  renderBody();
  if (!g.error && !g.dryRun) setTimeout(refresh, 250);
}

async function doDbStats() {
  state.db.busy = true;
  state.db.statsErr = null;
  state.db.statsText = 'loading...';
  renderBody();
  try {
    const resp = await api.worktrees.dbStats();
    state.db.statsText = (resp && resp.output) || JSON.stringify(resp, null, 2);
  } catch (err) {
    state.db.statsText = null;
    state.db.statsErr = err.message || String(err);
  } finally {
    state.db.busy = false;
  }
  renderBody();
}

async function doDbPath() {
  state.db.busy = true;
  state.db.pathErr = null;
  state.db.pathText = 'loading...';
  renderBody();
  try {
    const resp = await api.worktrees.dbPath();
    state.db.pathText = (resp && resp.output) || JSON.stringify(resp, null, 2);
  } catch (err) {
    state.db.pathText = null;
    state.db.pathErr = err.message || String(err);
  } finally {
    state.db.busy = false;
  }
  renderBody();
}

async function doDbRebuild() {
  if (!confirm('Rebuild the worktree index by scanning the filesystem?')) return;
  state.db.busy = true;
  state.db.rebuildErr = null;
  state.db.rebuildText = 'running...';
  renderBody();
  try {
    const resp = await api.worktrees.dbRebuild();
    state.db.rebuildText = (resp && resp.output) || JSON.stringify(resp, null, 2);
  } catch (err) {
    state.db.rebuildText = null;
    state.db.rebuildErr = err.message || String(err);
  } finally {
    state.db.busy = false;
  }
  renderBody();
}

// ── helpers ─────────────────────────────────────────────────────────────

function getRow(id) {
  let r = state.rows.get(id);
  if (!r) {
    r = {
      showOpen: false, showText: null, showErr: null,
      rmConfirm: false, rmForce: false, rmDryRun: false,
      rmOutput: null, rmErr: null, busy: false,
    };
    state.rows.set(id, r);
  }
  return r;
}

function normalizeWorktrees(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.worktrees)) return data.worktrees;
  if (Array.isArray(data.rows)) return data.rows;
  if (Array.isArray(data.data)) return data.data;
  return [];
}

function formatAge(when) {
  if (!when) return '';
  const t = typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(t)) return String(when);
  const secs = Math.max(0, (Date.now() - t) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n - 1) + '...' : str;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}
