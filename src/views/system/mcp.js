// MCP servers page. Lists configured MCP servers, lets you add/remove, and
// run `grok mcp doctor` against one or all of them.

import { api } from '../../lib/api';

let activeContainer = null;
let state = {
  loading: false,
  loadError: null,
  servers: [],
  // per-card UI state, keyed by server name
  cards: new Map(),
  // selected transport in the add form
  formType: 'stdio',
  formError: null,
  formBusy: false,
  doctorAllBusy: false,
  doctorAllResult: null,
  doctorAllError: null,
};

export function mount(container) {
  activeContainer = container;
  state = {
    loading: false,
    loadError: null,
    servers: [],
    cards: new Map(),
    formType: 'stdio',
    formError: null,
    formBusy: false,
    doctorAllBusy: false,
    doctorAllResult: null,
    doctorAllError: null,
  };
  render();
  refreshList();
}

export function unmount() {
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

function render() {
  if (!activeContainer) return;
  activeContainer.replaceChildren();
  const root = document.createElement('section');
  root.className = 'system-page';
  root.innerHTML = `
    <header class="mcp-header">
      <h2 class="system-page-title">MCP servers</h2>
      <div class="mcp-header-actions">
        <button type="button" class="mcp-btn" data-act="refresh">refresh</button>
        <button type="button" class="mcp-btn mcp-btn--accent" data-act="doctor-all">doctor all</button>
      </div>
    </header>

    <p class="system-page-sub">
      Configured MCP servers from <code>grok mcp list</code>. Add stdio
      processes or HTTP/SSE endpoints. The doctor command attempts the
      configured transport and reports connectivity issues.
    </p>

    <div class="mcp-doctor-all" data-slot="doctor-all"></div>

    <div class="mcp-list" data-slot="list"></div>

    <section class="mcp-add">
      <h3 class="mcp-section-title">Add server</h3>
      <form class="mcp-add-form" data-slot="form" autocomplete="off">
        <label class="mcp-field">
          <span class="mcp-field-label">name</span>
          <input name="name" type="text" required pattern="[A-Za-z0-9_.\\-]+" placeholder="my-server" />
        </label>

        <div class="mcp-field mcp-field--row">
          <span class="mcp-field-label">transport</span>
          <label class="mcp-radio"><input type="radio" name="type" value="stdio" checked /> stdio</label>
          <label class="mcp-radio"><input type="radio" name="type" value="http" /> http</label>
          <label class="mcp-radio"><input type="radio" name="type" value="sse" /> sse</label>
        </div>

        <div class="mcp-stdio-fields" data-slot="stdio-fields">
          <label class="mcp-field">
            <span class="mcp-field-label">command</span>
            <input name="command" type="text" placeholder="npx" />
          </label>
          <label class="mcp-field">
            <span class="mcp-field-label">args (one per line)</span>
            <textarea name="args" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-github"></textarea>
          </label>
          <label class="mcp-field">
            <span class="mcp-field-label">env (KEY=VALUE per line)</span>
            <textarea name="env" rows="3" placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=ghp_..."></textarea>
          </label>
        </div>

        <div class="mcp-url-fields" data-slot="url-fields" hidden>
          <label class="mcp-field">
            <span class="mcp-field-label">url</span>
            <input name="url" type="text" placeholder="https://mcp.example.com/v1" />
          </label>
        </div>

        <div class="mcp-form-error" data-slot="form-error" hidden></div>

        <div class="mcp-form-actions">
          <button type="submit" class="mcp-btn mcp-btn--primary" data-slot="submit">add</button>
          <button type="reset" class="mcp-btn">reset</button>
        </div>
      </form>
    </section>
  `;
  activeContainer.appendChild(root);

  // Wire up header actions.
  root.querySelector('[data-act="refresh"]').addEventListener('click', () => {
    refreshList();
  });
  root.querySelector('[data-act="doctor-all"]').addEventListener('click', () => {
    runDoctorAll();
  });

  // Wire the add form.
  const form = root.querySelector('[data-slot="form"]');
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submitAddForm(form);
  });
  form.addEventListener('reset', () => {
    state.formType = 'stdio';
    state.formError = null;
    queueMicrotask(() => syncFormVisibility(form));
  });
  form.addEventListener('change', (ev) => {
    if (ev.target && ev.target.name === 'type') {
      state.formType = ev.target.value;
      syncFormVisibility(form);
    }
  });
  syncFormVisibility(form);

  renderList();
  renderDoctorAll();
}

function syncFormVisibility(form) {
  const isStdio = state.formType === 'stdio';
  const stdio = form.querySelector('[data-slot="stdio-fields"]');
  const urlBox = form.querySelector('[data-slot="url-fields"]');
  if (stdio) stdio.hidden = !isStdio;
  if (urlBox) urlBox.hidden = isStdio;
  const errSlot = form.querySelector('[data-slot="form-error"]');
  if (errSlot) {
    if (state.formError) {
      errSlot.textContent = state.formError;
      errSlot.hidden = false;
    } else {
      errSlot.textContent = '';
      errSlot.hidden = true;
    }
  }
  const submit = form.querySelector('[data-slot="submit"]');
  if (submit) {
    submit.disabled = state.formBusy;
    submit.textContent = state.formBusy ? 'adding...' : 'add';
  }
}

function renderList() {
  if (!activeContainer) return;
  const slot = activeContainer.querySelector('[data-slot="list"]');
  if (!slot) return;
  slot.replaceChildren();

  if (state.loading) {
    const p = document.createElement('p');
    p.className = 'mcp-empty';
    p.textContent = 'loading...';
    slot.appendChild(p);
    return;
  }
  if (state.loadError) {
    const p = document.createElement('p');
    p.className = 'mcp-empty mcp-empty--err';
    p.textContent = `failed to load: ${state.loadError}`;
    slot.appendChild(p);
    return;
  }
  if (!state.servers.length) {
    const p = document.createElement('p');
    p.className = 'mcp-empty';
    p.textContent = 'no MCP servers configured. add one below.';
    slot.appendChild(p);
    return;
  }

  for (const server of state.servers) {
    slot.appendChild(buildCard(server));
  }
}

function buildCard(server) {
  const name = readServerName(server);
  const transport = readTransport(server);
  const target = readTarget(server);
  const args = readArgs(server);
  const env = readEnv(server);
  const cardState = ensureCardState(name);

  const card = document.createElement('article');
  card.className = 'mcp-card';
  card.dataset.name = name;

  const head = document.createElement('header');
  head.className = 'mcp-card-head';
  const title = document.createElement('div');
  title.className = 'mcp-card-title';
  title.textContent = name;
  const badge = document.createElement('span');
  badge.className = `mcp-badge mcp-badge--${transport || 'unknown'}`;
  badge.textContent = transport || 'unknown';
  head.appendChild(title);
  head.appendChild(badge);

  const body = document.createElement('div');
  body.className = 'mcp-card-body';
  if (target) {
    const row = document.createElement('div');
    row.className = 'mcp-row';
    row.innerHTML = `<span class="mcp-row-label">${transport === 'stdio' ? 'command' : 'url'}</span>`;
    const code = document.createElement('code');
    code.className = 'mcp-row-value';
    code.textContent = target;
    row.appendChild(code);
    body.appendChild(row);
  }
  if (args && args.length) {
    const row = document.createElement('div');
    row.className = 'mcp-row';
    row.innerHTML = `<span class="mcp-row-label">args</span>`;
    const code = document.createElement('code');
    code.className = 'mcp-row-value';
    code.textContent = args.join(' ');
    row.appendChild(code);
    body.appendChild(row);
  }
  if (env && Object.keys(env).length) {
    const row = document.createElement('div');
    row.className = 'mcp-row';
    row.innerHTML = `<span class="mcp-row-label">env</span>`;
    const code = document.createElement('code');
    code.className = 'mcp-row-value';
    // Don't print secret values. Just list the keys.
    code.textContent = Object.keys(env).join(', ');
    row.appendChild(code);
    body.appendChild(row);
  }

  const actions = document.createElement('div');
  actions.className = 'mcp-card-actions';
  const docBtn = document.createElement('button');
  docBtn.type = 'button';
  docBtn.className = 'mcp-btn';
  docBtn.textContent = cardState.doctorBusy ? 'checking...' : 'doctor';
  docBtn.disabled = cardState.doctorBusy;
  docBtn.addEventListener('click', () => runDoctorOne(name));
  const rmBtn = document.createElement('button');
  rmBtn.type = 'button';
  rmBtn.className = 'mcp-btn mcp-btn--danger';
  rmBtn.textContent = cardState.removing ? 'removing...' : 'remove';
  rmBtn.disabled = cardState.removing;
  rmBtn.addEventListener('click', () => removeServer(name));
  actions.appendChild(docBtn);
  actions.appendChild(rmBtn);

  card.appendChild(head);
  card.appendChild(body);
  card.appendChild(actions);

  // Doctor / error output panel below the card body.
  if (cardState.doctorResult || cardState.doctorError) {
    const out = document.createElement('pre');
    out.className = 'mcp-card-output';
    if (cardState.doctorError) {
      out.classList.add('mcp-card-output--err');
      out.textContent = cardState.doctorError;
    } else {
      out.textContent = formatJson(cardState.doctorResult);
    }
    card.appendChild(out);
  }

  return card;
}

function ensureCardState(name) {
  let cs = state.cards.get(name);
  if (!cs) {
    cs = { doctorBusy: false, doctorResult: null, doctorError: null, removing: false };
    state.cards.set(name, cs);
  }
  return cs;
}

function readServerName(server) {
  if (!server || typeof server !== 'object') return String(server);
  return server.name || server.id || server.key || '';
}
function readTransport(server) {
  if (!server || typeof server !== 'object') return '';
  const t = server.type || server.transport;
  if (t) return String(t).toLowerCase();
  if (server.command) return 'stdio';
  if (server.url) {
    return 'http';
  }
  return '';
}
function readTarget(server) {
  if (!server || typeof server !== 'object') return '';
  if (server.command) return String(server.command);
  if (server.url) return String(server.url);
  return '';
}
function readArgs(server) {
  if (!server || typeof server !== 'object') return [];
  if (Array.isArray(server.args)) return server.args.map(String);
  return [];
}
function readEnv(server) {
  if (!server || typeof server !== 'object') return {};
  const e = server.env;
  if (e && typeof e === 'object' && !Array.isArray(e)) return e;
  if (Array.isArray(e)) {
    const out = {};
    for (const pair of e) {
      if (typeof pair !== 'string') continue;
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      out[pair.slice(0, i)] = pair.slice(i + 1);
    }
    return out;
  }
  return {};
}

function formatJson(value) {
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

async function refreshList() {
  state.loading = true;
  state.loadError = null;
  renderList();
  try {
    const resp = await api.mcp.list();
    state.servers = Array.isArray(resp?.servers) ? resp.servers : [];
  } catch (err) {
    state.loadError = err?.message || String(err);
    state.servers = [];
  } finally {
    state.loading = false;
    // Drop stale per-card state for servers that are no longer present.
    const live = new Set(state.servers.map(readServerName));
    for (const k of Array.from(state.cards.keys())) {
      if (!live.has(k)) state.cards.delete(k);
    }
    renderList();
  }
}

async function submitAddForm(form) {
  const fd = new FormData(form);
  const name = String(fd.get('name') || '').trim();
  const type = String(fd.get('type') || 'stdio');
  const command = String(fd.get('command') || '').trim();
  const url = String(fd.get('url') || '').trim();
  const argsRaw = String(fd.get('args') || '');
  const envRaw = String(fd.get('env') || '');

  if (!name) {
    state.formError = 'name is required';
    syncFormVisibility(form);
    return;
  }
  const body = { name };
  if (type === 'stdio') {
    if (!command) {
      state.formError = 'command is required for stdio transport';
      syncFormVisibility(form);
      return;
    }
    body.command = command;
    const args = argsRaw.split('\n').map(s => s.trim()).filter(Boolean);
    if (args.length) body.args = args;
    const env = {};
    for (const line of envRaw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const i = t.indexOf('=');
      if (i <= 0) continue;
      env[t.slice(0, i)] = t.slice(i + 1);
    }
    if (Object.keys(env).length) body.env = env;
  } else {
    if (!url) {
      state.formError = `url is required for ${type} transport`;
      syncFormVisibility(form);
      return;
    }
    body.url = url;
    body.type = type;
  }

  state.formBusy = true;
  state.formError = null;
  syncFormVisibility(form);

  try {
    const resp = await api.mcp.add(body);
    if (Array.isArray(resp?.servers)) state.servers = resp.servers;
    form.reset();
    state.formType = 'stdio';
    renderList();
  } catch (err) {
    state.formError = err?.message || String(err);
  } finally {
    state.formBusy = false;
    syncFormVisibility(form);
  }
}

async function removeServer(name) {
  if (!confirm(`Remove MCP server "${name}"?`)) return;
  const cs = ensureCardState(name);
  cs.removing = true;
  renderList();
  try {
    const resp = await api.mcp.remove(name);
    if (Array.isArray(resp?.servers)) state.servers = resp.servers;
  } catch (err) {
    cs.doctorError = `remove failed: ${err?.message || String(err)}`;
  } finally {
    cs.removing = false;
    renderList();
  }
}

async function runDoctorOne(name) {
  const cs = ensureCardState(name);
  cs.doctorBusy = true;
  cs.doctorError = null;
  cs.doctorResult = null;
  renderList();
  try {
    const resp = await api.mcp.doctor(name);
    cs.doctorResult = resp?.result ?? resp;
  } catch (err) {
    cs.doctorError = err?.message || String(err);
  } finally {
    cs.doctorBusy = false;
    renderList();
  }
}

async function runDoctorAll() {
  state.doctorAllBusy = true;
  state.doctorAllError = null;
  state.doctorAllResult = null;
  renderDoctorAll();
  try {
    const resp = await api.mcp.doctor();
    state.doctorAllResult = resp?.result ?? resp;
  } catch (err) {
    state.doctorAllError = err?.message || String(err);
  } finally {
    state.doctorAllBusy = false;
    renderDoctorAll();
  }
}

function renderDoctorAll() {
  if (!activeContainer) return;
  const slot = activeContainer.querySelector('[data-slot="doctor-all"]');
  if (!slot) return;
  slot.replaceChildren();
  const btn = activeContainer.querySelector('[data-act="doctor-all"]');
  if (btn) {
    btn.disabled = state.doctorAllBusy;
    btn.textContent = state.doctorAllBusy ? 'checking...' : 'doctor all';
  }
  if (!state.doctorAllResult && !state.doctorAllError && !state.doctorAllBusy) {
    slot.hidden = true;
    return;
  }
  slot.hidden = false;
  if (state.doctorAllBusy) {
    const p = document.createElement('p');
    p.className = 'mcp-empty';
    p.textContent = 'running doctor on all servers...';
    slot.appendChild(p);
    return;
  }
  const out = document.createElement('pre');
  out.className = 'mcp-card-output';
  if (state.doctorAllError) {
    out.classList.add('mcp-card-output--err');
    out.textContent = state.doctorAllError;
  } else {
    out.textContent = formatJson(state.doctorAllResult);
  }
  slot.appendChild(out);
}
