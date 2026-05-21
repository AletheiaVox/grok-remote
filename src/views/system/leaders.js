// Leader processes page.
//
// Renders a table of running grok leader backends. Per-row controls let
// the user open a JSON `info` panel and a small profile panel that toggles
// status / start / stop CPU profiling.

import { api } from '../../lib/api';

let activeContainer = null;
let state = {
  loading:  false,
  error:    null,
  leaders:  [],
  // pid -> { open: bool, info: any, infoErr: string|null, profileOpen: bool,
  //          profileStatus: string|null, profileMsg: string|null,
  //          profileErr: string|null, frequencyHz: string }
  rows:     new Map(),
};

export function mount(container) {
  activeContainer = container;
  state = { loading: false, error: null, leaders: [], rows: new Map() };
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
    <section class="system-page leaders-page">
      <div class="leaders-header">
        <h2 class="system-page-title">Leader processes</h2>
        <div class="leaders-actions">
          <button class="leaders-btn" data-act="refresh">refresh</button>
          <button class="leaders-btn leaders-btn--danger" data-act="kill-all">kill all</button>
        </div>
      </div>
      <p class="system-page-sub">
        Shared backend processes that grok clients attach to. Run
        <code>grok leader list</code> from a terminal for the same data.
      </p>
      <div class="leaders-status" data-role="status"></div>
      <div class="leaders-table-wrap" data-role="table"></div>
    </section>
  `;
  c.querySelector('[data-act=refresh]').addEventListener('click', refresh);
  c.querySelector('[data-act=kill-all]').addEventListener('click', onKillAll);
  renderStatus();
  renderTable();
}

function renderStatus() {
  if (!activeContainer) return;
  const el = activeContainer.querySelector('[data-role=status]');
  if (!el) return;
  if (state.loading) {
    el.textContent = 'loading...';
    el.className = 'leaders-status leaders-status--loading';
  } else if (state.error) {
    el.textContent = state.error;
    el.className = 'leaders-status leaders-status--error';
  } else {
    el.textContent = '';
    el.className = 'leaders-status';
  }
}

function renderTable() {
  if (!activeContainer) return;
  const wrap = activeContainer.querySelector('[data-role=table]');
  if (!wrap) return;
  if (state.loading && !state.leaders.length) {
    wrap.innerHTML = '';
    return;
  }
  if (!state.leaders.length) {
    wrap.innerHTML = `<div class="leaders-empty">No leaders running.</div>`;
    return;
  }

  const headers = ['pid', 'cwd', 'model', 'clients', 'uptime', 'memory', ''];
  const rows = state.leaders.map((ld) => renderRow(ld)).join('');
  wrap.innerHTML = `
    <table class="leaders-table">
      <thead>
        <tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  for (const ld of state.leaders) {
    const pid = String(ld.pid);
    const row = wrap.querySelector(`tr[data-pid="${cssEscape(pid)}"]`);
    if (!row) continue;
    row.querySelector('[data-act=toggle-info]')?.addEventListener('click', () => toggleInfo(pid));
    row.querySelector('[data-act=toggle-profile]')?.addEventListener('click', () => toggleProfile(pid));
  }
  for (const ld of state.leaders) {
    const pid = String(ld.pid);
    const detailRow = wrap.querySelector(`tr[data-detail-for="${cssEscape(pid)}"]`);
    if (!detailRow) continue;
    detailRow.querySelector('[data-act=profile-status]')?.addEventListener('click', () => doProfileStatus(pid));
    detailRow.querySelector('[data-act=profile-start]')?.addEventListener('click', () => doProfileStart(pid));
    detailRow.querySelector('[data-act=profile-stop]')?.addEventListener('click', () => doProfileStop(pid));
    detailRow.querySelector('[data-input=freq]')?.addEventListener('input', (e) => {
      const r = getRow(pid);
      r.frequencyHz = String(e.target.value || '');
    });
  }
}

function renderRow(ld) {
  const pid = String(ld.pid);
  const r   = getRow(pid);
  const expanded = r.open || r.profileOpen;
  const cells = [
    pid,
    truncate(ld.cwd ?? ld.cwd_path ?? '', 60),
    ld.model ?? '',
    formatClients(ld),
    ld.uptime ?? ld.uptime_human ?? formatUptime(ld.uptime_seconds),
    formatMemory(ld),
  ];
  const main = `
    <tr data-pid="${escapeHtml(pid)}" class="leaders-row ${expanded ? 'leaders-row--open' : ''}">
      ${cells.map(c => `<td>${escapeHtml(String(c))}</td>`).join('')}
      <td class="leaders-row-actions">
        <button class="leaders-btn leaders-btn--small" data-act="toggle-info">${r.open ? 'hide' : 'info'}</button>
        <button class="leaders-btn leaders-btn--small" data-act="toggle-profile">${r.profileOpen ? 'hide' : 'profile'}</button>
      </td>
    </tr>
  `;
  if (!expanded) return main;
  const sections = [];
  if (r.open) sections.push(renderInfoSection(r));
  if (r.profileOpen) sections.push(renderProfileSection(r));
  const detail = `
    <tr data-detail-for="${escapeHtml(pid)}" class="leaders-detail">
      <td colspan="7">
        ${sections.join('')}
      </td>
    </tr>
  `;
  return main + detail;
}

function renderInfoSection(r) {
  if (r.infoErr) {
    return `<div class="leaders-detail-section">
      <div class="leaders-detail-title">info</div>
      <div class="leaders-error">${escapeHtml(r.infoErr)}</div>
    </div>`;
  }
  if (!r.info) {
    return `<div class="leaders-detail-section">
      <div class="leaders-detail-title">info</div>
      <div class="leaders-muted">loading...</div>
    </div>`;
  }
  return `<div class="leaders-detail-section">
    <div class="leaders-detail-title">info</div>
    <pre class="leaders-pre">${escapeHtml(JSON.stringify(r.info, null, 2))}</pre>
  </div>`;
}

function renderProfileSection(r) {
  return `<div class="leaders-detail-section">
    <div class="leaders-detail-title">profile</div>
    <div class="leaders-profile-row">
      <button class="leaders-btn leaders-btn--small" data-act="profile-status">status</button>
      <label class="leaders-inline">
        freq hz
        <input class="leaders-input leaders-input--small" type="text" data-input="freq" value="${escapeHtml(r.frequencyHz)}" placeholder="default">
      </label>
      <button class="leaders-btn leaders-btn--small" data-act="profile-start">start</button>
      <button class="leaders-btn leaders-btn--small" data-act="profile-stop">stop</button>
    </div>
    ${r.profileErr ? `<div class="leaders-error">${escapeHtml(r.profileErr)}</div>` : ''}
    ${r.profileMsg ? `<pre class="leaders-pre">${escapeHtml(r.profileMsg)}</pre>` : ''}
  </div>`;
}

// ── actions ─────────────────────────────────────────────────────────────

async function refresh() {
  state.loading = true;
  state.error = null;
  renderStatus();
  try {
    const resp = await api.leaders.list();
    const data = (resp && resp.data) || resp;
    state.leaders = normalizeLeaders(data);
  } catch (err) {
    state.error = err.message || String(err);
    state.leaders = [];
  } finally {
    state.loading = false;
    renderStatus();
    renderTable();
  }
}

async function onKillAll() {
  if (!confirm('Kill ALL running grok leaders? Active sessions are preserved.')) return;
  state.loading = true;
  state.error = null;
  renderStatus();
  try {
    await api.leaders.killAll();
  } catch (err) {
    state.error = err.message || String(err);
  } finally {
    state.loading = false;
    renderStatus();
  }
  await refresh();
}

async function toggleInfo(pid) {
  const r = getRow(pid);
  r.open = !r.open;
  renderTable();
  if (r.open && r.info == null && !r.infoErr) {
    try {
      const resp = await api.leaders.info(pid);
      r.info = (resp && 'data' in resp) ? resp.data : resp;
    } catch (err) {
      r.infoErr = err.message || String(err);
    }
    renderTable();
  }
}

function toggleProfile(pid) {
  const r = getRow(pid);
  r.profileOpen = !r.profileOpen;
  renderTable();
}

async function doProfileStatus(pid) {
  const r = getRow(pid);
  r.profileErr = null;
  r.profileMsg = 'loading...';
  renderTable();
  try {
    const resp = await api.leaders.profileStatus(pid);
    r.profileMsg = (resp && resp.output) || JSON.stringify(resp, null, 2);
  } catch (err) {
    r.profileMsg = null;
    r.profileErr = err.message || String(err);
  }
  renderTable();
}

async function doProfileStart(pid) {
  const r = getRow(pid);
  r.profileErr = null;
  r.profileMsg = 'starting...';
  renderTable();
  const body = {};
  const hz = parseInt(r.frequencyHz, 10);
  if (Number.isFinite(hz) && hz > 0) body.frequencyHz = hz;
  try {
    const resp = await api.leaders.profileStart(pid, body);
    r.profileMsg = (resp && resp.output) || 'profile started';
  } catch (err) {
    r.profileMsg = null;
    r.profileErr = err.message || String(err);
  }
  renderTable();
}

async function doProfileStop(pid) {
  const r = getRow(pid);
  r.profileErr = null;
  r.profileMsg = 'stopping...';
  renderTable();
  try {
    const resp = await api.leaders.profileStop(pid, {});
    const out = (resp && resp.path) ? `wrote ${resp.path}` : 'profile stopped';
    r.profileMsg = out;
  } catch (err) {
    r.profileMsg = null;
    r.profileErr = err.message || String(err);
  }
  renderTable();
}

// ── helpers ─────────────────────────────────────────────────────────────

function getRow(pid) {
  let r = state.rows.get(pid);
  if (!r) {
    r = {
      open: false, info: null, infoErr: null,
      profileOpen: false, profileStatus: null, profileMsg: null,
      profileErr: null, frequencyHz: '',
    };
    state.rows.set(pid, r);
  }
  return r;
}

function normalizeLeaders(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.leaders)) return data.leaders;
  if (Array.isArray(data.rows)) return data.rows;
  if (Array.isArray(data.data)) return data.data;
  return [];
}

function formatClients(ld) {
  const c = ld.attached_clients ?? ld.clients ?? ld.attached ?? null;
  if (c == null) return '';
  if (typeof c === 'number') return String(c);
  if (Array.isArray(c)) return String(c.length);
  return String(c);
}

function formatMemory(ld) {
  const m = ld.memory ?? ld.memory_human ?? ld.rss ?? ld.memory_bytes;
  if (m == null) return '';
  if (typeof m === 'number') {
    if (m < 1024) return `${m} B`;
    if (m < 1024 * 1024) return `${(m / 1024).toFixed(1)} KB`;
    if (m < 1024 * 1024 * 1024) return `${(m / (1024 * 1024)).toFixed(1)} MB`;
    return `${(m / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  return String(m);
}

function formatUptime(secs) {
  if (secs == null) return '';
  const s = Number(secs);
  if (!Number.isFinite(s)) return String(secs);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
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
