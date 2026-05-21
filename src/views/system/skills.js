// Skills management page.
//
// Lists every skill grok discovers on this machine: per-cwd (.grok/skills/),
// repo-shared (<repo-root>/.grok/skills/), user-wide (~/.grok/skills/), and
// Claude-Code compatibility (~/.claude/skills/).
//
// Each skill is rendered as a card with its name, short description, scope
// badge, usage pill, and action buttons:
//   view   open SKILL.md inline (read-only)
//   edit   inline editor (textarea) with save / cancel
//   hist   revision history list (view + restore)
//   move   dropdown to relocate the skill into another scope
//   arch   archive the skill (moves to sibling .archive dir)
//
// Archived skills appear in a collapsible section at the bottom with a
// "restore" button per card.

import { api } from '../../lib/api';

let activeContainer = null;
let aborted = false;
let cachedData = null;

const SCOPE_LABEL = {
  'cwd':          'cwd',
  'repo':         'repo',
  'user-grok':    '~/.grok',
  'user-claude':  '~/.claude',
};
const SCOPE_ORDER = ['cwd', 'repo', 'user-grok', 'user-claude'];

export async function mount(container) {
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

export function unmount() {
  aborted = true;
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
  cachedData = null;
}

async function reload(container) {
  const sectionEl = container.querySelector('.skills-page');
  if (!sectionEl) return;
  try {
    const data = await api.skills.list({ includeArchived: true });
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
    empty.textContent = 'failed to load: ' + err.message;
    sectionEl.appendChild(empty);
  }
}

function render(sectionEl, data) {
  // Wipe everything except the header.
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

  const active = skills.filter(s => !s.archived);
  const archived = skills.filter(s => s.archived);

  if (!active.length && !archived.length) {
    const empty = document.createElement('div');
    empty.className = 'system-page-empty';
    empty.textContent = 'no skills found in any of the scopes above.';
    sectionEl.appendChild(empty);
    return;
  }

  // Active skills, grouped by scope.
  const grouped = new Map();
  for (const s of active) {
    if (!grouped.has(s.scope)) grouped.set(s.scope, []);
    grouped.get(s.scope).push(s);
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

function makeCard(sk, sectionEl) {
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
  const actions = card.querySelector('.skills-card-actions');
  const body    = card.querySelector('.skills-card-body');
  const editEl  = card.querySelector('.skills-card-edit');
  const histEl  = card.querySelector('.skills-card-history');

  const mkBtn = (label, cls, onclick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `skills-card-btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', onclick);
    return b;
  };

  if (sk.archived) {
    actions.appendChild(mkBtn('restore', 'skills-card-btn--good', async () => {
      try { await api.skills.restore(sk.scope, sk.name); await reload(activeContainer); }
      catch (err) { alert('restore failed: ' + err.message); }
    }));
    actions.appendChild(mkBtn('view SKILL.md', '', () => toggleView(sk, body, actions)));
    return card;
  }

  // Active card actions.
  actions.appendChild(mkBtn('view', '', () => toggleView(sk, body, actions)));
  actions.appendChild(mkBtn('edit', '', () => toggleEdit(sk, editEl, actions, sectionEl)));
  actions.appendChild(mkBtn('history', '', () => toggleHistory(sk, histEl, actions, sectionEl)));

  // Move-to dropdown.
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
      await reload(activeContainer);
    } catch (err) {
      alert('move failed: ' + err.message);
      moveSel.value = '';
      moveSel.disabled = false;
    }
  });
  actions.appendChild(moveSel);

  actions.appendChild(mkBtn('archive', 'skills-card-btn--warn', async () => {
    if (!confirm(`archive /${sk.name}? It moves into the scope's .archive folder.`)) return;
    try { await api.skills.archive(sk.scope, sk.name); await reload(activeContainer); }
    catch (err) { alert('archive failed: ' + err.message); }
  }));

  return card;
}

// Track open panel state so we can close siblings on toggle.
function hideAllPanels(card) {
  card.querySelector('.skills-card-body')?.classList.add('hidden');
  card.querySelector('.skills-card-edit')?.classList.add('hidden');
  card.querySelector('.skills-card-history')?.classList.add('hidden');
}

async function toggleView(sk, body, actions) {
  const card = actions.closest('.skills-card');
  if (!body.classList.contains('hidden')) {
    body.classList.add('hidden');
    return;
  }
  hideAllPanels(card);
  body.textContent = 'loading...';
  body.classList.remove('hidden');
  try {
    const r = await api.skills.read(sk.mdPath);
    if (r && r.ok) body.textContent = r.content;
    else body.textContent = 'error: ' + ((r && r.error) || 'unknown');
  } catch (err) {
    body.textContent = 'error: ' + err.message;
  }
}

async function toggleEdit(sk, editEl, actions, sectionEl) {
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
    const r = await api.skills.read(sk.mdPath);
    if (r && r.ok) original = r.content;
    else throw new Error((r && r.error) || 'read failed');
  } catch (err) {
    editEl.innerHTML = `<div class="skills-card-edit-err">load failed: ${escapeHtml(err.message)}</div>`;
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
      await reload(activeContainer);
    } catch (err) {
      status.textContent = 'save failed: ' + err.message;
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

async function toggleHistory(sk, histEl, actions, sectionEl) {
  const card = actions.closest('.skills-card');
  if (!histEl.classList.contains('hidden')) {
    histEl.classList.add('hidden');
    return;
  }
  hideAllPanels(card);
  histEl.classList.remove('hidden');
  histEl.innerHTML = `<div class="skills-card-edit-loading">loading...</div>`;
  let list = [];
  try {
    const r = await api.skills.history(sk.scope, sk.name);
    if (r && r.ok) list = r.history || [];
    else throw new Error((r && r.error) || 'history failed');
  } catch (err) {
    histEl.innerHTML = `<div class="skills-card-edit-err">history failed: ${escapeHtml(err.message)}</div>`;
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
        const r = await api.skills.historySnapshot(sk.scope, sk.name, item.ts);
        viewer.textContent = (r && r.ok) ? r.content : ('error: ' + ((r && r.error) || 'unknown'));
      } catch (err) { viewer.textContent = 'error: ' + err.message; }
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
        await reload(activeContainer);
      } catch (err) {
        alert('restore failed: ' + err.message);
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

function shortenPath(p) {
  if (!p) return '';
  const home = '/Users/dan';
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
