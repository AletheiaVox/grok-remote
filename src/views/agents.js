// Agents sidebar: list + new + star + archive flow.
// Owns the sidebar element only. The main pane is owned by chat.js / settings.js.
//
// Display order in active view:
//   1. starred + active (alphabetical, but starred sort first)
//   2. unstarred + active
// Archived items live under a separate "archived" toggle section.

import { api } from '../lib/api.js';
import { el } from '../lib/render.js';
import { fmtTokens } from '../lib/format';

const STATUS_LABEL = {
  idle:         'idle',
  running:      'running',
  errored:      'errored',
  killed:       'killed',
  starting:     'starting',
  disconnected: 'disconnected',
  exited:       'disconnected',
};

// Persisted sort + search prefs (per browser).
const SORT_KEY   = 'grok-remote.sidebar.sort';
const SEARCH_KEY = 'grok-remote.sidebar.search';
const SORT_DEFAULT = 'created_desc';

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

export class AgentsSidebar {
  constructor({ onSelect, onCreate, onDelete }) {
    this.onSelect = onSelect;
    this.onCreate = onCreate;
    this.onDelete = onDelete;
    this.agents = [];
    this.selectedId = null;
    this.pollHandle = null;
    this.showArchived = false;
    this.sortKey = loadSort();
    this.search  = loadSearch();

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

    // Close-drawer button. Hidden on desktop via CSS, shown on mobile.
    // Dispatches the same event main.js listens to, so behavior matches
    // backdrop-tap and Escape.
    this.closeDrawerBtn = el('button', {
      class: 'sidebar-close',
      type: 'button',
      title: 'close menu',
      'aria-label': 'close menu',
      onclick: () => document.dispatchEvent(new CustomEvent('grok-remote:close-drawer')),
    }, '×');

    // (The collapse-sidebar button now lives in the topbar so it stays
    // reachable when the sidebar itself is hidden. See main.js.)

    this.archivedToggle = el('button', {
      class: 'agents-archived-toggle',
      type: 'button',
      onclick: () => this.toggleArchivedView(),
    }, 'archived (0)');

    // Search input + clear button.
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

    // Sort dropdown.
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
      // sidebar-body is the single scrollable region so the active list
      // AND the expanded archived section share one scrollbar. Without
      // this wrapper, the archived disclosure would push past the
      // viewport with nowhere to overflow.
      el('div', { class: 'sidebar-body' },
        this.activeList,
        el('div', { class: 'agents-archived' },
          this.archivedToggle,
          this.archivedList,
        ),
      ),
    );
  }

  // Returns the comparator for the current sort. Starred items always
  // float to the top within each sort.
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
        || (a.id || '').toLowerCase().includes(needle)
        || (a.model || '').toLowerCase().includes(needle);
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

  mount(parent) {
    parent.appendChild(this.root);
    this.refresh();
    // Prefer SSE push from /api/agents/stream; if it never opens (older server
    // or transient failure), fall back to the 4s poll. The poll also serves as
    // the recovery path in case the EventSource closes for too long.
    this._startSseStream();
    this.startPolling();
    // Remote spawn trigger: the chat empty-state "New conversation" button
    // dispatches this event so it can reuse the same createAgent + select
    // flow without duplicating it.
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
      // Token deltas are high-frequency during streaming; patch in-place
      // and re-render the affected row instead of round-tripping a refresh.
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
      // inFlight tool-call count: same in-place patch pattern.
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
    // Skip polling when the tab is hidden OR when the SSE stream is healthy.
    // If SSE flakes, this is the recovery path.
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

  renderArchivedToggle(count) {
    const n = (typeof count === 'number')
      ? count
      : this.agents.filter(a => a.archived).length;
    const label = n === 0 ? 'archived (0)' : `${this.showArchived ? '▼' : '▶'} archived (${n})`;
    this.archivedToggle.textContent = label;
    this.archivedToggle.disabled = n === 0;
  }

  renderList(errorMessage) {
    this.activeList.replaceChildren();
    this.archivedList.replaceChildren();
    // Reflect search state on the clear button.
    if (this.searchClearBtn) this.searchClearBtn.hidden = !this.search;

    if (errorMessage) {
      this.activeList.appendChild(el('div', { class: 'agents-empty agents-empty--err' },
        'backend unreachable'));
      this.renderArchivedToggle();
      return;
    }

    const allActive   = this.agents.filter(a => !a.archived);
    const allArchived = this.agents.filter(a =>  a.archived);
    const active   = this._sortAgents(allActive).filter(a => this._matchesSearch(a));
    const archived = this._sortAgents(allArchived).filter(a => this._matchesSearch(a));

    if (!allActive.length) {
      this.activeList.appendChild(this.empty);
    } else if (!active.length) {
      this.activeList.appendChild(this.noMatch);
    } else {
      for (const a of active) this.activeList.appendChild(this.renderItem(a, false));
    }
    for (const a of archived) this.archivedList.appendChild(this.renderItem(a, true));

    this.renderArchivedToggle(allArchived.length);
  }

  renderItem(a, isArchived) {
    const isSelected = a.id === this.selectedId;
    const status = a.status || 'idle';
    const isDisconnected = status === 'disconnected' || status === 'exited';
    const dot = el('span', { class: `agent-dot agent-dot--${status}` });

    // Star toggle (always available).
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

    // Connect / disconnect (live agents only).
    const toggleBtn = !isArchived ? el('button', {
      class: `agent-link${isDisconnected ? ' agent-link--off' : ''}`,
      title: isDisconnected ? 'connect (resume conversation)' : 'disconnect (stop process, keep history)',
      onclick: async (ev) => {
        ev.stopPropagation();
        toggleBtn.disabled = true;
        try {
          if (isDisconnected) await api.connect(a.id);
          else await api.disconnect(a.id);
          await this.refresh();
        } catch (e) {
          alert(`${isDisconnected ? 'connect' : 'disconnect'} failed: ${e.message}`);
        } finally {
          toggleBtn.disabled = false;
        }
      },
    }, isDisconnected ? 'connect' : 'disconnect') : null;

    // Close button:
    //   active   -> "archive" (soft remove from main view)
    //   archived -> "restore" + "delete forever"
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

    const item = el('div', {
      class: [
        'agent-item',
        isSelected     ? 'agent-item--selected' : '',
        isDisconnected ? 'agent-item--off' : '',
        isArchived     ? 'agent-item--archived' : '',
        a.starred      ? 'agent-item--starred' : '',
      ].filter(Boolean).join(' '),
      onclick: () => this.select(a.id),
    },
      el('div', { class: 'agent-item-top' },
        dot,
        starBtn,
        el('span', { class: 'agent-name' }, a.name || a.id.slice(0, 8)),
        closeArea,
      ),
      el('div', { class: 'agent-item-meta' },
        el('span', { class: 'agent-model' }, a.model || '·'),
        el('span', { class: 'agent-sep' }, '·'),
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
        toggleBtn ? el('span', { class: 'agent-sep' }, '·') : null,
        toggleBtn,
      ),
      a.cwd ? el('div', { class: 'agent-cwd' }, a.cwd) : null,
    );
    return item;
  }

  select(id) {
    this.selectedId = id;
    this.renderList();
    if (typeof this.onSelect === 'function') this.onSelect(id);
  }
}
