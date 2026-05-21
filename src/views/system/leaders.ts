// Leader processes page.

import { api } from '../../lib/api.js';

interface Leader {
  pid: string | number;
  cwd?: string;
  cwd_path?: string;
  model?: string;
  attached_clients?: number | unknown[];
  clients?: number | unknown[];
  attached?: number | unknown[];
  uptime?: string;
  uptime_human?: string;
  uptime_seconds?: number;
  memory?: number | string;
  memory_human?: string;
  rss?: number;
  memory_bytes?: number;
  [k: string]: unknown;
}

interface RowState {
  open: boolean;
  info: unknown;
  infoErr: string | null;
  profileOpen: boolean;
  profileStatus: string | null;
  profileMsg: string | null;
  profileErr: string | null;
  frequencyHz: string;
}

interface LeadersState {
  loading: boolean;
  error: string | null;
  leaders: Leader[];
  rows: Map<string, RowState>;
}

let activeContainer: HTMLElement | null = null;
let state: LeadersState = freshState();

function freshState(): LeadersState {
  return { loading: false, error: null, leaders: [], rows: new Map() };
}

export function mount(container: HTMLElement): void {
  activeContainer = container;
  state = freshState();
  render();
  void refresh();
}

export function unmount(): void {
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

function render(): void {
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
  c.querySelector('[data-act=refresh]')?.addEventListener('click', () => void refresh());
  c.querySelector('[data-act=kill-all]')?.addEventListener('click', () => void onKillAll());
  renderStatus();
  renderTable();
}

function renderStatus(): void {
  if (!activeContainer) return;
  const el = activeContainer.querySelector('[data-role=status]') as HTMLElement | null;
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

function renderTable(): void {
  if (!activeContainer) return;
  const wrap = activeContainer.querySelector('[data-role=table]') as HTMLElement | null;
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
        <tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  for (const ld of state.leaders) {
    const pid = String(ld.pid);
    const row = wrap.querySelector(`tr[data-pid="${cssEscape(pid)}"]`);
    if (!row) continue;
    row.querySelector('[data-act=toggle-info]')?.addEventListener('click', () => void toggleInfo(pid));
    row.querySelector('[data-act=toggle-profile]')?.addEventListener('click', () => toggleProfile(pid));
  }
  for (const ld of state.leaders) {
    const pid = String(ld.pid);
    const detailRow = wrap.querySelector(`tr[data-detail-for="${cssEscape(pid)}"]`);
    if (!detailRow) continue;
    detailRow.querySelector('[data-act=profile-status]')?.addEventListener('click', () => void doProfileStatus(pid));
    detailRow.querySelector('[data-act=profile-start]')?.addEventListener('click', () => void doProfileStart(pid));
    detailRow.querySelector('[data-act=profile-stop]')?.addEventListener('click', () => void doProfileStop(pid));
    detailRow.querySelector('[data-input=freq]')?.addEventListener('input', (e: Event) => {
      const r = getRow(pid);
      r.frequencyHz = String((e.target as HTMLInputElement).value || '');
    });
  }
}

function renderRow(ld: Leader): string {
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
      ${cells.map((c) => `<td>${escapeHtml(String(c))}</td>`).join('')}
      <td class="leaders-row-actions">
        <button class="leaders-btn leaders-btn--small" data-act="toggle-info">${r.open ? 'hide' : 'info'}</button>
        <button class="leaders-btn leaders-btn--small" data-act="toggle-profile">${r.profileOpen ? 'hide' : 'profile'}</button>
      </td>
    </tr>
  `;
  if (!expanded) return main;
  const sections: string[] = [];
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

function renderInfoSection(r: RowState): string {
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

function renderProfileSection(r: RowState): string {
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

async function refresh(): Promise<void> {
  state.loading = true;
  state.error = null;
  renderStatus();
  try {
    const resp = await api.leaders.list() as { data?: unknown };
    const data = (resp && resp.data) || resp;
    state.leaders = normalizeLeaders(data);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    state.leaders = [];
  } finally {
    state.loading = false;
    renderStatus();
    renderTable();
  }
}

async function onKillAll(): Promise<void> {
  if (!confirm('Kill ALL running grok leaders? Active sessions are preserved.')) return;
  state.loading = true;
  state.error = null;
  renderStatus();
  try {
    await api.leaders.killAll();
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.loading = false;
    renderStatus();
  }
  await refresh();
}

async function toggleInfo(pid: string): Promise<void> {
  const r = getRow(pid);
  r.open = !r.open;
  renderTable();
  if (r.open && r.info == null && !r.infoErr) {
    try {
      const resp = await api.leaders.info(pid) as { data?: unknown };
      r.info = (resp && 'data' in resp) ? resp.data : resp;
    } catch (err) {
      r.infoErr = err instanceof Error ? err.message : String(err);
    }
    renderTable();
  }
}

function toggleProfile(pid: string): void {
  const r = getRow(pid);
  r.profileOpen = !r.profileOpen;
  renderTable();
}

async function doProfileStatus(pid: string): Promise<void> {
  const r = getRow(pid);
  r.profileErr = null;
  r.profileMsg = 'loading...';
  renderTable();
  try {
    const resp = await api.leaders.profileStatus(pid) as { output?: string };
    r.profileMsg = (resp && resp.output) || JSON.stringify(resp, null, 2);
  } catch (err) {
    r.profileMsg = null;
    r.profileErr = err instanceof Error ? err.message : String(err);
  }
  renderTable();
}

async function doProfileStart(pid: string): Promise<void> {
  const r = getRow(pid);
  r.profileErr = null;
  r.profileMsg = 'starting...';
  renderTable();
  const body: Record<string, unknown> = {};
  const hz = parseInt(r.frequencyHz, 10);
  if (Number.isFinite(hz) && hz > 0) body['frequencyHz'] = hz;
  try {
    const resp = await api.leaders.profileStart(pid, body) as { output?: string };
    r.profileMsg = (resp && resp.output) || 'profile started';
  } catch (err) {
    r.profileMsg = null;
    r.profileErr = err instanceof Error ? err.message : String(err);
  }
  renderTable();
}

async function doProfileStop(pid: string): Promise<void> {
  const r = getRow(pid);
  r.profileErr = null;
  r.profileMsg = 'stopping...';
  renderTable();
  try {
    const resp = await api.leaders.profileStop(pid, {}) as { path?: string };
    const out = (resp && resp.path) ? `wrote ${resp.path}` : 'profile stopped';
    r.profileMsg = out;
  } catch (err) {
    r.profileMsg = null;
    r.profileErr = err instanceof Error ? err.message : String(err);
  }
  renderTable();
}

function getRow(pid: string): RowState {
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

function normalizeLeaders(data: unknown): Leader[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as Leader[];
  const d = data as Record<string, unknown>;
  if (Array.isArray(d['leaders'])) return d['leaders'] as Leader[];
  if (Array.isArray(d['rows'])) return d['rows'] as Leader[];
  if (Array.isArray(d['data'])) return d['data'] as Leader[];
  return [];
}

function formatClients(ld: Leader): string {
  const c = ld.attached_clients ?? ld.clients ?? ld.attached ?? null;
  if (c == null) return '';
  if (typeof c === 'number') return String(c);
  if (Array.isArray(c)) return String(c.length);
  return String(c);
}

function formatMemory(ld: Leader): string {
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

function formatUptime(secs: number | undefined): string {
  if (secs == null) return '';
  const s = Number(secs);
  if (!Number.isFinite(s)) return String(secs);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function truncate(s: unknown, n: number): string {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n - 1) + '...' : str;
}

function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cssEscape(s: unknown): string {
  return String(s).replace(/["\\]/g, '\\$&');
}
