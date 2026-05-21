// Worktrees page.
//
// Two tabs:
//   list  - filter / show / rm / gc the grok-managed git worktrees
//   db    - inspect & rebuild the local index db

import { api } from '../../lib/api.js';

interface Worktree {
  id?: string;
  worktree_id?: string;
  path?: string;
  repo?: string;
  source_repo?: string;
  source?: string;
  branch?: string;
  age?: string;
  age_human?: string;
  created_at?: string | number;
  created?: string | number;
  [k: string]: unknown;
}

interface RowState {
  showOpen: boolean;
  showText: string | null;
  showErr: string | null;
  rmConfirm: boolean;
  rmForce: boolean;
  rmDryRun: boolean;
  rmOutput: string | null;
  rmErr: string | null;
  busy: boolean;
}

interface Filters {
  repo: string; type: string; all: boolean;
  [key: string]: string | boolean;
}
interface GcState {
  open: boolean; dryRun: boolean; maxAge: string; force: boolean;
  output: string | null; error: string | null; busy: boolean;
  [key: string]: string | boolean | null;
}
interface DbState {
  statsText: string | null; statsErr: string | null;
  pathText: string | null; pathErr: string | null;
  rebuildText: string | null; rebuildErr: string | null;
  busy: boolean;
}
interface WtState {
  tab: 'list' | 'db';
  loading: boolean;
  error: string | null;
  worktrees: Worktree[];
  filters: Filters;
  rows: Map<string, RowState>;
  gc: GcState;
  db: DbState;
}

let activeContainer: HTMLElement | null = null;
let state: WtState = freshState();

function freshState(): WtState {
  return {
    tab: 'list', loading: false, error: null, worktrees: [],
    filters: { repo: '', type: '', all: false },
    rows: new Map(),
    gc: { open: false, dryRun: false, maxAge: '', force: false, output: null, error: null, busy: false },
    db: { statsText: null, statsErr: null, pathText: null, pathErr: null, rebuildText: null, rebuildErr: null, busy: false },
  };
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
  for (const btn of c.querySelectorAll<HTMLButtonElement>('.worktrees-tab')) {
    btn.addEventListener('click', () => {
      const t = btn.getAttribute('data-tab');
      state.tab = (t === 'db' ? 'db' : 'list');
      renderBody();
    });
  }
  renderBody();
}

function renderBody(): void {
  if (!activeContainer) return;
  for (const btn of activeContainer.querySelectorAll<HTMLButtonElement>('.worktrees-tab')) {
    btn.classList.toggle('worktrees-tab--active', btn.getAttribute('data-tab') === state.tab);
  }
  const body = activeContainer.querySelector<HTMLElement>('[data-role=body]');
  if (!body) return;
  if (state.tab === 'list') {
    body.innerHTML = renderListTab();
    bindListTab(body);
  } else {
    body.innerHTML = renderDbTab();
    bindDbTab(body);
  }
}

function renderListTab(): string {
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

function renderStatusText(): string {
  if (state.loading) return '<span class="worktrees-status--loading">loading...</span>';
  if (state.error)   return `<span class="worktrees-status--error">${escapeHtml(state.error)}</span>`;
  return '';
}

function renderTable(): string {
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

function renderWtRow(wt: Worktree): string {
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
  const sections: string[] = [];
  if (r.showOpen) sections.push(renderShowSection(r));
  if (r.rmConfirm) sections.push(renderRmSection(id, r));
  return main + `
    <tr data-detail-for="${escapeHtml(id)}" class="worktrees-detail">
      <td colspan="5">${sections.join('')}</td>
    </tr>
  `;
}

function renderShowSection(r: RowState): string {
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

function renderRmSection(_id: string, r: RowState): string {
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

function renderGcForm(): string {
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

function bindListTab(root: HTMLElement): void {
  root.querySelector<HTMLButtonElement>('[data-act=refresh]')?.addEventListener('click', () => { void refresh(); });
  root.querySelector<HTMLButtonElement>('[data-act=toggle-gc]')?.addEventListener('click', () => {
    state.gc.open = !state.gc.open;
    renderBody();
  });
  for (const inp of root.querySelectorAll<HTMLInputElement>('[data-filter]')) {
    inp.addEventListener('change', () => {
      const k = inp.getAttribute('data-filter') as keyof Filters | null;
      if (!k) return;
      if (inp.type === 'checkbox') state.filters[k] = inp.checked;
      else state.filters[k] = inp.value;
    });
    inp.addEventListener('input', () => {
      const k = inp.getAttribute('data-filter') as keyof Filters | null;
      if (!k) return;
      if (inp.type !== 'checkbox') state.filters[k] = inp.value;
    });
  }

  for (const inp of root.querySelectorAll<HTMLInputElement>('[data-gc-input]')) {
    inp.addEventListener('change', () => {
      const k = inp.getAttribute('data-gc-input');
      if (!k) return;
      if (inp.type === 'checkbox') state.gc[k] = inp.checked;
      else state.gc[k] = inp.value;
    });
    inp.addEventListener('input', () => {
      const k = inp.getAttribute('data-gc-input');
      if (!k) return;
      if (inp.type !== 'checkbox') state.gc[k] = inp.value;
    });
  }
  root.querySelector<HTMLButtonElement>('[data-act=gc-run]')?.addEventListener('click', () => { void runGc(); });

  for (const wt of state.worktrees) {
    const id = String(wt.id ?? wt.worktree_id ?? wt.path ?? '');
    const row = root.querySelector<HTMLElement>(`tr[data-id="${cssEscape(id)}"]`);
    if (!row) continue;
    row.querySelector<HTMLButtonElement>('[data-act=show]')?.addEventListener('click', () => { void toggleShow(id); });
    row.querySelector<HTMLButtonElement>('[data-act=rm]')?.addEventListener('click', () => toggleRm(id));
    const detail = root.querySelector<HTMLElement>(`tr[data-detail-for="${cssEscape(id)}"]`);
    if (!detail) continue;
    detail.querySelector<HTMLButtonElement>('[data-act=rm-confirm]')?.addEventListener('click', () => { void doRm(id); });
    for (const inp of detail.querySelectorAll<HTMLInputElement>('[data-rm-input]')) {
      inp.addEventListener('change', () => {
        const k = inp.getAttribute('data-rm-input');
        const r = getRow(id);
        if (inp.type === 'checkbox') {
          if (k === 'force') r.rmForce = inp.checked;
          else if (k === 'dryRun') r.rmDryRun = inp.checked;
        }
      });
    }
  }
}

function renderDbTab(): string {
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

function bindDbTab(root: HTMLElement): void {
  root.querySelector<HTMLButtonElement>('[data-act=db-stats]')?.addEventListener('click', () => { void doDbStats(); });
  root.querySelector<HTMLButtonElement>('[data-act=db-path]')?.addEventListener('click', () => { void doDbPath(); });
  root.querySelector<HTMLButtonElement>('[data-act=db-rebuild]')?.addEventListener('click', () => { void doDbRebuild(); });
}

async function refresh(): Promise<void> {
  state.loading = true;
  state.error = null;
  renderBody();
  try {
    const opts = {
      all:  state.filters.all,
      repo: state.filters.repo.trim(),
      type: state.filters.type.trim(),
    };
    const resp = await api.worktrees.list(opts) as unknown;
    const data = (resp && typeof resp === 'object' && 'data' in (resp as Record<string, unknown>))
      ? (resp as Record<string, unknown>).data
      : resp;
    state.worktrees = normalizeWorktrees(data);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    state.worktrees = [];
  } finally {
    state.loading = false;
    renderBody();
  }
}

async function toggleShow(id: string): Promise<void> {
  const r = getRow(id);
  r.showOpen = !r.showOpen;
  renderBody();
  if (r.showOpen && r.showText == null && !r.showErr) {
    try {
      const resp = await api.worktrees.show(id) as { output?: string } | string | undefined;
      if (typeof resp === 'string') r.showText = resp;
      else if (resp && typeof resp === 'object' && typeof resp.output === 'string') r.showText = resp.output;
      else r.showText = JSON.stringify(resp, null, 2);
    } catch (err) {
      r.showErr = err instanceof Error ? err.message : String(err);
    }
    renderBody();
  }
}

function toggleRm(id: string): void {
  const r = getRow(id);
  r.rmConfirm = !r.rmConfirm;
  if (!r.rmConfirm) {
    r.rmOutput = null;
    r.rmErr = null;
  }
  renderBody();
}

async function doRm(id: string): Promise<void> {
  const r = getRow(id);
  r.busy = true;
  r.rmErr = null;
  r.rmOutput = null;
  renderBody();
  try {
    const resp = await api.worktrees.rm(id, { force: r.rmForce, dryRun: r.rmDryRun }) as { output?: string } | undefined;
    r.rmOutput = (resp && resp.output) || JSON.stringify(resp, null, 2);
  } catch (err) {
    r.rmErr = err instanceof Error ? err.message : String(err);
  } finally {
    r.busy = false;
  }
  renderBody();
  if (!r.rmErr && !r.rmDryRun) {
    setTimeout(() => { void refresh(); }, 250);
  }
}

async function runGc(): Promise<void> {
  const g = state.gc;
  if (!confirm(`Run grok worktree gc${g.dryRun ? ' (dry run)' : ''}?`)) return;
  g.busy = true;
  g.error = null;
  g.output = null;
  renderBody();
  try {
    const body: { dryRun?: boolean; force?: boolean; maxAge?: string } = {};
    if (g.dryRun) body.dryRun = true;
    if (g.force)  body.force = true;
    if (g.maxAge && g.maxAge.trim()) body.maxAge = g.maxAge.trim();
    const resp = await api.worktrees.gc(body) as { output?: string } | undefined;
    g.output = (resp && resp.output) || JSON.stringify(resp, null, 2);
  } catch (err) {
    g.error = err instanceof Error ? err.message : String(err);
  } finally {
    g.busy = false;
  }
  renderBody();
  if (!g.error && !g.dryRun) setTimeout(() => { void refresh(); }, 250);
}

async function doDbStats(): Promise<void> {
  state.db.busy = true;
  state.db.statsErr = null;
  state.db.statsText = 'loading...';
  renderBody();
  try {
    const resp = await api.worktrees.dbStats() as { output?: string } | undefined;
    state.db.statsText = (resp && resp.output) || JSON.stringify(resp, null, 2);
  } catch (err) {
    state.db.statsText = null;
    state.db.statsErr = err instanceof Error ? err.message : String(err);
  } finally {
    state.db.busy = false;
  }
  renderBody();
}

async function doDbPath(): Promise<void> {
  state.db.busy = true;
  state.db.pathErr = null;
  state.db.pathText = 'loading...';
  renderBody();
  try {
    const resp = await api.worktrees.dbPath() as { output?: string } | undefined;
    state.db.pathText = (resp && resp.output) || JSON.stringify(resp, null, 2);
  } catch (err) {
    state.db.pathText = null;
    state.db.pathErr = err instanceof Error ? err.message : String(err);
  } finally {
    state.db.busy = false;
  }
  renderBody();
}

async function doDbRebuild(): Promise<void> {
  if (!confirm('Rebuild the worktree index by scanning the filesystem?')) return;
  state.db.busy = true;
  state.db.rebuildErr = null;
  state.db.rebuildText = 'running...';
  renderBody();
  try {
    const resp = await api.worktrees.dbRebuild() as { output?: string } | undefined;
    state.db.rebuildText = (resp && resp.output) || JSON.stringify(resp, null, 2);
  } catch (err) {
    state.db.rebuildText = null;
    state.db.rebuildErr = err instanceof Error ? err.message : String(err);
  } finally {
    state.db.busy = false;
  }
  renderBody();
}

function getRow(id: string): RowState {
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

function normalizeWorktrees(data: unknown): Worktree[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as Worktree[];
  if (typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.worktrees)) return d.worktrees as Worktree[];
    if (Array.isArray(d.rows)) return d.rows as Worktree[];
    if (Array.isArray(d.data)) return d.data as Worktree[];
  }
  return [];
}

function formatAge(when: string | number | undefined): string {
  if (!when) return '';
  const t = typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(t)) return String(when);
  const secs = Math.max(0, (Date.now() - t) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
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

function cssEscape(s: string): string {
  return String(s).replace(/["\\]/g, '\\$&');
}
