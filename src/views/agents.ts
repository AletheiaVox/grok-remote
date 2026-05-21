// Agents sidebar: list + new + star + archive + folders.
//
// Rows are intentionally compact: status dot + star + name + archive close. The
// model badge, connect/disconnect link, and cwd path were moved off the row
// (cwd is meant to land in the chat topbar; see CHAT_TOPBAR_TODO.md). Folders
// are persisted server-side via /api/folders. Drag/drop uses Pointer Events so
// the same code path works on desktop and touch.

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

const SORT_KEY        = 'grok-remote.sidebar.sort';
const SEARCH_KEY      = 'grok-remote.sidebar.search';
const COLLAPSED_KEY   = 'grok-remote.sidebar.collapsed-folders';
const SORT_DEFAULT    = 'created_desc';
const LONG_PRESS_MS   = 500;
const DRAG_MOVE_THRESH = 6;

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
function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch { return new Set(); }
}
function saveCollapsed(set: Set<string>): void {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(set))); } catch { /* ignore */ }
}

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

export interface Folder {
  id: string;
  name: string;
  agentIds: string[];
  createdAt: string;
}

export interface AgentsSidebarOptions {
  onSelect?: (id: string) => void;
  onCreate?: (created: Agent) => void;
  onDelete?: (id: string) => void;
}

const TOP_LEVEL_ID = '__top__';

export class AgentsSidebar {
  onSelect?: (id: string) => void;
  onCreate?: (created: Agent) => void;
  onDelete?: (id: string) => void;

  agents: Agent[];
  folders: Folder[];
  selectedId: string | null;
  pollHandle: ReturnType<typeof setInterval> | null;
  showArchived: boolean;
  sortKey: string;
  search: string;
  collapsed: Set<string>;

  activeList: HTMLElement;
  archivedList: HTMLElement;
  empty: HTMLElement;
  noMatch: HTMLElement;
  error: HTMLElement;
  newBtn: HTMLButtonElement;
  newFolderBtn: HTMLButtonElement;
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

  // Drag state (pointer-events based).
  private _drag: {
    agentId: string;
    pointerId: number;
    startX: number;
    startY: number;
    sourceEl: HTMLElement;
    ghost: HTMLElement | null;
    active: boolean;
    pressTimer: number | null;
  } | null = null;

  constructor({ onSelect, onCreate, onDelete }: AgentsSidebarOptions) {
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
    this.collapsed = loadCollapsed();

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

    this.newFolderBtn = el('button', {
      class: 'agents-new-folder-btn',
      type: 'button',
      title: 'create a new folder',
      onclick: () => void this.promptNewFolder(),
    }, '+ folder') as HTMLButtonElement;

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

  async promptNewFolder(): Promise<void> {
    const name = window.prompt('New folder name:');
    if (!name || !name.trim()) return;
    try {
      await api.folders.create(name.trim());
      await this.refreshFolders();
      this.renderList();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`create folder failed: ${msg}`);
    }
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
    void this.refresh();
    void this.refreshFolders();
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

  async refreshFolders(): Promise<void> {
    try {
      const data = await api.folders.list() as unknown;
      this.folders = Array.isArray(data) ? data as Folder[] : [];
    } catch {
      this.folders = [];
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

    // Bucket active agents by folder id.
    const folderById = new Map<string, Folder>();
    for (const f of this.folders) folderById.set(f.id, f);
    const folderOfAgent = new Map<string, string>();
    for (const f of this.folders) for (const aid of f.agentIds) folderOfAgent.set(aid, f.id);

    const topLevel: Agent[] = [];
    const buckets = new Map<string, Agent[]>();
    for (const a of active) {
      const fid = folderOfAgent.get(a.id);
      if (fid && folderById.has(fid)) {
        if (!buckets.has(fid)) buckets.set(fid, []);
        buckets.get(fid)!.push(a);
      } else {
        topLevel.push(a);
      }
    }

    if (!allActive.length) {
      this.activeList.appendChild(this.empty);
    } else if (!active.length && this.folders.length === 0) {
      this.activeList.appendChild(this.noMatch);
    } else {
      // Top-level group only shows when there are folders OR there are items.
      if (this.folders.length > 0) {
        this.activeList.appendChild(this.renderGroup(TOP_LEVEL_ID, 'top level', topLevel, null));
        for (const f of this.folders) {
          this.activeList.appendChild(this.renderGroup(f.id, f.name, buckets.get(f.id) || [], f));
        }
      } else {
        for (const a of topLevel) this.activeList.appendChild(this.renderItem(a, false));
      }
    }
    for (const a of archived) this.archivedList.appendChild(this.renderItem(a, true));

    this.renderArchivedToggle(allArchived.length);
  }

  private renderGroup(groupId: string, label: string, items: Agent[], folder: Folder | null): HTMLElement {
    const isTopLevel = groupId === TOP_LEVEL_ID;
    const isCollapsed = this.collapsed.has(groupId);
    const folderId = isTopLevel ? null : groupId;

    const caret = el('span', { class: 'folder-caret' }, isCollapsed ? '▶' : '▼');
    const labelEl = el('span', { class: 'folder-name' }, label);
    const count = el('span', { class: 'folder-count' }, String(items.length));

    const deleteBtn = !isTopLevel ? el('button', {
      class: 'folder-delete',
      type: 'button',
      title: 'delete folder (agents move back to top level)',
      onclick: async (ev: MouseEvent) => {
        ev.stopPropagation();
        if (!confirm(`Delete folder "${label}"?\nIts agents move back to the top level.`)) return;
        try {
          await api.folders.remove(folderId!);
          await this.refreshFolders();
          this.renderList();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`delete folder failed: ${msg}`);
        }
      },
    }, '×') as HTMLButtonElement : null;

    const header = el('div', {
      class: `folder-header${isTopLevel ? ' folder-header--top' : ''}`,
      'data-folder-id': groupId,
      onclick: () => {
        if (isCollapsed) this.collapsed.delete(groupId); else this.collapsed.add(groupId);
        saveCollapsed(this.collapsed);
        this.renderList();
      },
      ondblclick: (ev: MouseEvent) => {
        if (isTopLevel || !folder) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.beginInlineRenameFolder(folder, labelEl as HTMLElement);
      },
    }, caret, labelEl, count, deleteBtn) as HTMLElement;

    const body = el('div', { class: 'folder-body' }) as HTMLElement;
    if (!isCollapsed) {
      if (items.length === 0) {
        body.appendChild(el('div', { class: 'folder-empty' },
          isTopLevel ? 'drop agents here to remove from folders' : 'drop agents here'));
      } else {
        for (const a of items) body.appendChild(this.renderItem(a, false));
      }
    }

    return el('div', { class: 'folder-group', 'data-folder-id': groupId }, header, body) as HTMLElement;
  }

  private beginInlineRenameFolder(folder: Folder, labelEl: HTMLElement): void {
    const parent = labelEl.parentElement;
    if (!parent) return;
    const input = el('input', {
      class: 'folder-rename-input',
      type: 'text',
      value: folder.name,
      onclick: (ev: MouseEvent) => ev.stopPropagation(),
      onkeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') { ev.preventDefault(); (ev.target as HTMLInputElement).blur(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); (input as HTMLInputElement).value = folder.name; (ev.target as HTMLInputElement).blur(); }
      },
      onblur: async (ev: FocusEvent) => {
        const next = ((ev.target as HTMLInputElement).value || '').trim();
        if (!next || next === folder.name) { this.renderList(); return; }
        try {
          await api.folders.update(folder.id, { name: next });
          await this.refreshFolders();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`rename folder failed: ${msg}`);
        }
        this.renderList();
      },
    }) as HTMLInputElement;
    parent.replaceChild(input, labelEl);
    input.focus();
    input.select();
  }

  private beginInlineRenameAgent(a: Agent, nameEl: HTMLElement): void {
    const parent = nameEl.parentElement;
    if (!parent) return;
    const input = el('input', {
      class: 'agent-rename-input',
      type: 'text',
      value: a.name || '',
      onclick: (ev: MouseEvent) => ev.stopPropagation(),
      onkeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') { ev.preventDefault(); (ev.target as HTMLInputElement).blur(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); (input as HTMLInputElement).value = a.name || ''; (input as HTMLInputElement).dataset['cancel'] = '1'; (ev.target as HTMLInputElement).blur(); }
      },
      onblur: async (ev: FocusEvent) => {
        const target = ev.target as HTMLInputElement;
        const cancel = target.dataset['cancel'] === '1';
        const next = (target.value || '').trim();
        if (cancel || !next || next === a.name) { this.renderList(); return; }
        try {
          await api.updateAgent(a.id, { name: next });
          await this.refresh();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`rename failed: ${msg}`);
          this.renderList();
        }
      },
    }) as HTMLInputElement;
    parent.replaceChild(input, nameEl);
    input.focus();
    input.select();
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

    const nameEl = el('span', {
      class: 'agent-name',
      ondblclick: (ev: MouseEvent) => {
        if (isArchived) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.beginInlineRenameAgent(a, nameEl as HTMLElement);
      },
    }, a.name || a.id.slice(0, 8)) as HTMLElement;

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

    const inflightChip = (typeof a.inFlight === 'number' && a.inFlight > 0)
      ? el('span', { class: 'agent-inflight', title: `${a.inFlight} tool call${a.inFlight === 1 ? '' : 's'} in flight` },
          el('span', { class: 'agent-inflight-dot' }),
          `${a.inFlight} tool${a.inFlight === 1 ? '' : 's'}`)
      : null;
    const tokenChip = (typeof a.totalTokens === 'number' && a.totalTokens > 0)
      ? el('span', { class: 'agent-tokens', title: `${a.totalTokens.toLocaleString()} tokens in context` }, fmtTokens(a.totalTokens))
      : null;
    const statusChip = el('span', { class: `agent-status agent-status--${status}` }, STATUS_LABEL[status] || status);

    const metaChildren: (HTMLElement | null)[] = [statusChip];
    if (inflightChip) metaChildren.push(inflightChip);
    if (tokenChip) metaChildren.push(tokenChip);

    const item = el('div', {
      class: [
        'agent-item',
        isSelected     ? 'agent-item--selected' : '',
        isDisconnected ? 'agent-item--off' : '',
        isArchived     ? 'agent-item--archived' : '',
        a.starred      ? 'agent-item--starred' : '',
      ].filter(Boolean).join(' '),
      'data-agent-id': a.id,
      onclick: () => this.select(a.id),
    },
      el('div', { class: 'agent-item-top' },
        dot,
        starBtn,
        nameEl,
        closeArea,
      ),
      el('div', { class: 'agent-item-meta' }, ...metaChildren),
    ) as HTMLElement;

    if (!isArchived) this._attachDragHandlers(item, a.id);
    return item;
  }

  // Pointer-events drag/drop. Long-press to start, follow finger/mouse, drop on
  // a folder header to assign. The same code path covers desktop and touch.
  private _attachDragHandlers(item: HTMLElement, agentId: string): void {
    const onPointerDown = (ev: PointerEvent): void => {
      if (ev.button !== undefined && ev.button !== 0) return;
      // Don't start a drag from interactive controls inside the row.
      const target = ev.target as HTMLElement | null;
      if (target && target.closest('button, input, select, textarea, a')) return;
      this._cancelDrag();
      const drag = {
        agentId,
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        sourceEl: item,
        ghost: null as HTMLElement | null,
        active: false,
        pressTimer: null as number | null,
      };
      this._drag = drag;
      drag.pressTimer = window.setTimeout(() => {
        if (this._drag === drag) this._activateDrag(ev.clientX, ev.clientY);
      }, LONG_PRESS_MS);
      try { item.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    };

    const onPointerMove = (ev: PointerEvent): void => {
      const drag = this._drag;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      if (!drag.active) {
        // Cancel the press-and-hold if the user is just scrolling vertically.
        const moved = Math.hypot(dx, dy);
        if (moved > DRAG_MOVE_THRESH) {
          if (Math.abs(dy) > Math.abs(dx)) {
            // Vertical drag = scroll intent. Bail out so the list scrolls.
            this._cancelDrag();
            return;
          }
          this._activateDrag(ev.clientX, ev.clientY);
        }
        return;
      }
      ev.preventDefault();
      this._moveGhost(ev.clientX, ev.clientY);
      this._highlightDropTarget(ev.clientX, ev.clientY);
    };

    const onPointerUp = (ev: PointerEvent): void => {
      const drag = this._drag;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      try { item.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      if (!drag.active) { this._cancelDrag(); return; }
      const target = this._findDropTarget(ev.clientX, ev.clientY);
      this._endDrag();
      if (target) void this._assignAgentToFolder(drag.agentId, target);
    };

    const onPointerCancel = (ev: PointerEvent): void => {
      const drag = this._drag;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      this._cancelDrag();
    };

    item.addEventListener('pointerdown', onPointerDown);
    item.addEventListener('pointermove', onPointerMove);
    item.addEventListener('pointerup', onPointerUp);
    item.addEventListener('pointercancel', onPointerCancel);
  }

  private _activateDrag(clientX: number, clientY: number): void {
    const drag = this._drag;
    if (!drag || drag.active) return;
    drag.active = true;
    if (drag.pressTimer) { clearTimeout(drag.pressTimer); drag.pressTimer = null; }
    // Build a floating ghost that follows the pointer.
    const rect = drag.sourceEl.getBoundingClientRect();
    const ghost = drag.sourceEl.cloneNode(true) as HTMLElement;
    ghost.classList.add('agent-drag-ghost');
    ghost.style.position = 'fixed';
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.pointerEvents = 'none';
    ghost.style.opacity = '0.85';
    ghost.style.zIndex = '9999';
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.sourceEl.classList.add('agent-item--dragging');
    this._moveGhost(clientX, clientY);
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch { /* ignore */ } }
  }

  private _moveGhost(clientX: number, clientY: number): void {
    const drag = this._drag;
    if (!drag || !drag.ghost) return;
    const rect = drag.sourceEl.getBoundingClientRect();
    const offsetX = drag.startX - rect.left;
    const offsetY = drag.startY - rect.top;
    drag.ghost.style.left = `${clientX - offsetX}px`;
    drag.ghost.style.top  = `${clientY - offsetY}px`;
  }

  private _highlightDropTarget(clientX: number, clientY: number): void {
    const all = this.activeList.querySelectorAll<HTMLElement>('.folder-header');
    let hit: HTMLElement | null = null;
    for (const h of all) {
      const r = h.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        hit = h;
        break;
      }
    }
    for (const h of all) h.classList.toggle('folder-header--drop', h === hit);
  }

  private _findDropTarget(clientX: number, clientY: number): string | null {
    const all = this.activeList.querySelectorAll<HTMLElement>('.folder-header');
    for (const h of all) {
      const r = h.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        return h.getAttribute('data-folder-id');
      }
    }
    return null;
  }

  private _endDrag(): void {
    const drag = this._drag;
    if (!drag) return;
    if (drag.pressTimer) { clearTimeout(drag.pressTimer); drag.pressTimer = null; }
    if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    drag.sourceEl.classList.remove('agent-item--dragging');
    this.activeList.querySelectorAll('.folder-header--drop').forEach((n) => n.classList.remove('folder-header--drop'));
    this._drag = null;
  }

  private _cancelDrag(): void {
    if (!this._drag) return;
    this._endDrag();
  }

  private async _assignAgentToFolder(agentId: string, groupId: string): Promise<void> {
    const folderId = groupId === TOP_LEVEL_ID ? null : groupId;
    try {
      await api.agents.setFolder(agentId, folderId);
      await this.refreshFolders();
      this.renderList();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`move failed: ${msg}`);
    }
  }

  select(id: string): void {
    this.selectedId = id;
    this.renderList();
    if (typeof this.onSelect === 'function') this.onSelect(id);
  }
}
