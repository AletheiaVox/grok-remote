// Agents sidebar: list + new + star + archive flow.

import { api } from '../lib/api.js';
import { el } from '../lib/render.js';
import { fmtTokens } from '../lib/format.js';

const STATUS_LABEL: Record<string, string> = {
  idle:         'idle',
  running:      'running',
  errored:      'errored',
  killed:       'killed',
  starting:     'starting',
  disconnected: 'disconnected',
  exited:       'disconnected',
};

const SORT_KEY   = 'grok-remote.sidebar.sort';
const SEARCH_KEY = 'grok-remote.sidebar.search';
const SORT_DEFAULT = 'created_desc';

interface SortConfig { label: string; cmp(a: Agent, b: Agent): number }

const SORTS: Record<string, SortConfig> = {
  created_desc:    { label: 'newest first',     cmp: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') },
  created_asc:     { label: 'oldest first',     cmp: (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') },
  activity_desc:   { label: 'last active',      cmp: (a, b) => (b.lastSeen   || '').localeCompare(a.lastSeen   || '') },
  name_asc:        { label: 'name (a -> z)',    cmp: (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }) },
};

function loadSort(): string { try { const v = localStorage.getItem(SORT_KEY); return v && SORTS[v] ? v : SORT_DEFAULT; } catch { return SORT_DEFAULT; } }
function saveSort(v: string): void { try { localStorage.setItem(SORT_KEY, v); } catch { /* ignore */ } }
function loadSearch(): string { try { return localStorage.getItem(SEARCH_KEY) || ''; } catch { return ''; } }
function saveSearch(v: string): void { try { localStorage.setItem(SEARCH_KEY, v); } catch { /* ignore */ } }

export interface Agent {
  id: string;
  name?: string;
  model?: string;
  status?: string;
  cwd?: string;
  createdAt?: string;
  lastSeen?: string;
  starred?: boolean;
  archived?: boolean;
  totalTokens?: number;
  inFlight?: number;
  [k: string]: unknown;
}

export interface AgentsSidebarOptions {
  onSelect?: (id: string) => void;
  onCreate?: (created: Agent) => void;
  onDelete?: (id: string) => void;
}

export class AgentsSidebar {
  onSelect?: (id: string) => void;
  onCreate?: (created: Agent) => void;
  onDelete?: (id: string) => void;

  agents: Agent[];
  selectedId: string | null;
  pollHandle: ReturnType<typeof setInterval> | null;
  showArchived: boolean;
  sortKey: string;
  search: string;

  activeList: HTMLElement;
  archivedList: HTMLElement;
  empty: HTMLElement;
  noMatch: HTMLElement;
  error: HTMLElement;
  newBtn: HTMLButtonElement;
  closeDrawerBtn: HTMLButtonElement;
  archivedToggle: HTMLButtonElement;
  searchInput: HTMLInputElement;
  searchClearBtn: HTMLButtonElement;
  sortSelect: HTMLSelectElement;
  root: HTMLElement;

  private _creating?: boolean;
  private _spawnHandlerWired?: boolean;
  private _agentsStream?: EventSource | null;
  private _sseAlive?: boolean;
  private _onVisibility?: () => void;

  constructor({ onSelect, onCreate, onDelete }: AgentsSidebarOptions) {
    this.onSelect = onSelect;
    this.onCreate = onCreate;
    this.onDelete = onDelete;
    this.agents = [];
    this.selectedId = null;
    this.pollHandle = null;
    this.showArchived = false;
    this.sortKey = loadSort();
    this.search  = loadSearch();

    this.activeList   = el('div', { class: 'agents-list' }) as HTMLElement;
    this.archivedList = el('div', { class: 'agents-list agents-list--archived' }) as HTMLElement;
    this.archivedList.hidden = true;

    this.empty = el('div', { class: 'agents-empty' }, 'no agents yet') as HTMLElement;
    this.noMatch = el('div', { class: 'agents-empty' }, 'no conversations match your search') as HTMLElement;
    this.error = el('div', { class: 'agents-empty agents-empty--err' }) as HTMLElement;
    this.error.hidden = true;

    this.newBtn = el('button', {
      class: 'agents-new-btn',
      title: 'spawn a new agent (auto-named from the first message)',
      onclick: () => void this.spawnNew(),
    }, '+ new') as HTMLButtonElement;

    this.closeDrawerBtn = el('button', {
      class: 'sidebar-close',
      type: 'button',
      title: 'close menu',
      'aria-label': 'close menu',
      onclick: () => document.dispatchEvent(new CustomEvent('grok-remote:close-drawer')),
    }, '×') as HTMLButtonElement;

    this.archivedToggle = el('button', {
      class: 'agents-archived-toggle',
      type: 'button',
      onclick: () => this.toggleArchivedView(),
    }, 'archived (0)') as HTMLButtonElement;

    this.searchInput = el('input', {
      class: 'sidebar-search-input',
      type: 'search',
      placeholder: 'search conversations',
      value: this.search,
      'aria-label': 'search conversations',
      oninput: (ev: Event) => {
        const target = ev.target as HTMLInputElement;
        this.search = (target.value || '').trim();
        saveSearch(this.search);
        this.renderList();
      },
    }) as HTMLInputElement;
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
    }, '×') as HTMLButtonElement;

    this.sortSelect = el('select', {
      class: 'sidebar-sort',
      'aria-label': 'sort conversations',
      onchange: (ev: Event) => {
        const target = ev.target as HTMLSelectElement;
        this.sortKey = target.value;
        saveSort(this.sortKey);
        this.renderList();
      },
    },
      ...Object.entries(SORTS).map(([k, s]) =>
        el('option', { value: k, ...(k === this.sortKey ? { selected: '' } : {}) }, s.label),
      ),
    ) as HTMLSelectElement;

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
      el('div', { class: 'sidebar-body' },
        this.activeList,
        el('div', { class: 'agents-archived' },
          this.archivedToggle,
          this.archivedList,
        ),
      ),
    ) as HTMLElement;
  }

  private _sortAgents(list: Agent[]): Agent[] {
    const sorter = SORTS[this.sortKey] || SORTS[SORT_DEFAULT]!;
    return list.slice().sort((a, b) => {
      const s = (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
      if (s) return s;
      return sorter.cmp(a, b);
    });
  }

  private _matchesSearch(a: Agent): boolean {
    if (!this.search) return true;
    const needle = this.search.toLowerCase();
    return (a.name || '').toLowerCase().includes(needle)
        || (a.id || '').toLowerCase().includes(needle)
        || (a.model || '').toLowerCase().includes(needle);
  }

  toggleArchivedView(): void {
    this.showArchived = !this.showArchived;
    this.archivedList.hidden = !this.showArchived;
    this.renderArchivedToggle();
  }

  async spawnNew(): Promise<void> {
    if (this._creating) return;
    this._creating = true;
    this.newBtn.disabled = true;
    this.error.hidden = true;
    const prevLabel = this.newBtn.textContent;
    this.newBtn.textContent = 'spawning...';
    try {
      const created = await api.createAgent({}) as Agent;
      if (typeof this.onCreate === 'function') this.onCreate(created);
      await this.refresh();
      if (created && created.id) this.select(created.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to spawn agent';
      this.error.textContent = msg;
      this.error.hidden = false;
    } finally {
      this._creating = false;
      this.newBtn.disabled = false;
      this.newBtn.textContent = prevLabel;
    }
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
    void this.refresh();
    this._startSseStream();
    this.startPolling();
    if (!this._spawnHandlerWired) {
      document.addEventListener('grok-remote:spawn-agent', () => void this.spawnNew());
      this._spawnHandlerWired = true;
    }
  }

  private _startSseStream(): void {
    if (this._agentsStream) return;
    try {
      const es = new EventSource(api.agentsStreamUrl());
      this._agentsStream = es;
      es.addEventListener('open', () => { this._sseAlive = true; });
      es.addEventListener('agents_snapshot', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data);
          if (d && Array.isArray(d.agents)) {
            this.agents = d.agents;
            this.renderList();
            document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: d.agents }));
          }
        } catch { /* ignore */ }
      });
      const onMutation = (): void => { void this.refresh(); };
      es.addEventListener('agent_added',   onMutation);
      es.addEventListener('agent_removed', onMutation);
      es.addEventListener('agent_updated', onMutation);
      es.addEventListener('agent_status',  onMutation);
      es.addEventListener('agent_tokens', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data) as { id?: string; totalTokens?: unknown };
          if (!d || !d.id || typeof d.totalTokens !== 'number') return;
          const idx = this.agents.findIndex((a) => a && a.id === d.id);
          if (idx < 0) return;
          this.agents[idx] = { ...this.agents[idx]!, totalTokens: d.totalTokens };
          this.renderList();
          document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: this.agents }));
        } catch { /* ignore */ }
      });
      es.addEventListener('agent_inflight', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data) as { id?: string; inFlight?: unknown };
          if (!d || !d.id || typeof d.inFlight !== 'number') return;
          const idx = this.agents.findIndex((a) => a && a.id === d.id);
          if (idx < 0) return;
          this.agents[idx] = { ...this.agents[idx]!, inFlight: d.inFlight };
          this.renderList();
          document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: this.agents }));
        } catch { /* ignore */ }
      });
      es.addEventListener('error', () => { this._sseAlive = false; });
    } catch {
      this._agentsStream = null;
    }
  }

  private _stopSseStream(): void {
    if (this._agentsStream) {
      try { this._agentsStream.close(); } catch { /* ignore */ }
      this._agentsStream = null;
    }
  }

  startPolling(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = setInterval(() => {
      if (document.hidden) return;
      if (this._sseAlive) return;
      void this.refresh();
    }, 4000);
    if (!this._onVisibility) {
      this._onVisibility = (): void => {
        if (!document.hidden) void this.refresh();
      };
      document.addEventListener('visibilitychange', this._onVisibility);
    }
  }

  stopPolling(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    if (this._onVisibility) {
      document.removeEventListener('visibilitychange', this._onVisibility);
      this._onVisibility = undefined;
    }
    this._stopSseStream();
  }

  async refresh(): Promise<void> {
    try {
      const data = await api.listAgents();
      const agents: Agent[] = Array.isArray(data)
        ? data as Agent[]
        : (data && typeof data === 'object' && Array.isArray((data as { agents?: unknown }).agents)
            ? (data as { agents: Agent[] }).agents
            : []);
      this.agents = agents;
      this.renderList();
      document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: agents }));
    } catch (e) {
      this.agents = [];
      const msg = e instanceof Error ? e.message : String(e);
      this.renderList(msg);
    }
  }

  renderArchivedToggle(count?: number): void {
    const n = (typeof count === 'number')
      ? count
      : this.agents.filter((a) => a.archived).length;
    const label = n === 0 ? 'archived (0)' : `${this.showArchived ? '▼' : '▶'} archived (${n})`;
    this.archivedToggle.textContent = label;
    this.archivedToggle.disabled = n === 0;
  }

  renderList(errorMessage?: string): void {
    this.activeList.replaceChildren();
    this.archivedList.replaceChildren();
    if (this.searchClearBtn) this.searchClearBtn.hidden = !this.search;

    if (errorMessage) {
      this.activeList.appendChild(el('div', { class: 'agents-empty agents-empty--err' },
        'backend unreachable'));
      this.renderArchivedToggle();
      return;
    }

    const allActive   = this.agents.filter((a) => !a.archived);
    const allArchived = this.agents.filter((a) =>  a.archived);
    const active   = this._sortAgents(allActive).filter((a) => this._matchesSearch(a));
    const archived = this._sortAgents(allArchived).filter((a) => this._matchesSearch(a));

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

  renderItem(a: Agent, isArchived: boolean): HTMLElement {
    const isSelected = a.id === this.selectedId;
    const status = a.status || 'idle';
    const isDisconnected = status === 'disconnected' || status === 'exited';
    const dot = el('span', { class: `agent-dot agent-dot--${status}` });

    const starBtn = el('button', {
      class: `agent-star${a.starred ? ' is-on' : ''}`,
      title: a.starred ? 'unstar' : 'star',
      type: 'button',
      onclick: async (ev: MouseEvent) => {
        ev.stopPropagation();
        starBtn.disabled = true;
        try {
          await api.updateAgent(a.id, { starred: !a.starred });
          await this.refresh();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`star failed: ${msg}`);
        } finally {
          starBtn.disabled = false;
        }
      },
    }, a.starred ? '★' : '☆') as HTMLButtonElement;

    const toggleBtn: HTMLButtonElement | null = !isArchived ? (el('button', {
      class: `agent-link${isDisconnected ? ' agent-link--off' : ''}`,
      title: isDisconnected ? 'connect (resume conversation)' : 'disconnect (stop process, keep history)',
      onclick: async (ev: MouseEvent) => {
        ev.stopPropagation();
        if (toggleBtn) toggleBtn.disabled = true;
        try {
          if (isDisconnected) await api.connect(a.id);
          else await api.disconnect(a.id);
          await this.refresh();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`${isDisconnected ? 'connect' : 'disconnect'} failed: ${msg}`);
        } finally {
          if (toggleBtn) toggleBtn.disabled = false;
        }
      },
    }, isDisconnected ? 'connect' : 'disconnect') as HTMLButtonElement) : null;

    let closeArea: HTMLElement | null;
    if (!isArchived) {
      const archiveBtn = el('button', {
        class: 'agent-archive',
        type: 'button',
        title: 'archive (move to archived; you can restore or delete later)',
        onclick: async (ev: MouseEvent) => {
          ev.stopPropagation();
          archiveBtn.disabled = true;
          try {
            await api.updateAgent(a.id, { archived: true });
            if (this.selectedId === a.id) this.selectedId = null;
            await this.refresh();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`archive failed: ${msg}`);
          } finally {
            archiveBtn.disabled = false;
          }
        },
      }, '×') as HTMLButtonElement;
      closeArea = archiveBtn;
    } else {
      const restoreBtn = el('button', {
        class: 'agent-restore',
        type: 'button',
        title: 'restore from archive',
        onclick: async (ev: MouseEvent) => {
          ev.stopPropagation();
          restoreBtn.disabled = true;
          try {
            await api.updateAgent(a.id, { archived: false });
            await this.refresh();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`restore failed: ${msg}`);
          } finally {
            restoreBtn.disabled = false;
          }
        },
      }, 'restore') as HTMLButtonElement;
      const deleteBtn = el('button', {
        class: 'agent-delete-forever',
        type: 'button',
        title: 'delete forever (removes history + uploads)',
        onclick: async (ev: MouseEvent) => {
          ev.stopPropagation();
          if (!confirm(`Delete "${a.name || a.id}" forever?\nThis removes its history and uploaded files. Cannot be undone.`)) return;
          try {
            await api.deleteAgent(a.id);
            if (typeof this.onDelete === 'function') this.onDelete(a.id);
            if (this.selectedId === a.id) this.selectedId = null;
            await this.refresh();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`delete failed: ${msg}`);
          }
        },
      }, 'delete') as HTMLButtonElement;
      closeArea = el('div', { class: 'agent-archived-actions' }, restoreBtn, deleteBtn) as HTMLElement;
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
    ) as HTMLElement;
    return item;
  }

  select(id: string): void {
    this.selectedId = id;
    this.renderList();
    if (typeof this.onSelect === 'function') this.onSelect(id);
  }
}
