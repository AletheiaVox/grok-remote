// Skills management page.

import { api } from '../../lib/api.js';

interface SkillRecord {
  scope: string;
  name: string;
  mdPath: string;
  dir: string;
  shortDescription?: string;
  description?: string;
  archived?: boolean;
  usageCount?: number;
  lastUsedAt?: string;
}

interface SkillsResponse {
  ok?: boolean;
  error?: string;
  skills?: SkillRecord[];
  sources?: { scope: string; dir: string }[];
}

interface SkillReadResponse { ok?: boolean; content?: string; error?: string }
interface SkillHistoryItem { ts: string; size?: number }
interface SkillHistoryResponse { ok?: boolean; history?: SkillHistoryItem[]; error?: string }

let activeContainer: HTMLElement | null = null;
let aborted = false;
let cachedData: SkillsResponse | null = null;

const SCOPE_LABEL: Record<string, string> = {
  'cwd':          'cwd',
  'repo':         'repo',
  'user-grok':    '~/.grok',
  'user-claude':  '~/.claude',
};
const SCOPE_ORDER = ['cwd', 'repo', 'user-grok', 'user-claude'];

export async function mount(container: HTMLElement): Promise<void> {
  activeContainer = container;
  aborted = false;
  container.replaceChildren();
  container.innerHTML = `
    <section class="system-page skills-page">
      <header class="system-page-header">
        <h2 class="system-page-title">Skills</h2>
        <p class="system-page-sub">
          Reusable prompt packages grok discovers under <code>.grok/skills/</code>.
          Invoked by the agent via <code>/&lt;name&gt;</code> when relevant.
          Scope priority (high to low): cwd, repo, ~/.grok, ~/.claude.
        </p>
      </header>
      <div class="skills-loading">loading skills...</div>
    </section>
  `;
  await reload(container);
}

export function unmount(): void {
  aborted = true;
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
  cachedData = null;
}

async function reload(container: HTMLElement): Promise<void> {
  const sectionEl = container.querySelector('.skills-page') as HTMLElement | null;
  if (!sectionEl) return;
  try {
    const data = await api.skills.list({ includeArchived: true }) as SkillsResponse;
    if (aborted || activeContainer !== container) return;
    if (!data || !data.ok) {
      sectionEl.innerHTML = sectionEl.innerHTML.replace(/<div class="skills-loading">[^<]*<\/div>/, '');
      const empty = document.createElement('div');
      empty.className = 'system-page-empty';
      empty.textContent = 'failed to load: ' + ((data && data.error) || 'unknown');
      sectionEl.appendChild(empty);
      return;
    }
    cachedData = data;
    render(sectionEl, data);
  } catch (err) {
    if (aborted || activeContainer !== container) return;
    sectionEl.querySelector('.skills-loading')?.remove();
    const empty = document.createElement('div');
    empty.className = 'system-page-empty';
    empty.textContent = 'failed to load: ' + (err instanceof Error ? err.message : String(err));
    sectionEl.appendChild(empty);
  }
}

function render(sectionEl: HTMLElement, data: SkillsResponse): void {
  const header = sectionEl.querySelector('.system-page-header');
  sectionEl.replaceChildren();
  if (header) sectionEl.appendChild(header);

  const skills = Array.isArray(data.skills) ? data.skills : [];
  const sources = Array.isArray(data.sources) ? data.sources : [];

  const sourcesEl = document.createElement('div');
  sourcesEl.className = 'skills-sources';
  for (const s of sources) {
    const chip = document.createElement('span');
    chip.className = `skills-source-chip skills-scope--${s.scope}`;
    chip.textContent = `${SCOPE_LABEL[s.scope] || s.scope}: ${shortenPath(s.dir)}`;
    sourcesEl.appendChild(chip);
  }
  sectionEl.appendChild(sourcesEl);

  const active = skills.filter((s) => !s.archived);
  const archived = skills.filter((s) => s.archived);

  if (!active.length && !archived.length) {
    const empty = document.createElement('div');
    empty.className = 'system-page-empty';
    empty.textContent = 'no skills found in any of the scopes above.';
    sectionEl.appendChild(empty);
    return;
  }

  const grouped = new Map<string, SkillRecord[]>();
  for (const s of active) {
    if (!grouped.has(s.scope)) grouped.set(s.scope, []);
    grouped.get(s.scope)!.push(s);
  }
  for (const scope of SCOPE_ORDER) {
    const items = grouped.get(scope);
    if (!items || !items.length) continue;
    const group = document.createElement('section');
    group.className = 'skills-group';
    group.innerHTML = `<h3 class="skills-group-title">${escapeHtml(SCOPE_LABEL[scope] || scope)}</h3>`;
    const grid = document.createElement('div');
    grid.className = 'skills-grid';
    for (const sk of items.sort((a, b) => a.name.localeCompare(b.name))) {
      grid.appendChild(makeCard(sk, sectionEl));
    }
    group.appendChild(grid);
    sectionEl.appendChild(group);
  }

  if (archived.length) {
    const archGroup = document.createElement('section');
    archGroup.className = 'skills-group skills-archived';
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'skills-archived-toggle';
    title.textContent = `archived (${archived.length})`;
    const grid = document.createElement('div');
    grid.className = 'skills-grid skills-archived-grid hidden';
    title.addEventListener('click', () => {
      grid.classList.toggle('hidden');
      title.classList.toggle('skills-archived-toggle--open');
    });
    for (const sk of archived.sort((a, b) => a.name.localeCompare(b.name))) {
      grid.appendChild(makeCard(sk, sectionEl));
    }
    archGroup.appendChild(title);
    archGroup.appendChild(grid);
    sectionEl.appendChild(archGroup);
  }
}

function makeCard(sk: SkillRecord, sectionEl: HTMLElement): HTMLElement {
  const card = document.createElement('article');
  card.className = `skills-card skills-scope--${sk.scope}${sk.archived ? ' skills-card--archived' : ''}`;
  const desc = sk.shortDescription || sk.description || '(no description)';
  const usage = (typeof sk.usageCount === 'number' && sk.usageCount > 0)
    ? `<span class="skills-card-usage" title="${escapeHtml(`last used: ${sk.lastUsedAt || ''}`)}">used ${sk.usageCount}×</span>`
    : '';
  card.innerHTML = `
    <header class="skills-card-head">
      <span class="skills-card-name">/${escapeHtml(sk.name)}</span>
      <span class="skills-card-scope">${escapeHtml(SCOPE_LABEL[sk.scope] || sk.scope)}${sk.archived ? ' (archived)' : ''}</span>
    </header>
    <p class="skills-card-desc">${escapeHtml(desc)}</p>
    <footer class="skills-card-foot">
      <span class="skills-card-path" title="${escapeHtml(sk.mdPath)}">${escapeHtml(shortenPath(sk.dir))}</span>
      ${usage}
    </footer>
    <div class="skills-card-actions"></div>
    <pre class="skills-card-body hidden"></pre>
    <div class="skills-card-edit hidden"></div>
    <div class="skills-card-history hidden"></div>
  `;
  const actions = card.querySelector('.skills-card-actions') as HTMLElement;
  const body    = card.querySelector('.skills-card-body') as HTMLElement;
  const editEl  = card.querySelector('.skills-card-edit') as HTMLElement;
  const histEl  = card.querySelector('.skills-card-history') as HTMLElement;

  const mkBtn = (label: string, cls: string, onclick: () => void | Promise<void>): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `skills-card-btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', () => void onclick());
    return b;
  };

  if (sk.archived) {
    actions.appendChild(mkBtn('restore', 'skills-card-btn--good', async () => {
      try { await api.skills.restore(sk.scope, sk.name); if (activeContainer) await reload(activeContainer); }
      catch (err) { const msg = err instanceof Error ? err.message : String(err); alert('restore failed: ' + msg); }
    }));
    actions.appendChild(mkBtn('view SKILL.md', '', () => toggleView(sk, body, actions)));
    return card;
  }

  actions.appendChild(mkBtn('view', '', () => toggleView(sk, body, actions)));
  actions.appendChild(mkBtn('edit', '', () => toggleEdit(sk, editEl, actions, sectionEl)));
  actions.appendChild(mkBtn('history', '', () => toggleHistory(sk, histEl, actions, sectionEl)));

  const moveSel = document.createElement('select');
  moveSel.className = 'skills-card-move';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'move to...';
  moveSel.appendChild(defaultOpt);
  for (const s of SCOPE_ORDER) {
    if (s === sk.scope) continue;
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = SCOPE_LABEL[s] || s;
    moveSel.appendChild(opt);
  }
  moveSel.addEventListener('change', async () => {
    const to = moveSel.value;
    if (!to) return;
    moveSel.disabled = true;
    try {
      await api.skills.move(sk.scope, sk.name, to);
      if (activeContainer) await reload(activeContainer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert('move failed: ' + msg);
      moveSel.value = '';
      moveSel.disabled = false;
    }
  });
  actions.appendChild(moveSel);

  actions.appendChild(mkBtn('archive', 'skills-card-btn--warn', async () => {
    if (!confirm(`archive /${sk.name}? It moves into the scope's .archive folder.`)) return;
    try { await api.skills.archive(sk.scope, sk.name); if (activeContainer) await reload(activeContainer); }
    catch (err) { const msg = err instanceof Error ? err.message : String(err); alert('archive failed: ' + msg); }
  }));

  return card;
}

function hideAllPanels(card: Element | null): void {
  if (!card) return;
  card.querySelector('.skills-card-body')?.classList.add('hidden');
  card.querySelector('.skills-card-edit')?.classList.add('hidden');
  card.querySelector('.skills-card-history')?.classList.add('hidden');
}

async function toggleView(sk: SkillRecord, body: HTMLElement, actions: HTMLElement): Promise<void> {
  const card = actions.closest('.skills-card');
  if (!body.classList.contains('hidden')) {
    body.classList.add('hidden');
    return;
  }
  hideAllPanels(card);
  body.textContent = 'loading...';
  body.classList.remove('hidden');
  try {
    const r = await api.skills.read(sk.mdPath) as SkillReadResponse;
    if (r && r.ok) body.textContent = r.content || '';
    else body.textContent = 'error: ' + ((r && r.error) || 'unknown');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    body.textContent = 'error: ' + msg;
  }
}

async function toggleEdit(sk: SkillRecord, editEl: HTMLElement, actions: HTMLElement, _sectionEl: HTMLElement): Promise<void> {
  const card = actions.closest('.skills-card');
  if (!editEl.classList.contains('hidden')) {
    editEl.classList.add('hidden');
    return;
  }
  hideAllPanels(card);
  editEl.classList.remove('hidden');
  editEl.innerHTML = `<div class="skills-card-edit-loading">loading...</div>`;
  let original = '';
  try {
    const r = await api.skills.read(sk.mdPath) as SkillReadResponse;
    if (r && r.ok) original = r.content || '';
    else throw new Error((r && r.error) || 'read failed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    editEl.innerHTML = `<div class="skills-card-edit-err">load failed: ${escapeHtml(msg)}</div>`;
    return;
  }
  editEl.replaceChildren();
  const ta = document.createElement('textarea');
  ta.className = 'skills-card-edit-ta';
  ta.value = original;
  ta.spellcheck = false;
  ta.rows = 20;
  const bar = document.createElement('div');
  bar.className = 'skills-card-edit-bar';
  const status = document.createElement('span');
  status.className = 'skills-card-edit-status';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'skills-card-btn skills-card-btn--good';
  saveBtn.textContent = 'save';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'skills-card-btn';
  cancelBtn.textContent = 'cancel';
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    status.textContent = 'saving...';
    try {
      await api.skills.saveContent(sk.scope, sk.name, ta.value);
      status.textContent = 'saved.';
      if (activeContainer) await reload(activeContainer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      status.textContent = 'save failed: ' + msg;
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  });
  cancelBtn.addEventListener('click', () => { editEl.classList.add('hidden'); });
  bar.appendChild(saveBtn);
  bar.appendChild(cancelBtn);
  bar.appendChild(status);
  editEl.appendChild(ta);
  editEl.appendChild(bar);
}

async function toggleHistory(sk: SkillRecord, histEl: HTMLElement, actions: HTMLElement, _sectionEl: HTMLElement): Promise<void> {
  const card = actions.closest('.skills-card');
  if (!histEl.classList.contains('hidden')) {
    histEl.classList.add('hidden');
    return;
  }
  hideAllPanels(card);
  histEl.classList.remove('hidden');
  histEl.innerHTML = `<div class="skills-card-edit-loading">loading...</div>`;
  let list: SkillHistoryItem[] = [];
  try {
    const r = await api.skills.history(sk.scope, sk.name) as SkillHistoryResponse;
    if (r && r.ok) list = r.history || [];
    else throw new Error((r && r.error) || 'history failed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    histEl.innerHTML = `<div class="skills-card-edit-err">history failed: ${escapeHtml(msg)}</div>`;
    return;
  }
  histEl.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'skills-card-history-empty';
    empty.textContent = 'no revision history yet. Edit + save to create snapshots.';
    histEl.appendChild(empty);
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'skills-card-history-list';
  const viewer = document.createElement('pre');
  viewer.className = 'skills-card-history-view hidden';
  for (const item of list) {
    const li = document.createElement('li');
    li.className = 'skills-card-history-item';
    const tsBtn = document.createElement('button');
    tsBtn.type = 'button';
    tsBtn.className = 'skills-card-history-ts';
    tsBtn.textContent = item.ts;
    tsBtn.addEventListener('click', async () => {
      viewer.classList.remove('hidden');
      viewer.textContent = 'loading...';
      try {
        const r = await api.skills.historySnapshot(sk.scope, sk.name, item.ts) as SkillReadResponse;
        viewer.textContent = (r && r.ok) ? (r.content || '') : ('error: ' + ((r && r.error) || 'unknown'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        viewer.textContent = 'error: ' + msg;
      }
    });
    const sizeEl = document.createElement('span');
    sizeEl.className = 'skills-card-history-size';
    sizeEl.textContent = item.size ? `${item.size}B` : '';
    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'skills-card-btn skills-card-btn--good';
    restoreBtn.textContent = 'restore';
    restoreBtn.title = 'overwrite current SKILL.md with this revision (current is snapshotted first)';
    restoreBtn.addEventListener('click', async () => {
      if (!confirm(`restore /${sk.name} to revision ${item.ts}?`)) return;
      restoreBtn.disabled = true;
      try {
        await api.skills.historyRestore(sk.scope, sk.name, item.ts);
        if (activeContainer) await reload(activeContainer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        alert('restore failed: ' + msg);
        restoreBtn.disabled = false;
      }
    });
    li.appendChild(tsBtn);
    li.appendChild(sizeEl);
    li.appendChild(restoreBtn);
    ul.appendChild(li);
  }
  histEl.appendChild(ul);
  histEl.appendChild(viewer);
}

function shortenPath(p: string | null | undefined): string {
  if (!p) return '';
  const home = '/Users/dan';
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

function escapeHtml(s: unknown): string {
  return String(s || '').replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
}

void cachedData;
