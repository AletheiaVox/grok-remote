// Files tab: lists the agent's cwd and previews text files.

import { api } from '../lib/api.js';
import { el, escapeHtml } from '../lib/render.js';
import { iconHtml } from '../lib/icons.js';

const TREE_COLLAPSED_KEY = 'grok-remote.files.treeCollapsed';

function readTreeCollapsed(): boolean {
  try { return localStorage.getItem(TREE_COLLAPSED_KEY) === '1'; }
  catch { return false; }
}

function writeTreeCollapsed(v: boolean): void {
  try { localStorage.setItem(TREE_COLLAPSED_KEY, v ? '1' : '0'); }
  catch { /* ignore */ }
}

interface FilesAgent { id: string; [k: string]: unknown }

interface FilesState {
  agent: FilesAgent;
  container: HTMLElement;
  currentPath: string;
  selectedFile: string | null;
  destroyed: boolean;
  root?: HTMLElement;
  treeBody?: HTMLElement;
  breadcrumb?: HTMLElement;
  viewerBody?: HTMLElement;
  viewerTitle?: HTMLElement;
  backBtn?: HTMLElement;
  treeToggleBtn?: HTMLButtonElement;
  treeCollapsed?: boolean;
  onFilesChanged?: (ev: Event) => void;
  htmlMode?: 'preview' | 'source';
}

interface FileEntry { name: string; type: 'directory' | 'file'; size?: number; isHidden?: boolean }
interface DirResponse { type: 'directory'; entries?: FileEntry[] }
interface FileResponse {
  type: 'file';
  size?: number;
  truncated?: boolean;
  binary?: boolean;
  content?: string;
}

let activeState: FilesState | null = null;

function storageKey(agentId: string): string {
  return `grok-remote.files.${agentId}.path`;
}

function readStoredPath(agentId: string): string {
  try { return localStorage.getItem(storageKey(agentId)) || ''; }
  catch { return ''; }
}

function writeStoredPath(agentId: string, p: string): void {
  try { localStorage.setItem(storageKey(agentId), p || ''); }
  catch { /* ignore */ }
}

function fmtSize(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

function parentPath(p: string): string {
  if (!p) return '';
  const cleaned = p.replace(/\/+$/, '');
  const i = cleaned.lastIndexOf('/');
  return i < 0 ? '' : cleaned.slice(0, i);
}

function applyTreeCollapsedClass(state: FilesState): void {
  if (!state.root) return;
  state.root.classList.toggle('files--tree-collapsed', !!state.treeCollapsed);
  if (state.treeToggleBtn) {
    const c = !!state.treeCollapsed;
    state.treeToggleBtn.innerHTML = iconHtml(c ? 'panel-left-open' : 'panel-left-close');
    state.treeToggleBtn.title = c ? 'show file list' : 'hide file list';
  }
}

function setTreeCollapsed(state: FilesState, next: boolean): void {
  if (!state) return;
  state.treeCollapsed = !!next;
  writeTreeCollapsed(state.treeCollapsed);
  applyTreeCollapsedClass(state);
}

export function mountFilesTab(container: HTMLElement, agent: FilesAgent | null | undefined): void {
  unmountFilesTab();
  if (!container) return;
  if (!agent || !agent.id) {
    const empty = el('div', { class: 'pane-empty' }, 'no agent selected');
    container.replaceChildren(empty);
    return;
  }

  const state: FilesState = {
    agent,
    container,
    currentPath: readStoredPath(agent.id),
    selectedFile: null,
    destroyed: false,
  };
  activeState = state;

  const refreshBtn = el('button', {
    class: 'btn btn--ghost files-refresh',
    title: 'refresh',
    onclick: () => loadDir(state, state.currentPath),
  }, 'refresh');

  const backBtn = el('button', {
    class: 'btn btn--ghost files-back hidden',
    onclick: () => {
      state.selectedFile = null;
      renderViewer(state);
      state.root?.classList.remove('files--show-viewer');
    },
  }, '< back') as HTMLButtonElement;

  const breadcrumb = el('div', { class: 'files-breadcrumb' }) as HTMLElement;
  const treeBody = el('div', { class: 'files-tree-body' }) as HTMLElement;
  const viewerBody = el('div', { class: 'files-viewer-body' },
    el('div', { class: 'pane-empty' }, 'select a file to preview')) as HTMLElement;

  const treeToggleBtn = el('button', {
    type: 'button',
    class: 'files-tree-toggle',
    title: 'collapse file list',
    'aria-label': 'toggle file list',
    onclick: () => setTreeCollapsed(state, !state.treeCollapsed),
  }) as HTMLButtonElement;

  const tree = el('div', { class: 'files-tree' },
    el('div', { class: 'files-tree-header' },
      breadcrumb,
      refreshBtn,
    ),
    treeBody,
  );
  const viewer = el('div', { class: 'files-viewer' },
    el('div', { class: 'files-viewer-header' },
      treeToggleBtn,
      backBtn,
      el('div', { class: 'files-viewer-title' }, ''),
    ),
    viewerBody,
  ) as HTMLElement;

  const root = el('div', { class: 'files files--show-tree' }, tree, viewer) as HTMLElement;
  state.root = root;
  state.treeBody = treeBody;
  state.breadcrumb = breadcrumb;
  state.viewerBody = viewerBody;
  state.viewerTitle = viewer.querySelector('.files-viewer-title') as HTMLElement | undefined;
  state.backBtn = backBtn;
  state.treeToggleBtn = treeToggleBtn;
  state.treeCollapsed = readTreeCollapsed();
  applyTreeCollapsedClass(state);

  container.replaceChildren(root);

  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  state.onFilesChanged = (ev: Event): void => {
    const d = (ev as CustomEvent).detail as { agentId?: string } | undefined;
    if (!d || !state.agent || d.agentId !== state.agent.id) return;
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (state.destroyed) return;
      void loadDir(state, state.currentPath);
    }, 250);
  };
  document.addEventListener('grok-remote:files-changed', state.onFilesChanged);

  void loadDir(state, state.currentPath);
}

export function unmountFilesTab(): void {
  if (!activeState) return;
  if (activeState.onFilesChanged) {
    document.removeEventListener('grok-remote:files-changed', activeState.onFilesChanged);
  }
  activeState.destroyed = true;
  activeState = null;
}

async function loadDir(state: FilesState, p: string): Promise<void> {
  if (state.destroyed) return;
  state.currentPath = p || '';
  writeStoredPath(state.agent.id, state.currentPath);
  renderBreadcrumb(state);
  state.treeBody?.replaceChildren(el('div', { class: 'files-loading' }, 'loading...'));
  try {
    const res = await api.listFiles(state.agent.id, state.currentPath) as DirResponse | FileResponse | null;
    if (state.destroyed) return;
    if (!res || res.type !== 'directory') {
      if (res && (res as FileResponse).type === 'file') {
        const parent = parentPath(state.currentPath);
        state.selectedFile = state.currentPath;
        state.currentPath = parent;
        writeStoredPath(state.agent.id, state.currentPath);
        renderBreadcrumb(state);
        const r2 = await api.listFiles(state.agent.id, state.currentPath) as DirResponse;
        renderDir(state, r2);
        await openFile(state, state.selectedFile);
        return;
      }
      state.treeBody?.replaceChildren(el('div', { class: 'pane-empty' }, 'empty'));
      return;
    }
    renderDir(state, res);
  } catch (err) {
    if (state.destroyed) return;
    const msg = err instanceof Error ? err.message : 'failed to load directory';
    state.treeBody?.replaceChildren(
      el('div', { class: 'files-error' }, `error: ${msg}`),
    );
    if (state.currentPath) {
      state.currentPath = '';
      writeStoredPath(state.agent.id, '');
      setTimeout(() => loadDir(state, ''), 0);
    }
  }
}

function renderBreadcrumb(state: FilesState): void {
  const parts: Element[] = [];
  parts.push(el('button', {
    class: 'files-crumb',
    onclick: () => loadDir(state, ''),
  }, 'cwd'));
  if (state.currentPath) {
    const segments = state.currentPath.split('/').filter(Boolean);
    let acc = '';
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      const here = acc;
      parts.push(el('span', { class: 'files-crumb-sep' }, '/'));
      parts.push(el('button', {
        class: 'files-crumb',
        onclick: () => loadDir(state, here),
      }, seg));
    }
  }
  state.breadcrumb?.replaceChildren(...parts);
}

function renderDir(state: FilesState, res: DirResponse): void {
  const entries = Array.isArray(res.entries) ? res.entries : [];
  const rows: Element[] = [];

  if (state.currentPath) {
    rows.push(el('button', {
      class: 'files-row files-row--up',
      onclick: () => loadDir(state, parentPath(state.currentPath)),
    },
      el('span', { class: 'files-row-icon' }, '..'),
      el('span', { class: 'files-row-name' }, 'parent directory'),
    ));
  }

  for (const ent of entries) {
    const isDir = ent.type === 'directory';
    const row = el('button', {
      class: `files-row files-row--${isDir ? 'dir' : 'file'}${ent.isHidden ? ' files-row--hidden' : ''}`,
      onclick: isDir
        ? () => loadDir(state, joinPath(state.currentPath, ent.name))
        : () => {
            const full = joinPath(state.currentPath, ent.name);
            void openFile(state, full);
          },
    },
      el('span', { class: 'files-row-icon' }, isDir ? 'dir' : 'doc'),
      el('span', { class: 'files-row-name' }, ent.name + (isDir ? '/' : '')),
      el('span', { class: 'files-row-size' }, isDir ? '' : fmtSize(ent.size)),
    );
    rows.push(row);
  }

  if (!rows.length) {
    state.treeBody?.replaceChildren(el('div', { class: 'pane-empty' }, 'empty directory'));
    return;
  }
  state.treeBody?.replaceChildren(...rows);
}

async function openFile(state: FilesState, filePath: string): Promise<void> {
  state.selectedFile = filePath;
  if (state.viewerTitle) state.viewerTitle.textContent = filePath;
  state.viewerBody?.replaceChildren(el('div', { class: 'files-loading' }, 'loading...'));
  state.root?.classList.add('files--show-viewer');
  state.backBtn?.classList.remove('hidden');

  if (isImagePath(filePath) || isVideoPath(filePath) || isAudioPath(filePath)) {
    renderMediaViewer(state, filePath);
    return;
  }

  try {
    const res = await api.readFile(state.agent.id, filePath) as FileResponse;
    if (state.destroyed) return;
    renderViewerContents(state, res);
  } catch (err) {
    if (state.destroyed) return;
    const msg = err instanceof Error ? err.message : 'failed to read file';
    state.viewerBody?.replaceChildren(
      el('div', { class: 'files-error' }, `error: ${msg}`),
    );
  }
}

function isImagePath(p: string | null | undefined): boolean { return /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(String(p || '')); }
function isVideoPath(p: string | null | undefined): boolean { return /\.(mp4|webm|mov|ogv|m4v)$/i.test(String(p || '')); }
function isAudioPath(p: string | null | undefined): boolean { return /\.(mp3|wav|ogg|m4a|flac)$/i.test(String(p || '')); }

function basename(p: string | null | undefined): string {
  const cleaned = String(p || '').replace(/\/+$/, '');
  const i = cleaned.lastIndexOf('/');
  return i < 0 ? cleaned : cleaned.slice(i + 1);
}

function renderMediaViewer(state: FilesState, filePath: string): void {
  const rawUrl = api.fileRawUrl(state.agent.id, filePath);

  const popoutBtn = el('button', {
    class: 'files-html-popout',
    type: 'button',
    title: 'Open in a new browser tab',
    onclick: () => window.open(rawUrl, '_blank', 'noopener,noreferrer'),
  }, 'Open in new tab');

  const toolbar = el('div', { class: 'files-media-toolbar' },
    el('span', { class: 'files-media-name' }, basename(filePath)),
    el('span', { class: 'files-html-spacer' }),
    popoutBtn,
  );

  let media: HTMLElement;
  if (isImagePath(filePath)) {
    const img = document.createElement('img');
    img.className = 'files-media-image';
    img.src = rawUrl;
    img.alt = basename(filePath);
    media = img;
  } else if (isVideoPath(filePath)) {
    const video = document.createElement('video');
    video.className = 'files-media-video';
    video.controls = true;
    video.preload = 'metadata';
    video.src = rawUrl;
    media = video;
  } else {
    const audio = document.createElement('audio');
    audio.className = 'files-media-audio';
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = rawUrl;
    media = audio;
  }

  state.viewerBody?.replaceChildren(
    el('div', { class: 'files-media-wrap' },
      toolbar,
      media,
    ),
  );
}

function renderViewer(state: FilesState): void {
  if (!state.selectedFile) {
    if (state.viewerTitle) state.viewerTitle.textContent = '';
    state.viewerBody?.replaceChildren(
      el('div', { class: 'pane-empty' }, 'select a file to preview'),
    );
    state.backBtn?.classList.add('hidden');
  }
}

function renderViewerContents(state: FilesState, res: FileResponse): void {
  if (!res || res.type !== 'file') {
    state.viewerBody?.replaceChildren(
      el('div', { class: 'files-error' }, 'unexpected response'),
    );
    return;
  }
  const header = el('div', { class: 'files-viewer-meta' },
    el('span', { class: 'files-viewer-size' }, fmtSize(res.size)),
  );

  if (res.truncated) {
    state.viewerBody?.replaceChildren(
      header,
      el('div', { class: 'files-placeholder' },
        el('div', { class: 'files-placeholder-title' }, 'file too large to preview'),
        el('div', { class: 'files-placeholder-sub' }, `${fmtSize(res.size)} exceeds the inline preview limit.`),
      ),
    );
    return;
  }
  if (res.binary) {
    state.viewerBody?.replaceChildren(
      header,
      el('div', { class: 'files-placeholder' },
        el('div', { class: 'files-placeholder-title' }, 'binary file'),
        el('div', { class: 'files-placeholder-sub' }, `${fmtSize(res.size)} of binary data. preview not shown.`),
      ),
    );
    return;
  }

  const content = String(res.content || '');

  if (isHtmlPath(state.selectedFile)) {
    renderHtmlViewer(state, header as HTMLElement, content);
    return;
  }

  state.viewerBody?.replaceChildren(
    header,
    buildCodeBlock(content),
  );
}

function isHtmlPath(p: string | null | undefined): boolean {
  return /\.(html?|xhtml)$/i.test(String(p || ''));
}

function buildCodeBlock(content: string): HTMLElement {
  const lines = content.length ? content.split('\n') : [''];
  const gutter = el('div', { class: 'files-code-gutter' }) as HTMLElement;
  const body = el('div', { class: 'files-code-body' }) as HTMLElement;
  let gutterHtml = '';
  let bodyHtml = '';
  for (let i = 0; i < lines.length; i++) {
    gutterHtml += `<div class="files-code-lineno">${i + 1}</div>`;
    bodyHtml += `<div class="files-code-line">${escapeHtml(lines[i] || '') || '&nbsp;'}</div>`;
  }
  gutter.innerHTML = gutterHtml;
  body.innerHTML = bodyHtml;
  return el('pre', { class: 'files-code' }, gutter, body) as HTMLElement;
}

function renderHtmlViewer(state: FilesState, header: HTMLElement, content: string): void {
  if (!state.htmlMode) state.htmlMode = 'preview';

  const sourceBtn = el('button', {
    class: `files-html-tab${state.htmlMode === 'source' ? ' is-active' : ''}`,
    type: 'button',
    onclick: () => { state.htmlMode = 'source'; renderHtmlViewer(state, header, content); },
  }, 'Source');

  const previewBtn = el('button', {
    class: `files-html-tab${state.htmlMode === 'preview' ? ' is-active' : ''}`,
    type: 'button',
    onclick: () => { state.htmlMode = 'preview'; renderHtmlViewer(state, header, content); },
  }, 'Preview');

  const popoutBtn = el('button', {
    class: 'files-html-popout',
    type: 'button',
    title: 'Open in a new browser tab',
    onclick: () => openHtmlInNewTab(content),
  }, 'Open in new tab');

  const toolbar = el('div', { class: 'files-html-toolbar' },
    sourceBtn,
    previewBtn,
    el('span', { class: 'files-html-spacer' }),
    popoutBtn,
  );

  let body: HTMLElement;
  if (state.htmlMode === 'preview') {
    const iframe = document.createElement('iframe');
    iframe.className = 'files-html-iframe';
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.srcdoc = content;
    body = iframe;
  } else {
    body = buildCodeBlock(content);
  }

  state.viewerBody?.replaceChildren(
    el('div', { class: 'files-html-wrap' },
      header,
      toolbar,
      body,
    ),
  );
}

function openHtmlInNewTab(content: string): void {
  try {
    const blob = new Blob([content], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    alert(`Could not open preview: ${msg}`);
  }
}

export default mountFilesTab;
