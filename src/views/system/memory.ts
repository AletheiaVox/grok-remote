// Memory page.
//
// Lists grok memory files grouped by scope (workspace, global). Each file
// can be viewed, edited inline, renamed-via-recreate is not supported, and
// deleted. The page also keeps the legacy "clear" buttons that route through
// the grok CLI (`grok memory clear --scope`).
//
// Endpoints used live in lib/routes/system/memory.

import { api } from '../../lib/api.js';

interface MemoryFile {
  name: string;
  path: string;
  size: number;
  mtime?: string;
  snippet?: string;
}
interface MemoryRoot {
  scope: string;
  dir: string;
  exists: boolean;
  files?: MemoryFile[];
}
interface MemoryData {
  roots?: MemoryRoot[];
}
interface ReadResponse {
  ok?: boolean;
  content?: string;
  error?: string;
}
interface CreateResponse {
  ok?: boolean;
  path?: string;
  error?: string;
}

const SCOPE_LABEL: Record<string, string> = {
  workspace: 'workspace',
  global:    'global',
};
const SCOPE_ORDER = ['workspace', 'global'];

let activeContainer: HTMLElement | null = null;
let aborted = false;
let cachedData: MemoryData | null = null;
let selectedPath: string | null = null;
let editing = false;
let filterText = '';

export async function mount(container: HTMLElement): Promise<void> {
  activeContainer = container;
  aborted = false;
  selectedPath = null;
  editing = false;
  filterText = '';

  container.replaceChildren();
  container.innerHTML = `
    <section class="system-page memory-page memory-page--v2">
      <header class="system-page-header">
        <h2 class="system-page-title">Memory</h2>
        <p class="system-page-sub">
          The MEMORY.md plus any sibling notes grok keeps under
          <code>.grok/memory</code> for this workspace and your home.
          Edits write atomically. Clearing a scope wipes the file plus the
          matching session index; there is no undo.
        </p>
      </header>

      <div class="memory-toolbar">
        <input type="text" class="memory-search" placeholder="filter by name or content..." />
        <button type="button" class="memory-refresh-btn">refresh</button>
      </div>

      <div class="memory-layout">
        <aside class="memory-sidebar" data-role="sidebar">
          <div class="memory-sidebar-loading">loading...</div>
        </aside>
        <div class="memory-viewer" data-role="viewer">
          <div class="memory-viewer-empty">
            pick a memory file from the sidebar to view its content.
          </div>
        </div>
      </div>

      <footer class="memory-footer">
        <button type="button" class="memory-clear-all-btn" data-stage="idle">
          clear all memory
        </button>
        <span class="memory-footer-note">
          click twice to confirm. invokes <code>grok memory clear --all</code>.
        </span>
      </footer>

      <p class="memory-error" data-role="error" hidden></p>
    </section>
  `;

  wireToolbar(container);
  await reload(container);
}

export function unmount(): void {
  aborted = true;
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
  cachedData = null;
  selectedPath = null;
  editing = false;
}

async function reload(container: HTMLElement): Promise<void> {
  const sidebar = container.querySelector<HTMLElement>('[data-role="sidebar"]');
  if (sidebar) sidebar.innerHTML = `<div class="memory-sidebar-loading">loading...</div>`;
  try {
    const data = await api.memory.get() as MemoryData;
    if (aborted || activeContainer !== container) return;
    cachedData = data;
    renderSidebar(container);
    if (selectedPath && !findRecord(selectedPath)) {
      selectedPath = null;
      editing = false;
      void renderViewer(container);
    } else if (selectedPath) {
      void renderViewer(container);
    } else {
      void renderViewer(container);
    }
  } catch (err) {
    if (aborted || activeContainer !== container) return;
    showError(container, err instanceof Error ? err.message : String(err));
    if (sidebar) sidebar.innerHTML = '';
  }
}

function showError(container: HTMLElement, msg: string): void {
  const errEl = container.querySelector<HTMLElement>('[data-role="error"]');
  if (!errEl) return;
  errEl.hidden = false;
  errEl.textContent = msg || 'unknown error';
}

function clearError(container: HTMLElement): void {
  const errEl = container.querySelector<HTMLElement>('[data-role="error"]');
  if (!errEl) return;
  errEl.hidden = true;
  errEl.textContent = '';
}

function renderSidebar(container: HTMLElement): void {
  const sidebar = container.querySelector<HTMLElement>('[data-role="sidebar"]');
  if (!sidebar) return;
  sidebar.replaceChildren();
  const roots = Array.isArray(cachedData && cachedData.roots) ? cachedData!.roots! : [];
  if (!roots.length) {
    const empty = document.createElement('div');
    empty.className = 'memory-sidebar-loading';
    empty.textContent = 'no memory roots configured.';
    sidebar.appendChild(empty);
    return;
  }
  const ordered: MemoryRoot[] = SCOPE_ORDER
    .map(s => roots.find(r => r.scope === s))
    .filter((r): r is MemoryRoot => Boolean(r))
    .concat(roots.filter(r => !SCOPE_ORDER.includes(r.scope)));

  for (const root of ordered) {
    sidebar.appendChild(renderScopeGroup(container, root));
  }
}

function renderScopeGroup(container: HTMLElement, root: MemoryRoot): HTMLElement {
  const group = document.createElement('section');
  group.className = 'memory-scope';
  group.dataset.scope = root.scope;

  const head = document.createElement('header');
  head.className = 'memory-scope-head';
  const label = document.createElement('span');
  label.className = 'memory-scope-label';
  label.textContent = SCOPE_LABEL[root.scope] || root.scope;
  head.appendChild(label);

  const actions = document.createElement('div');
  actions.className = 'memory-scope-actions';
  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'memory-scope-btn';
  newBtn.textContent = '+ new';
  newBtn.title = 'create a new memory file in this scope';
  newBtn.addEventListener('click', () => { void createFile(container, root.scope); });
  actions.appendChild(newBtn);

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'memory-scope-btn memory-scope-btn--warn';
  clearBtn.textContent = 'clear';
  clearBtn.title = `grok memory clear --${root.scope}`;
  clearBtn.addEventListener('click', () => { void clearScope(container, root.scope, clearBtn); });
  actions.appendChild(clearBtn);

  head.appendChild(actions);
  group.appendChild(head);

  const dir = document.createElement('div');
  dir.className = 'memory-scope-dir';
  dir.textContent = shortenPath(root.dir);
  dir.title = root.dir;
  group.appendChild(dir);

  const list = document.createElement('ul');
  list.className = 'memory-file-list';

  const files = Array.isArray(root.files) ? root.files : [];
  const filtered = applyFilter(files);

  if (!filtered.length) {
    const empty = document.createElement('li');
    empty.className = 'memory-file-empty';
    if (!root.exists) empty.textContent = '(directory not yet created)';
    else if (!files.length) empty.textContent = '(no .md files)';
    else empty.textContent = '(no matches)';
    list.appendChild(empty);
  } else {
    for (const f of filtered) {
      list.appendChild(renderFileRow(container, f));
    }
  }

  group.appendChild(list);
  return group;
}

function renderFileRow(container: HTMLElement, rec: MemoryFile): HTMLElement {
  const li = document.createElement('li');
  li.className = 'memory-file';
  if (selectedPath === rec.path) li.classList.add('memory-file--active');
  li.dataset.path = rec.path;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'memory-file-pick';
  btn.title = rec.path;

  const top = document.createElement('div');
  top.className = 'memory-file-top';
  const name = document.createElement('span');
  name.className = 'memory-file-name';
  name.textContent = rec.name;
  const meta = document.createElement('span');
  meta.className = 'memory-file-meta';
  meta.textContent = fmtBytes(rec.size);
  top.appendChild(name);
  top.appendChild(meta);

  const snip = document.createElement('div');
  snip.className = 'memory-file-snip';
  snip.textContent = rec.snippet || '(empty)';

  btn.appendChild(top);
  btn.appendChild(snip);
  btn.addEventListener('click', () => {
    selectedPath = rec.path;
    editing = false;
    container.querySelectorAll<HTMLElement>('.memory-file').forEach(el => {
      el.classList.toggle('memory-file--active', el.dataset.path === selectedPath);
    });
    void renderViewer(container);
  });

  li.appendChild(btn);
  return li;
}

function applyFilter(files: MemoryFile[]): MemoryFile[] {
  if (!filterText.trim()) return files;
  const q = filterText.trim().toLowerCase();
  return files.filter(f => {
    if (f.name && f.name.toLowerCase().includes(q)) return true;
    if (f.snippet && f.snippet.toLowerCase().includes(q)) return true;
    return false;
  });
}

async function renderViewer(container: HTMLElement): Promise<void> {
  const viewer = container.querySelector<HTMLElement>('[data-role="viewer"]');
  if (!viewer) return;
  viewer.replaceChildren();
  if (!selectedPath) {
    const empty = document.createElement('div');
    empty.className = 'memory-viewer-empty';
    empty.textContent = 'pick a memory file from the sidebar to view its content.';
    viewer.appendChild(empty);
    return;
  }
  const rec = findRecord(selectedPath);
  if (!rec) {
    const empty = document.createElement('div');
    empty.className = 'memory-viewer-empty';
    empty.textContent = 'file not found (it may have been deleted).';
    viewer.appendChild(empty);
    return;
  }

  const head = document.createElement('header');
  head.className = 'memory-viewer-head';
  const title = document.createElement('div');
  title.className = 'memory-viewer-title';
  const nameEl = document.createElement('span');
  nameEl.className = 'memory-viewer-name';
  nameEl.textContent = rec.name;
  const pathEl = document.createElement('span');
  pathEl.className = 'memory-viewer-path';
  pathEl.textContent = shortenPath(rec.path);
  pathEl.title = rec.path;
  title.appendChild(nameEl);
  title.appendChild(pathEl);
  head.appendChild(title);

  const meta = document.createElement('dl');
  meta.className = 'memory-viewer-meta';
  meta.append(
    metaRow('size',  fmtBytes(rec.size)),
    metaRow('mtime', rec.mtime ? fmtTime(rec.mtime) : '-'),
  );
  head.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'memory-viewer-actions';
  if (!editing) {
    actions.appendChild(mkBtn('edit', '', () => {
      editing = true;
      void renderViewer(container);
    }));
    actions.appendChild(mkBtn('delete', 'memory-card-btn--warn', () => {
      void deleteFile(container, rec);
    }));
  }
  head.appendChild(actions);
  viewer.appendChild(head);

  const body = document.createElement('div');
  body.className = 'memory-viewer-body';
  body.textContent = 'loading...';
  viewer.appendChild(body);

  let content = '';
  try {
    const r = await api.memory.read(rec.path) as ReadResponse;
    if (aborted || activeContainer !== container) return;
    if (r && r.ok) content = r.content || '';
    else throw new Error((r && r.error) || 'read failed');
  } catch (err) {
    body.textContent = '';
    const errEl = document.createElement('div');
    errEl.className = 'memory-viewer-err';
    errEl.textContent = 'read failed: ' + (err instanceof Error ? err.message : String(err));
    body.appendChild(errEl);
    return;
  }

  body.textContent = '';
  if (!editing) {
    const pre = document.createElement('pre');
    pre.className = 'memory-viewer-pre';
    pre.textContent = content;
    body.appendChild(pre);
    return;
  }

  const ta = document.createElement('textarea');
  ta.className = 'memory-viewer-ta';
  ta.value = content;
  ta.spellcheck = false;
  ta.rows = 24;
  const bar = document.createElement('div');
  bar.className = 'memory-viewer-editbar';
  const status = document.createElement('span');
  status.className = 'memory-viewer-status';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'memory-card-btn memory-card-btn--good';
  saveBtn.textContent = 'save';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'memory-card-btn';
  cancelBtn.textContent = 'cancel';
  saveBtn.addEventListener('click', () => {
    void (async () => {
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      status.textContent = 'saving...';
      try {
        await api.memory.saveContent(rec.path, ta.value);
        status.textContent = 'saved.';
        editing = false;
        await reload(container);
      } catch (err) {
        status.textContent = 'save failed: ' + (err instanceof Error ? err.message : String(err));
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    })();
  });
  cancelBtn.addEventListener('click', () => {
    editing = false;
    void renderViewer(container);
  });
  bar.appendChild(saveBtn);
  bar.appendChild(cancelBtn);
  bar.appendChild(status);
  body.appendChild(ta);
  body.appendChild(bar);
}

async function createFile(container: HTMLElement, scope: string): Promise<void> {
  const raw = window.prompt('new memory file name (kebab-case, .md optional):', '');
  if (!raw) return;
  const trimmed = raw.trim();
  if (!trimmed) return;
  const cleaned = trimmed.replace(/\s+/g, '-');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\.md)?$/.test(cleaned)) {
    alert('invalid name. Use kebab-case (letters, digits, dot, dash, underscore).');
    return;
  }
  try {
    const r = await api.memory.createFile(scope, cleaned, '') as CreateResponse;
    if (r && r.ok && r.path) {
      selectedPath = r.path;
      editing = true;
      await reload(container);
    } else {
      alert('create failed: ' + ((r && r.error) || 'unknown'));
    }
  } catch (err) {
    alert('create failed: ' + (err instanceof Error ? err.message : String(err)));
  }
}

async function deleteFile(container: HTMLElement, rec: MemoryFile): Promise<void> {
  if (!window.confirm(`Delete ${rec.name}? This cannot be undone.`)) return;
  try {
    await api.memory.deleteFile(rec.path);
    if (selectedPath === rec.path) {
      selectedPath = null;
      editing = false;
    }
    await reload(container);
  } catch (err) {
    alert('delete failed: ' + (err instanceof Error ? err.message : String(err)));
  }
}

async function clearScope(container: HTMLElement, scope: string, btn: HTMLButtonElement): Promise<void> {
  const label = SCOPE_LABEL[scope] || scope;
  if (!window.confirm(`Clear ${label} memory? This cannot be undone.`)) return;
  clearError(container);
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'clearing...';
  try {
    await api.memory.clear(scope);
    await reload(container);
  } catch (err) {
    showError(container, err instanceof Error ? err.message : String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

function wireToolbar(container: HTMLElement): void {
  const search = container.querySelector<HTMLInputElement>('.memory-search');
  if (search) {
    search.addEventListener('input', () => {
      filterText = search.value || '';
      renderSidebar(container);
    });
  }
  const refresh = container.querySelector<HTMLButtonElement>('.memory-refresh-btn');
  if (refresh) {
    refresh.addEventListener('click', () => { void reload(container); });
  }
  const allBtn = container.querySelector<HTMLButtonElement>('.memory-clear-all-btn');
  if (allBtn) {
    allBtn.addEventListener('click', () => {
      void (async () => {
        if (allBtn.dataset.stage !== 'armed') {
          allBtn.dataset.stage = 'armed';
          allBtn.textContent = 'click again to confirm';
          setTimeout(() => {
            if (aborted) return;
            if (allBtn.dataset.stage === 'armed') {
              allBtn.dataset.stage = 'idle';
              allBtn.textContent = 'clear all memory';
            }
          }, 4000);
          return;
        }
        allBtn.dataset.stage = 'idle';
        allBtn.textContent = 'clear all memory';
        if (!window.confirm('Clear ALL memory (workspace + global)? This cannot be undone.')) return;
        clearError(container);
        allBtn.disabled = true;
        try {
          await api.memory.clear('all');
          await reload(container);
        } catch (err) {
          showError(container, err instanceof Error ? err.message : String(err));
        } finally {
          allBtn.disabled = false;
        }
      })();
    });
  }
}

function findRecord(p: string): MemoryFile | null {
  const roots = Array.isArray(cachedData && cachedData.roots) ? cachedData!.roots! : [];
  for (const r of roots) {
    for (const f of (r.files || [])) {
      if (f.path === p) return f;
    }
  }
  return null;
}

function mkBtn(label: string, cls: string, onclick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `memory-card-btn ${cls || ''}`.trim();
  b.textContent = label;
  b.addEventListener('click', onclick);
  return b;
}

function metaRow(label: string, value: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const dt = document.createElement('dt'); dt.textContent = label;
  const dd = document.createElement('dd'); dd.textContent = value;
  frag.append(dt, dd);
  return frag;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function shortenPath(p: string): string {
  if (!p) return '';
  const home = '/Users/dan';
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}
