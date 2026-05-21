// Sessions page. Owned by its sub-agent.
//
// Wraps `grok sessions list` / `grok sessions search`. The page shows a
// search box, a limit input, a refresh button, and a result table. The
// row click copies the session id; a secondary "use in dashboard" button
// only lights up when the session id matches one of our backend agents
// (sessions from the grok TUI need to be imported first).

import { api } from '../../lib/api';

let activeContainer = null;
let state = {
  q: '',
  limit: 20,
  loading: false,
  error: null,
  raw: '',
  items: [],
  agentIds: new Set(),
  toast: '',
  toastTimer: 0,
};

export function mount(container) {
  activeContainer = container;
  state = {
    q: '',
    limit: 20,
    loading: false,
    error: null,
    raw: '',
    items: [],
    agentIds: new Set(),
    toast: '',
    toastTimer: 0,
  };
  render();
  // Kick off agent-list + initial sessions list in parallel.
  loadAgents();
  load();
}

export function unmount() {
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
    state.toastTimer = 0;
  }
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

async function loadAgents() {
  try {
    const list = await api.listAgents();
    const ids = new Set();
    if (Array.isArray(list)) {
      for (const a of list) {
        if (a && typeof a.sessionId === 'string' && a.sessionId) ids.add(a.sessionId);
        if (a && typeof a.id === 'string' && a.id) ids.add(a.id);
      }
    }
    state.agentIds = ids;
    if (activeContainer) render();
  } catch {
    // Non-fatal. We just won't enable the "use in dashboard" buttons.
  }
}

async function load() {
  state.loading = true;
  state.error = null;
  render();
  try {
    const data = await api.sessions.list({ q: state.q, limit: state.limit });
    state.raw = (data && data.raw) || '';
    state.items = (data && Array.isArray(data.items)) ? data.items : [];
  } catch (err) {
    state.error = err?.message || String(err);
    state.raw = '';
    state.items = [];
  } finally {
    state.loading = false;
    if (activeContainer) render();
  }
}

function showToast(msg) {
  state.toast = msg;
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    state.toast = '';
    state.toastTimer = 0;
    if (activeContainer) render();
  }, 1800);
  render();
}

async function copyId(sid) {
  try {
    await navigator.clipboard.writeText(sid);
    showToast(`copied ${sid.slice(0, 8)}...`);
  } catch {
    showToast('copy failed');
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncId(sid) {
  if (!sid) return '';
  if (sid.length <= 18) return sid;
  return `${sid.slice(0, 8)}...${sid.slice(-4)}`;
}

function render() {
  if (!activeContainer) return;
  const rowsHtml = state.items.length
    ? state.items.map((it) => {
        const hasAgent = state.agentIds.has(it.sessionId);
        const btnHtml = hasAgent
          ? `<button class="sessions-use" data-sid="${escapeHtml(it.sessionId)}" type="button">use in dashboard</button>`
          : `<button class="sessions-use sessions-use--disabled" data-sid="${escapeHtml(it.sessionId)}" type="button"
                   title="this session was created in the grok TUI, not in this dashboard. import it first.">
               import first
             </button>`;
        return `
          <tr class="sessions-row" data-sid="${escapeHtml(it.sessionId)}">
            <td class="sessions-id"  title="${escapeHtml(it.sessionId)}"><code>${escapeHtml(truncId(it.sessionId))}</code></td>
            <td class="sessions-cre">${escapeHtml(it.created)}</td>
            <td class="sessions-st">${escapeHtml(it.status)}</td>
            <td class="sessions-sum">${escapeHtml(it.summary)}</td>
            <td class="sessions-act">${btnHtml}</td>
          </tr>
        `;
      }).join('')
    : '';

  const empty = !state.loading && !state.error && state.items.length === 0;
  const hasRaw = !!(state.raw && state.raw.trim());

  activeContainer.innerHTML = `
    <section class="system-page sessions-page">
      <h2 class="system-page-title">Sessions</h2>
      <p class="system-page-sub">
        wraps <code>grok sessions list</code> and <code>grok sessions search</code>.
        click a row to copy its session id.
      </p>

      <div class="sessions-controls">
        <input
          type="text"
          class="sessions-q"
          placeholder="search sessions..."
          value="${escapeHtml(state.q)}"
        />
        <input
          type="number"
          class="sessions-limit"
          min="1"
          max="200"
          step="1"
          value="${escapeHtml(String(state.limit))}"
          title="max rows to return"
        />
        <button class="sessions-refresh" type="button">${state.loading ? 'loading...' : 'refresh'}</button>
        ${state.toast ? `<span class="sessions-toast">${escapeHtml(state.toast)}</span>` : ''}
      </div>

      ${state.error ? `<div class="sessions-error">${escapeHtml(state.error)}</div>` : ''}

      <div class="sessions-table-wrap">
        <table class="sessions-table">
          <thead>
            <tr>
              <th>session id</th>
              <th>created</th>
              <th>status</th>
              <th>summary</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        ${empty ? `
          <div class="sessions-empty">
            no sessions matched. try a broader query, or check
            <code>grok sessions list</code> in a terminal.
          </div>
        ` : ''}
      </div>

      ${hasRaw ? `
        <details class="sessions-raw">
          <summary>raw output</summary>
          <pre>${escapeHtml(state.raw)}</pre>
        </details>
      ` : ''}
    </section>
  `;

  wire();
}

function wire() {
  if (!activeContainer) return;
  const qInput     = activeContainer.querySelector('.sessions-q');
  const limitInput = activeContainer.querySelector('.sessions-limit');
  const refreshBtn = activeContainer.querySelector('.sessions-refresh');

  if (qInput) {
    qInput.addEventListener('input', (e) => { state.q = e.target.value; });
    qInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        load();
      }
    });
  }
  if (limitInput) {
    limitInput.addEventListener('input', (e) => {
      const n = parseInt(e.target.value, 10);
      state.limit = Number.isFinite(n) && n > 0 ? n : 20;
    });
    limitInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        load();
      }
    });
  }
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => load());
  }

  const rows = activeContainer.querySelectorAll('.sessions-row');
  rows.forEach((row) => {
    row.addEventListener('click', (e) => {
      // Don't copy when the user clicked the action button.
      if (e.target && e.target.closest && e.target.closest('.sessions-use')) return;
      const sid = row.getAttribute('data-sid');
      if (sid) copyId(sid);
    });
  });

  const useBtns = activeContainer.querySelectorAll('.sessions-use');
  useBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sid = btn.getAttribute('data-sid');
      if (!sid) return;
      if (btn.classList.contains('sessions-use--disabled')) {
        showToast('session lives in the grok TUI. open the Import page first.');
        return;
      }
      window.location.hash = `#/agents/${sid}`;
    });
  });
}
