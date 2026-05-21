// Subagents page.

import { api } from '../../lib/api.js';
import {
  loadInspect, buildPageShell, setStatusLine, clearBody,
  addConfigFilesBanner,
  buildGroup, emptyState, buildFooterHint,
  shortenPath, scopeLabel, safeStringify,
  type ConfigFile,
} from './_native_common.js';

interface AgentSource { type?: string; path?: string; plugin_name?: string }
interface AgentRecord {
  name?: string;
  description?: string;
  model?: string;
  tools?: unknown[];
  source?: AgentSource;
  [k: string]: unknown;
}

interface InspectShape {
  agents?: AgentRecord[];
  cwd?: string;
}

let activeContainer: HTMLElement | null = null;
let aborted = false;
let cachedInspect: unknown = null;

const BLURB = `
  Subagents are named worker profiles you can spawn from inside a
  conversation (the parent agent calls them with the <code>Agent</code>
  tool). Each has a description, a system prompt, a model, and an allowed
  tool set. They live as <code>.md</code> files under
  <code>~/.grok/agents/</code> or <code>&lt;project&gt;/.grok/agents/</code>.
  The parent picks one by name; sub-agents inherit nothing else from the
  parent's session.
`;

export async function mount(container: HTMLElement): Promise<void> {
  activeContainer = container;
  aborted = false;
  const section = buildPageShell(container, { title: 'Subagents', blurb: BLURB });
  await reload(section);
}

export function unmount(): void {
  aborted = true;
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
  cachedInspect = null;
}

async function reload(section: HTMLElement): Promise<void> {
  const { inspect, error } = await loadInspect();
  if (aborted) return;
  if (error) { setStatusLine(section, 'failed to load: ' + error); return; }
  cachedInspect = inspect;

  const data = (inspect && typeof inspect === 'object') ? inspect as InspectShape : {};
  const agents = Array.isArray(data.agents) ? data.agents : [];
  const userRoot = agents.find((a) => a.source?.type === 'user' && a.source?.path)?.source?.path?.replace(/\/[^/]+\.md$/, '');
  const projRoot = agents.find((a) => (a.source?.type === 'project' || a.source?.type === 'cwd' || a.source?.type === 'workspace') && a.source?.path)?.source?.path?.replace(/\/[^/]+\.md$/, '');
  const cwd = data.cwd;
  const banner: ConfigFile[] = [
    { label: 'user agents', path: userRoot || '~/.grok/agents' },
    ...(cwd ? [{ label: 'project agents', path: projRoot || `${cwd}/.grok/agents` }] : []),
  ];
  addConfigFilesBanner(section, banner);
  clearBody(section);

  const toolbar = document.createElement('div');
  toolbar.style.display = 'flex';
  toolbar.style.gap = '8px';
  toolbar.style.alignItems = 'center';
  toolbar.appendChild(mkPrimaryButton('+ new (user)', () => void createAgent('user', section)));
  toolbar.appendChild(mkPrimaryButton('+ new (workspace)', () => void createAgent('workspace', section)));
  toolbar.appendChild(mkSecondaryButton('refresh', () => void reload(section)));
  section.appendChild(toolbar);

  if (!agents.length) {
    section.appendChild(emptyState({ message: 'no subagents discovered.' }));
    return;
  }

  const ORDER = ['workspace', 'project', 'cwd', 'user', 'builtin', 'plugin'];
  const byKey = new Map<string, AgentRecord[]>();
  for (const a of agents) {
    const src = (a.source && a.source.type) ? String(a.source.type).toLowerCase() : 'other';
    if (!byKey.has(src)) byKey.set(src, []);
    byKey.get(src)!.push(a);
  }
  const keys = [...byKey.keys()].sort((a, b) => {
    const ia = ORDER.indexOf(a); const ib = ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1; if (ib === -1) return -1;
    return ia - ib;
  });
  for (const key of keys) {
    const items = byKey.get(key) || [];
    items.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const { wrap, list } = buildGroup({ label: scopeLabel(key), count: items.length });
    for (const a of items) list.appendChild(makeAgentCard(a, section));
    section.appendChild(wrap);
  }

  section.appendChild(buildFooterHint(
    'Built-in subagents ship with the grok binary and cannot be edited from ' +
    'the dashboard. User and workspace subagents are plain Markdown with YAML ' +
    'frontmatter; the "+ new" buttons above scaffold a stub for you.',
  ));
}

function makeAgentCard(a: AgentRecord, section: HTMLElement): HTMLElement {
  const card = document.createElement('div');
  card.className = 'health-item';

  const head = document.createElement('div');
  head.className = 'health-item-head';
  const left = document.createElement('div');
  left.className = 'health-item-left';

  const name = document.createElement('span');
  name.className = 'health-item-name';
  name.textContent = a.name || '(unnamed)';
  left.appendChild(name);

  const srcType = (a.source && a.source.type) || '';
  const sec = document.createElement('span');
  sec.className = 'health-item-secondary';
  sec.textContent = scopeLabel(srcType);
  left.appendChild(sec);

  const tags: string[] = [];
  if (a.model) tags.push(`model: ${a.model}`);
  if (Array.isArray(a.tools)) tags.push(`tools: ${a.tools.length}`);
  if (tags.length) {
    const tagWrap = document.createElement('span');
    tagWrap.className = 'health-item-tags';
    for (const t of tags) {
      const tag = document.createElement('span');
      tag.className = 'health-item-tag';
      tag.textContent = t;
      tagWrap.appendChild(tag);
    }
    left.appendChild(tagWrap);
  }
  head.appendChild(left);

  const right = document.createElement('div');
  right.style.display = 'inline-flex';
  right.style.gap = '6px';
  right.style.alignItems = 'center';

  const fromPath = (a.source && a.source.path) || '';
  const editable = !!fromPath && (srcType === 'user' || srcType === 'workspace' || srcType === 'project' || srcType === 'cwd');

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'health-item-toggle';
  editBtn.textContent = editable ? 'edit' : 'view';
  right.appendChild(editBtn);

  let delBtn: HTMLButtonElement | null = null;
  if (editable) {
    delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'health-item-toggle';
    delBtn.textContent = 'delete';
    delBtn.title = 'delete this .md file';
    right.appendChild(delBtn);
  }

  const jsonBtn = document.createElement('button');
  jsonBtn.type = 'button';
  jsonBtn.className = 'health-item-toggle';
  jsonBtn.textContent = 'show json';
  right.appendChild(jsonBtn);
  head.appendChild(right);
  card.appendChild(head);

  if (a.description) {
    const p = document.createElement('p');
    p.className = 'health-item-desc';
    p.textContent = a.description;
    card.appendChild(p);
  }
  if (fromPath) {
    const src = document.createElement('div');
    src.className = 'health-item-source';
    const lbl = document.createElement('span');
    lbl.className = 'health-item-source-label';
    lbl.textContent = a.source?.plugin_name
      ? `from plugin: ${a.source.plugin_name}`
      : `defined in ${scopeLabel(srcType || 'user')}:`;
    src.appendChild(lbl);
    const code = document.createElement('code');
    code.className = 'health-path';
    code.textContent = fromPath;
    src.appendChild(code);
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'health-copy-btn';
    copyBtn.textContent = 'copy';
    copyBtn.title = 'copy path to clipboard';
    copyBtn.addEventListener('click', async (ev: MouseEvent) => {
      ev.stopPropagation();
      try {
        await navigator.clipboard.writeText(fromPath);
        copyBtn.textContent = 'copied';
        setTimeout(() => { copyBtn.textContent = 'copy'; }, 1200);
      } catch { /* ignore */ }
    });
    src.appendChild(copyBtn);
    card.appendChild(src);
  } else if (srcType === 'builtin') {
    const note = document.createElement('div');
    note.className = 'health-item-source';
    note.innerHTML = '<span class="health-item-source-label">source</span><span class="health-dim">built into grok (no file on disk)</span>';
    card.appendChild(note);
  }

  const jsonPanel = document.createElement('pre');
  jsonPanel.className = 'health-json-block hidden';
  jsonPanel.textContent = safeStringify(a, 2);
  card.appendChild(jsonPanel);

  const filePanel = document.createElement('div');
  filePanel.className = 'health-json-block hidden';
  filePanel.style.background = 'transparent';
  filePanel.style.border = 'none';
  filePanel.style.padding = '0';
  card.appendChild(filePanel);

  jsonBtn.addEventListener('click', () => {
    const hidden = jsonPanel.classList.toggle('hidden');
    jsonBtn.textContent = hidden ? 'show json' : 'hide json';
  });
  editBtn.addEventListener('click', () => {
    if (!filePanel.classList.contains('hidden')) {
      filePanel.classList.add('hidden');
      editBtn.textContent = editable ? 'edit' : 'view';
      return;
    }
    void openFile(a, fromPath, filePanel, editBtn, editable, section);
  });
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      if (!confirm(`delete ${a.name}? this removes ${shortenPath(fromPath)}`)) return;
      delBtn!.disabled = true;
      try {
        await api.systemAgents.deleteFile(fromPath);
        await reload(section);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        alert('delete failed: ' + msg);
        delBtn!.disabled = false;
      }
    });
  }

  return card;
}

async function openFile(
  a: AgentRecord,
  fromPath: string,
  panel: HTMLElement,
  editBtn: HTMLButtonElement,
  editable: boolean,
  section: HTMLElement,
): Promise<void> {
  panel.classList.remove('hidden');
  editBtn.textContent = 'close';
  panel.replaceChildren();

  if (!fromPath) {
    const note = document.createElement('div');
    note.style.color = 'var(--muted)';
    note.style.fontSize = '12px';
    note.textContent = 'no file on disk; this subagent is built into grok.';
    panel.appendChild(note);
    return;
  }

  const loading = document.createElement('div');
  loading.style.color = 'var(--muted)';
  loading.style.fontSize = '12px';
  loading.textContent = 'loading...';
  panel.appendChild(loading);

  let content = '';
  try {
    const r = await api.systemAgents.read(fromPath) as { ok?: boolean; content?: string; error?: string };
    if (r && r.ok) content = r.content || '';
    else throw new Error((r && r.error) || 'read failed');
  } catch (err) {
    panel.replaceChildren();
    const e = document.createElement('div');
    e.style.color = 'var(--red, #f87171)';
    e.style.fontSize = '12px';
    e.textContent = 'read failed: ' + (err instanceof Error ? err.message : String(err));
    panel.appendChild(e);
    return;
  }

  panel.replaceChildren();
  if (!editable) {
    const pre = document.createElement('pre');
    pre.style.margin = '0';
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.background = 'var(--panel-2)';
    pre.style.border = '1px solid var(--border)';
    pre.style.borderRadius = '6px';
    pre.style.padding = '8px 10px';
    pre.style.fontFamily = 'var(--mono)';
    pre.style.fontSize = '12px';
    pre.style.color = 'var(--text)';
    pre.textContent = content;
    panel.appendChild(pre);
    return;
  }

  const ta = document.createElement('textarea');
  ta.value = content;
  ta.spellcheck = false;
  ta.rows = 22;
  ta.style.width = '100%';
  ta.style.fontFamily = 'var(--mono)';
  ta.style.fontSize = '12px';
  ta.style.background = 'var(--panel-2)';
  ta.style.color = 'var(--text)';
  ta.style.border = '1px solid var(--border)';
  ta.style.borderRadius = '6px';
  ta.style.padding = '8px 10px';
  ta.style.boxSizing = 'border-box';

  const bar = document.createElement('div');
  bar.style.display = 'flex';
  bar.style.gap = '8px';
  bar.style.alignItems = 'center';
  bar.style.marginTop = '6px';
  const status = document.createElement('span');
  status.style.color = 'var(--muted)';
  status.style.fontSize = '11px';
  const saveBtn = mkSecondaryButton('save', async () => {
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    status.textContent = 'saving...';
    try {
      await api.systemAgents.saveContent(fromPath, ta.value);
      status.textContent = 'saved.';
      await reload(section);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      status.textContent = 'save failed: ' + msg;
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  });
  const cancelBtn = mkSecondaryButton('cancel', () => {
    panel.classList.add('hidden');
    editBtn.textContent = 'edit';
  });
  bar.appendChild(saveBtn);
  bar.appendChild(cancelBtn);
  bar.appendChild(status);
  panel.appendChild(ta);
  panel.appendChild(bar);
}

async function createAgent(scope: string, section: HTMLElement): Promise<void> {
  const raw = window.prompt(`new ${scope} subagent name (letters/digits/dash/underscore):`, '');
  if (!raw) return;
  const cleaned = raw.trim().replace(/\s+/g, '-');
  if (!cleaned) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cleaned)) {
    alert('invalid name. Use letters, digits, dash, underscore, dot.');
    return;
  }
  try {
    const r = await api.systemAgents.createFile(scope, cleaned + '.md') as { ok?: boolean; error?: string };
    if (!r || !r.ok) throw new Error((r && r.error) || 'create failed');
    await reload(section);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    alert('create failed: ' + msg);
  }
}

function mkPrimaryButton(label: string, onClick: (ev: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'memory-scope-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function mkSecondaryButton(label: string, onClick: (ev: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'health-item-toggle';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// Touch cachedInspect to keep the linter from warning if strict noUnusedLocals
// is flipped on later.
void cachedInspect;
