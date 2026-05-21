// Agents sidebar: list + new + folders + star + archive flow.
// Owns the sidebar element only. The main pane is owned by chat.js / settings.js.
//
// Display order in active view:
//   1. starred + active (alphabetical, but starred sort first)
//   2. unstarred + active
// Folders appear above the un-foldered top-level rows. Archived items live
// under a separate "archived" toggle section.

import { api } from '../lib/api.js';
import { el } from '../lib/render.js';
import { fmtTokens } from '../lib/format.js';

const STATUS_LABEL = {
  idle:         'idle',
  running:      'running',
  errored:      'errored',
  killed:       'killed',
  starting:     'starting',
  disconnected: 'disconnected',
  exited:       'disconnected',
};

// Persisted sort + search + folder-collapse prefs (per browser).
const SORT_KEY   = 'grok-remote.sidebar.sort';
const SEARCH_KEY = 'grok-remote.sidebar.search';
const FOLDER_COLLAPSE_KEY = 'grok-remote.sidebar.folder-collapse';
const SORT_DEFAULT = 'created_desc';
const DRAG_HOLD_MS = 350;
const DRAG_HOLD_MOVE_TOLERANCE = 6;

const SORTS = {
  created_desc:    { label: 'newest first',     cmp: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') },
  created_asc:     { label: 'oldest first',     cmp: (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') },
  activity_desc:   { label: 'last active',      cmp: (a, b) => (b.lastSeen   || '').localeCompare(a.lastSeen   || '') },
  name_asc:        { label: 'name (a -> z)',    cmp: (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }) },
};

function loadSort()   { try { const v = localStorage.getItem(SORT_KEY); return SORTS[v] ? v : SORT_DEFAULT; } catch { return SORT_DEFAULT; } }
function saveSort(v)  { try { localStorage.setItem(SORT_KEY, v); } catch {} }
function loadSearch() { try { return localStorage.getItem(SEARCH_KEY) || ''; } catch { return ''; } }
function saveSearch(v){ try { localStorage.setItem(SEARCH_KEY, v); } catch {} }
function loadCollapsed() {
  try {
    const raw = localStorage.getItem(FOLDER_COLLAPSE_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch { return new Set(); }
}
function saveCollapsed(set) {
  try { localStorage.setItem(FOLDER_COLLAPSE_KEY, JSON.stringify([...set])); } catch {}
}

export class AgentsSidebar {
  constructor({ onSelect, onCreate, onDelete }) {
    this.onSelect = onSelect;
    this.onCreate = onCreate;
    this.onDelete = onDelete;
    this.agents = [];
    this.folders = [];
    this.selectedId = null;
    this.pollHandle = null;
    this.showArchived = false;
    this.sortKey = loadSort();
    this.search  = loadSearch();
    this.collapsedFolders = loadCollapsed();

    // Drag state. Set when a pointer-hold on an agent row crosses the
    // long-press threshold. Cleared on pointer-up or cancel.
    this._drag = null;

    this.activeList   = el('div', { class: 'agents-list' });
    this.archivedList = el('div', { class: 'agents-list agents-list--archived' });
    this.archivedList.hidden = true;

    this.empty = el('div', { class: 'agents-empty' }, 'no agents yet');
    this.noMatch = el('div', { class: 'agents-empty' }, 'no conversations match your search');
    this.error = el('div', { class: 'agents-empty agents-empty--err' });
    this.error.hidden = true;

    this.newBtn = el('button', {
      class: 'agents-new-btn',
      title: 'spawn a new agent (auto-named from the first message)',
      onclick: () => this.spawnNew(),
    }, '+ new');

    this.newFolderBtn = el('button', {
      class: 'agents-new-folder-btn',
      title: 'create a new folder',
      type: 'button',
      onclick: () => this.spawnFolder(),
    }, '+ folder');

    // Close-drawer button. Hidden on desktop via CSS, shown on mobile.
    this.closeDrawerBtn = el('button', {
      class: 'sidebar-close',
      type: 'button',
      title: 'close menu',
      'aria-label': 'close menu',
      onclick: () => document.dispatchEvent(new CustomEvent('grok-remote:close-drawer')),
    }, '×');

    this.archivedToggle = el('button', {
      class: 'agents-archived-toggle',
      type: 'button',
      onclick: () => this.toggleArchivedView(),
    }, 'archived (0)');

    this.searchInput = el('input', {
      class: 'sidebar-search-input',
      type: 'search',
      placeholder: 'search conversations',
      value: this.search,
      'aria-label': 'search conversations',
      oninput: (ev) => {
        this.search = (ev.target.value || '').trim();
        saveSearch(this.search);
        this.renderList();
      },
    });
    this.searchClearBtn = el('button', {
      class: 'sidebar-search-clear',
      type: 'button',
      title: 'clear search',
      'aria-label': 'clear search',
      onclick: () => {
        this.search = '';
        this.searchInput.value = '';
        saveSearch('');
        this.renderList();
        this.searchInput.focus();
      },
    }, '×');

    this.sortSelect = el('select', {
      class: 'sidebar-sort',
      'aria-label': 'sort conversations',
      onchange: (ev) => {
        this.sortKey = ev.target.value;
        saveSort(this.sortKey);
        this.renderList();
      },
    },
      ...Object.entries(SORTS).map(([k, s]) =>
        el('option', { value: k, ...(k === this.sortKey ? { selected: '' } : {}) }, s.label)
      )
    );

    this.root = el('aside', { class: 'sidebar' },
      el('div', { class: 'sidebar-head' },
        el('span', { class: 'sidebar-title' }, 'agents'),
        this.newBtn,
        this.newFolderBtn,
        this.closeDrawerBtn,
      ),
      el('div', { class: 'sidebar-tools' },
        el('div', { class: 'sidebar-search' },
          this.searchInput,
          this.searchClearBtn,
        ),
        this.sortSelect,
      ),
      this.error,
      el('div', { class: 'sidebar-body' },
        this.activeList,
        el('div', { class: 'agents-archived' },
          this.archivedToggle,
          this.archivedList,
        ),
      ),
    );
  }

  _sortAgents(list) {
    const sorter = SORTS[this.sortKey] || SORTS[SORT_DEFAULT];
    return list.slice().sort((a, b) => {
      const s = (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
      if (s) return s;
      return sorter.cmp(a, b);
    });
  }

  _matchesSearch(a) {
    if (!this.search) return true;
    const needle = this.search.toLowerCase();
    return (a.name || '').toLowerCase().includes(needle)
        || (a.id || '').toLowerCase().includes(needle);
  }

  toggleArchivedView() {
    this.showArchived = !this.showArchived;
    this.archivedList.hidden = !this.showArchived;
    this.renderArchivedToggle();
  }

  async spawnNew() {
    if (this._creating) return;
    this._creating = true;
    this.newBtn.disabled = true;
    this.error.hidden = true;
    const prevLabel = this.newBtn.textContent;
    this.newBtn.textContent = 'spawning...';
    try {
      const created = await api.createAgent({});
      if (typeof this.onCreate === 'function') this.onCreate(created);
      await this.refresh();
      if (created && created.id) this.select(created.id);
    } catch (e) {
      this.error.textContent = e.message || 'failed to spawn agent';
      this.error.hidden = false;
    } finally {
      this._creating = false;
      this.newBtn.disabled = false;
      this.newBtn.textContent = prevLabel;
    }
  }

  async spawnFolder() {
    const name = (prompt('Folder name?') || '').trim();
    if (!name) return;
    try {
      await api.folders.create(name);
      await this.refreshFolders();
      this.renderList();
    } catch (e) {
      alert(`create folder failed: ${e.message}`);
    }
  }

  mount(parent) {
    parent.appendChild(this.root);
    this.refresh();
    this.refreshFolders();
    this._startSseStream();
    this.startPolling();
    if (!this._spawnHandlerWired) {
      document.addEventListener('grok-remote:spawn-agent', () => this.spawnNew());
      this._spawnHandlerWired = true;
    }
  }

  _startSseStream() {
    if (this._agentsStream) return;
    try {
      const es = new EventSource(api.agentsStreamUrl());
      this._agentsStream = es;
      const apply = () => { /* delegate to refresh on any event */ };
      es.addEventListener('open', () => { this._sseAlive = true; });
      es.addEventListener('agents_snapshot', (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d && Array.isArray(d.agents)) {
            this.agents = d.agents;
            this.renderList();
            document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: d.agents }));
          }
        } catch { /* ignore parse errors */ }
      });
      const onMutation = () => { this.refresh(); };
      es.addEventListener('agent_added',   onMutation);
      es.addEventListener('agent_removed', onMutation);
      es.addEventListener('agent_updated', onMutation);
      es.addEventListener('agent_status',  onMutation);
      es.addEventListener('agent_tokens', (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (!d || !d.id || typeof d.totalTokens !== 'number') return;
          const idx = this.agents.findIndex(a => a && a.id === d.id);
          if (idx < 0) return;
          this.agents[idx] = { ...this.agents[idx], totalTokens: d.totalTokens };
          this.renderList();
          document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: this.agents }));
        } catch { /* ignore */ }
      });
      es.addEventListener('agent_inflight', (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (!d || !d.id || typeof d.inFlight !== 'number') return;
          const idx = this.agents.findIndex(a => a && a.id === d.id);
          if (idx < 0) return;
          this.agents[idx] = { ...this.agents[idx], inFlight: d.inFlight };
          this.renderList();
          document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: this.agents }));
        } catch { /* ignore */ }
      });
      es.addEventListener('error', () => { this._sseAlive = false; });
      apply();
    } catch {
      this._agentsStream = null;
    }
  }

  _stopSseStream() {
    if (this._agentsStream) {
      try { this._agentsStream.close(); } catch { /* ignore */ }
      this._agentsStream = null;
    }
  }

  startPolling() {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = setInterval(() => {
      if (document.hidden) return;
      if (this._sseAlive) return;
      this.refresh();
    }, 4000);
    if (!this._onVisibility) {
      this._onVisibility = () => {
        if (!document.hidden) this.refresh();
      };
      document.addEventListener('visibilitychange', this._onVisibility);
    }
  }

  stopPolling() {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    if (this._onVisibility) {
      document.removeEventListener('visibilitychange', this._onVisibility);
      this._onVisibility = null;
    }
    this._stopSseStream();
  }

  async refresh() {
    try {
      const data = await api.listAgents();
      const agents = Array.isArray(data) ? data : (data && Array.isArray(data.agents) ? data.agents : []);
      this.agents = agents;
      this.renderList();
      document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: agents }));
    } catch (e) {
      this.agents = [];
      this.renderList(e.message);
    }
  }

  async refreshFolders() {
    try {
      const data = await api.folders.list();
      this.folders = Array.isArray(data?.folders) ? data.folders : [];
      this.renderList();
    } catch {
      this.folders = [];
      this.renderList();
    }
  }

  renderArchivedToggle(count) {
    const n = (typeof count === 'number')
      ? count
      : this.agents.filter(a => a.archived).length;
    const label = n === 0 ? 'archived (0)' : `${this.showArchived ? '▼' : '▶'} archived (${n})`;
    this.archivedToggle.textContent = label;
    this.archivedToggle.disabled = n === 0;
  }

  // Returns a Map<agentId, folderId|null>. Agents with no folder map to null.
  _agentFolderMap() {
    const m = new Map();
    for (const f of this.folders) {
      for (const aid of f.agentIds) m.set(aid, f.id);
    }
    return m;
  }

  renderList(errorMessage) {
    this.activeList.replaceChildren();
    this.archivedList.replaceChildren();
    if (this.searchClearBtn) this.searchClearBtn.hidden = !this.search;

    if (errorMessage) {
      this.activeList.appendChild(el('div', { class: 'agents-empty agents-empty--err' },
        'backend unreachable'));
      this.renderArchivedToggle();
      return;
    }

    const allActive   = this.agents.filter(a => !a.archived);
    const allArchived = this.agents.filter(a =>  a.archived);

    // Bucket active agents by folder. Archived agents stay in their own
    // section regardless of folder membership.
    const folderMap = this._agentFolderMap();
    const byFolder = new Map();
    for (const f of this.folders) byFolder.set(f.id, []);
    const topLevel = [];
    for (const a of allActive) {
      const fid = folderMap.get(a.id);
      if (fid && byFolder.has(fid)) byFolder.get(fid).push(a);
      else topLevel.push(a);
    }

    // Folders first (sorted by name for stability).
    const sortedFolders = this.folders.slice().sort((x, y) =>
      (x.name || '').localeCompare(y.name || '', undefined, { sensitivity: 'base' })
    );
    for (const f of sortedFolders) {
      const members = byFolder.get(f.id) || [];
      const matching = this._sortAgents(members).filter(a => this._matchesSearch(a));
      const collapsed = this.collapsedFolders.has(f.id);
      this.activeList.appendChild(this._renderFolder(f, matching, collapsed, members.length));
    }

    // Top-level "no folder" rows.
    const topMatching = this._sortAgents(topLevel).filter(a => this._matchesSearch(a));
    const topDrop = el('div', { class: 'agents-top-drop', dataset: { dropTarget: 'top' } });
    topDrop.appendChild(el('div', { class: 'agents-top-drop-label' }, 'top level'));
    this.activeList.appendChild(topDrop);

    if (!allActive.length) {
      this.activeList.appendChild(this.empty);
    } else if (!topMatching.length && !sortedFolders.length) {
      this.activeList.appendChild(this.noMatch);
    } else {
      for (const a of topMatching) this.activeList.appendChild(this.renderItem(a, false));
    }
    const archived = this._sortAgents(allArchived).filter(a => this._matchesSearch(a));
    for (const a of archived) this.archivedList.appendChild(this.renderItem(a, true));

    this.renderArchivedToggle(allArchived.length);
  }

  _renderFolder(folder, members, collapsed, totalMembers) {
    const caret = el('span', { class: 'folder-caret' }, collapsed ? '▶' : '▼');
    const nameEl = el('span', { class: 'folder-name' }, folder.name);
    nameEl.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      this._beginFolderRename(folder, nameEl);
    });

    const count = el('span', { class: 'folder-count' }, `(${totalMembers})`);
    const deleteBtn = el('button', {
      class: 'folder-delete',
      type: 'button',
      title: 'delete folder (agents inside revert to top level)',
      onclick: async (ev) => {
        ev.stopPropagation();
        if (!confirm(`Delete folder "${folder.name}"?\nAgents inside revert to the top level. The conversations themselves are NOT deleted.`)) return;
        try {
          await api.folders.remove(folder.id);
          await this.refreshFolders();
        } catch (e) {
          alert(`delete folder failed: ${e.message}`);
        }
      },
    }, '×');

    const head = el('div', {
      class: `folder-head${collapsed ? ' folder-head--collapsed' : ''}`,
      dataset: { dropTarget: 'folder', folderId: folder.id },
      onclick: () => this._toggleFolderCollapse(folder.id),
    }, caret, nameEl, count, deleteBtn);

    const body = el('div', { class: 'folder-body', dataset: { dropTarget: 'folder', folderId: folder.id } });
    if (!collapsed) {
      if (!members.length) {
        body.appendChild(el('div', { class: 'folder-empty' }, 'drop conversations here'));
      } else {
        for (const a of members) body.appendChild(this.renderItem(a, false));
      }
    }

    return el('div', { class: 'folder', dataset: { folderId: folder.id } }, head, body);
  }

  _toggleFolderCollapse(folderId) {
    if (this.collapsedFolders.has(folderId)) this.collapsedFolders.delete(folderId);
    else this.collapsedFolders.add(folderId);
    saveCollapsed(this.collapsedFolders);
    this.renderList();
  }

  _beginFolderRename(folder, nameEl) {
    const input = el('input', {
      class: 'folder-name-input',
      type: 'text',
      value: folder.name,
    });
    const commit = async (save) => {
      input.removeEventListener('blur', onBlur);
      input.removeEventListener('keydown', onKey);
      const next = (input.value || '').trim();
      if (save && next && next !== folder.name) {
        try {
          await api.folders.update(folder.id, { name: next });
          await this.refreshFolders();
        } catch (e) {
          alert(`rename failed: ${e.message}`);
          this.renderList();
        }
      } else {
        this.renderList();
      }
    };
    const onBlur = () => commit(true);
    const onKey = (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
    };
    input.addEventListener('blur', onBlur);
    input.addEventListener('keydown', onKey);
    input.addEventListener('click', (ev) => ev.stopPropagation());
    nameEl.replaceWith(input);
    input.focus();
    input.select();
  }

  _beginAgentRename(agent, nameEl) {
    const input = el('input', {
      class: 'agent-name-input',
      type: 'text',
      value: agent.name || '',
    });
    const commit = async (save) => {
      input.removeEventListener('blur', onBlur);
      input.removeEventListener('keydown', onKey);
      const next = (input.value || '').trim();
      if (save && next && next !== agent.name) {
        try {
          await api.updateAgent(agent.id, { name: next });
          await this.refresh();
        } catch (e) {
          alert(`rename failed: ${e.message}`);
          this.renderList();
        }
      } else {
        this.renderList();
      }
    };
    const onBlur = () => commit(true);
    const onKey = (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
    };
    input.addEventListener('blur', onBlur);
    input.addEventListener('keydown', onKey);
    input.addEventListener('click', (ev) => ev.stopPropagation());
    nameEl.replaceWith(input);
    input.focus();
    input.select();
  }

  renderItem(a, isArchived) {
    const isSelected = a.id === this.selectedId;
    const status = a.status || 'idle';
    const isDisconnected = status === 'disconnected' || status === 'exited';
    const dot = el('span', { class: `agent-dot agent-dot--${status}` });

    const starBtn = el('button', {
      class: `agent-star${a.starred ? ' is-on' : ''}`,
      title: a.starred ? 'unstar' : 'star',
      type: 'button',
      onclick: async (ev) => {
        ev.stopPropagation();
        starBtn.disabled = true;
        try {
          await api.updateAgent(a.id, { starred: !a.starred });
          await this.refresh();
        } catch (e) {
          alert(`star failed: ${e.message}`);
        } finally {
          starBtn.disabled = false;
        }
      },
    }, a.starred ? '★' : '☆');

    let closeArea;
    if (!isArchived) {
      const archiveBtn = el('button', {
        class: 'agent-archive',
        type: 'button',
        title: 'archive (move to archived; you can restore or delete later)',
        onclick: async (ev) => {
          ev.stopPropagation();
          archiveBtn.disabled = true;
          try {
            await api.updateAgent(a.id, { archived: true });
            if (this.selectedId === a.id) this.selectedId = null;
            await this.refresh();
          } catch (e) {
            alert(`archive failed: ${e.message}`);
          } finally {
            archiveBtn.disabled = false;
          }
        },
      }, '×');
      closeArea = archiveBtn;
    } else {
      const restoreBtn = el('button', {
        class: 'agent-restore',
        type: 'button',
        title: 'restore from archive',
        onclick: async (ev) => {
          ev.stopPropagation();
          restoreBtn.disabled = true;
          try {
            await api.updateAgent(a.id, { archived: false });
            await this.refresh();
          } catch (e) {
            alert(`restore failed: ${e.message}`);
          } finally {
            restoreBtn.disabled = false;
          }
        },
      }, 'restore');
      const deleteBtn = el('button', {
        class: 'agent-delete-forever',
        type: 'button',
        title: 'delete forever (removes history + uploads)',
        onclick: async (ev) => {
          ev.stopPropagation();
          if (!confirm(`Delete "${a.name || a.id}" forever?\nThis removes its history and uploaded files. Cannot be undone.`)) return;
          try {
            await api.deleteAgent(a.id);
            if (typeof this.onDelete === 'function') this.onDelete(a.id);
            if (this.selectedId === a.id) this.selectedId = null;
            await this.refresh();
          } catch (e) {
            alert(`delete failed: ${e.message}`);
          }
        },
      }, 'delete');
      closeArea = el('div', { class: 'agent-archived-actions' }, restoreBtn, deleteBtn);
    }

    const nameEl = el('span', { class: 'agent-name' }, a.name || a.id.slice(0, 8));
    nameEl.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      this._beginAgentRename(a, nameEl);
    });

    const item = el('div', {
      class: [
        'agent-item',
        isSelected     ? 'agent-item--selected' : '',
        isDisconnected ? 'agent-item--off' : '',
        isArchived     ? 'agent-item--archived' : '',
        a.starred      ? 'agent-item--starred' : '',
      ].filter(Boolean).join(' '),
      dataset: { agentId: a.id, draggable: isArchived ? '0' : '1' },
      onclick: () => this.select(a.id),
    },
      el('div', { class: 'agent-item-top' },
        dot,
        starBtn,
        nameEl,
        closeArea,
      ),
      el('div', { class: 'agent-item-meta' },
        el('span', { class: `agent-status agent-status--${status}` }, STATUS_LABEL[status] || status),
        (typeof a.inFlight === 'number' && a.inFlight > 0) ? el('span', { class: 'agent-sep' }, '·') : null,
        (typeof a.inFlight === 'number' && a.inFlight > 0)
          ? el('span', { class: 'agent-inflight', title: `${a.inFlight} tool call${a.inFlight === 1 ? '' : 's'} in flight` },
              el('span', { class: 'agent-inflight-dot' }),
              `${a.inFlight} tool${a.inFlight === 1 ? '' : 's'}`)
          : null,
        (typeof a.totalTokens === 'number' && a.totalTokens > 0) ? el('span', { class: 'agent-sep' }, '·') : null,
        (typeof a.totalTokens === 'number' && a.totalTokens > 0)
          ? el('span', { class: 'agent-tokens', title: `${a.totalTokens.toLocaleString()} tokens in context` }, fmtTokens(a.totalTokens))
          : null,
      ),
    );

    if (!isArchived) this._wireDragHandlers(item, a.id);
    return item;
  }

  // Pointer-Events drag-and-drop. Works on desktop AND mobile from a single
  // path. A pointerdown that holds ~DRAG_HOLD_MS without moving too far
  // promotes itself into a drag; any earlier movement cancels and lets the
  // normal click/scroll happen.
  _wireDragHandlers(item, agentId) {
    let pressTimer = null;
    let startX = 0, startY = 0;
    let pointerId = null;
    let elevated = false;

    const clear = () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (pointerId != null) {
        try { item.releasePointerCapture(pointerId); } catch { /* ignore */ }
      }
      pointerId = null;
      elevated = false;
      item.classList.remove('agent-item--dragging');
      this._clearDropHover();
      this._drag = null;
    };

    const onPointerDown = (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      // Ignore presses on interactive children (buttons, inputs).
      if (ev.target.closest('button, input, select, textarea, a')) return;
      startX = ev.clientX;
      startY = ev.clientY;
      pointerId = ev.pointerId;
      try { item.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
      pressTimer = setTimeout(() => {
        elevated = true;
        item.classList.add('agent-item--dragging');
        this._drag = { agentId, x: startX, y: startY };
      }, DRAG_HOLD_MS);
    };

    const onPointerMove = (ev) => {
      const dx = Math.abs(ev.clientX - startX);
      const dy = Math.abs(ev.clientY - startY);
      if (!elevated) {
        if (dx > DRAG_HOLD_MOVE_TOLERANCE || dy > DRAG_HOLD_MOVE_TOLERANCE) {
          if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        }
        return;
      }
      this._drag = { agentId, x: ev.clientX, y: ev.clientY };
      const target = this._dropTargetAt(ev.clientX, ev.clientY);
      this._setDropHover(target);
    };

    const onPointerUp = (ev) => {
      if (!elevated) { clear(); return; }
      const target = this._dropTargetAt(ev.clientX, ev.clientY);
      clear();
      if (target) this._performDrop(agentId, target);
    };

    const onPointerCancel = () => clear();

    item.addEventListener('pointerdown',   onPointerDown);
    item.addEventListener('pointermove',   onPointerMove);
    item.addEventListener('pointerup',     onPointerUp);
    item.addEventListener('pointercancel', onPointerCancel);
    item.addEventListener('contextmenu',   (ev) => { if (elevated) ev.preventDefault(); });
  }

  _dropTargetAt(x, y) {
    const els = document.elementsFromPoint(x, y);
    for (const node of els) {
      const t = node.closest('[data-drop-target]');
      if (!t) continue;
      const kind = t.dataset.dropTarget;
      if (kind === 'top') return { kind: 'top', el: t };
      if (kind === 'folder') return { kind: 'folder', folderId: t.dataset.folderId, el: t };
    }
    return null;
  }

  _setDropHover(target) {
    if (this._lastHover && this._lastHover !== target?.el) {
      this._lastHover.classList.remove('drop-hover');
      this._lastHover = null;
    }
    if (target?.el) {
      target.el.classList.add('drop-hover');
      this._lastHover = target.el;
    }
  }

  _clearDropHover() {
    if (this._lastHover) {
      this._lastHover.classList.remove('drop-hover');
      this._lastHover = null;
    }
  }

  async _performDrop(agentId, target) {
    try {
      const folderId = target.kind === 'folder' ? target.folderId : null;
      await api.folders.assignAgent(agentId, folderId);
      await this.refreshFolders();
    } catch (e) {
      alert(`move failed: ${e.message}`);
    }
  }

  select(id) {
    this.selectedId = id;
    this.renderList();
    if (typeof this.onSelect === 'function') this.onSelect(id);
  }
}
