// Models page. Lists what `grok models` knows about. Read-only.

import { api } from '../../lib/api';

let activeContainer = null;
let abortToken      = 0;

export function mount(container) {
  activeContainer = container;
  abortToken += 1;
  const myToken = abortToken;

  container.replaceChildren();
  container.innerHTML = `
    <section class="system-page models-page">
      <header class="system-page-header">
        <h2 class="system-page-title">Models</h2>
        <p class="system-page-sub">
          The model ids this grok build knows about for the active config.
          Pick one in conversation settings later. This list reflects
          <code>~/.grok/config.toml</code> plus whatever the active backend
          advertises; it is not a live xAI catalog.
        </p>
      </header>

      <div class="models-list" data-role="list">
        <p class="models-status">loading...</p>
      </div>

      <details class="models-raw">
        <summary>raw output</summary>
        <pre class="models-raw-body" data-role="raw"></pre>
      </details>

      <p class="models-error" data-role="error" hidden></p>
    </section>
  `;

  refresh(container, () => myToken === abortToken).catch(() => {});
}

export function unmount() {
  abortToken += 1;
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

async function refresh(root, alive) {
  const errEl = root.querySelector('[data-role="error"]');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  try {
    const data = await api.systemModels.get();
    if (!alive()) return;
    renderList(root, data);
    renderRaw(root, data);
  } catch (err) {
    if (!alive()) return;
    const list = root.querySelector('[data-role="list"]');
    if (list) list.replaceChildren();
    if (errEl) { errEl.hidden = false; errEl.textContent = err?.message || String(err); }
  }
}

function renderList(root, data) {
  const list = root.querySelector('[data-role="list"]');
  if (!list) return;
  list.replaceChildren();
  const items = (data && Array.isArray(data.items)) ? data.items : [];
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'models-status';
    p.textContent = 'no models parsed. check the raw output below.';
    list.appendChild(p);
    return;
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'models-row';
    const idEl = document.createElement('span');
    idEl.className = 'models-row-id';
    idEl.textContent = it.id || '';
    const nameEl = document.createElement('span');
    nameEl.className = 'models-row-name';
    nameEl.textContent = it.name || '';
    row.append(idEl, nameEl);
    list.appendChild(row);
  }
}

function renderRaw(root, data) {
  const pre = root.querySelector('[data-role="raw"]');
  if (!pre) return;
  pre.textContent = (data && typeof data.raw === 'string') ? data.raw : '';
}
