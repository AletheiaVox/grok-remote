// grok-remote dashboard entry point.
//
// Boot sequence:
//   1. mount the dashboard shell (topbar, sidebar, main pane) immediately.
//   2. dispatch between "chat" (per-agent) and "settings" views via a tiny router.
//
// The hole-to-GR animation no longer plays on page load. It now lives in
// the chat view and plays inside the chat-stream when a fresh conversation
// is opened (turns.length === 0). The topbar keeps a static GR mark.

import Split from 'split.js';
import { api } from './lib/api';
import { AgentsSidebar } from './views/agents.js';
import { ChatView } from './views/chat.js';
import { SettingsView } from './views/settings.js';
import { el } from './lib/render.js';
import { registerPwa } from './lib/pwa';
import { applyTheme, getTheme, nextTheme, getThemeMeta } from './lib/themes';
import { installVersionFooter } from './lib/version-footer';
import { SYSTEM_PAGES, getSystemPage, getSettingsPage } from './views/system/index.js';
import { iconHtml } from './lib/icons';

// Apply persisted theme as early as possible (before any DOM is drawn) so the
// dashboard never flashes the default palette.
applyTheme(getTheme());

function syncThemeToggle(name) {
  const meta = getThemeMeta(name);
  const dot   = document.getElementById('theme-toggle-dot');
  const label = document.getElementById('theme-toggle-label');
  const btn   = document.getElementById('theme-toggle');
  if (dot)   dot.style.background = meta.accent;
  if (label) label.textContent = meta.label;
  if (btn)   btn.title = `theme: ${meta.label} (click to cycle)`;
}

// React to setTheme calls from elsewhere (e.g. Settings picker).
window.addEventListener('storage', (ev) => {
  if (ev.key === 'grok-remote.theme') {
    applyTheme(getTheme());
    syncThemeToggle(getTheme());
  }
});
window.addEventListener('grok-remote:theme-change', () => {
  syncThemeToggle(getTheme());
});

// ── status header ──────────────────────────────────────────────────────

function setStatus(kind, text) {
  const pill = document.getElementById('status-pill');
  const txt  = document.getElementById('status-text');
  if (!pill || !txt) return;
  pill.className = 'status-pill';
  pill.classList.add(`status-pill--${kind}`);
  pill.textContent = kind === 'ok' ? '●' : (kind === 'fail' ? '×' : (kind === 'warn' ? '!' : '·'));
  txt.textContent = text;
}

async function pingHello() {
  try {
    const data = await api.hello();
    const ts = data && data.tailscale;
    if (ts && ts.backend === 'Running') setStatus('ok', 'tailnet up');
    else if (ts) setStatus('warn', `tailscale: ${ts.backend || 'unknown'}`);
    else setStatus('warn', 'no tailscale identity');
  } catch {
    setStatus('fail', 'api unreachable');
  }
}

// ── router ─────────────────────────────────────────────────────────────

// Top-level "areas" outside the conversation flow. Each key matches the
// first hash segment and a system view module under src/views/system/.
// SYSTEM_AREAS are top-level nav items rendered on the left rail.
const SYSTEM_AREAS = new Set(SYSTEM_PAGES.map((p) => p.area));

// SETTINGS_AREAS are the sub-pages under #/settings/<area>. They also
// double as legacy redirect targets: visiting an old #/<area> URL gets
// rewritten to #/settings/<area>.
const SETTINGS_AREAS = new Set([
  'general',
  'skills', 'subagents', 'hooks', 'plugins', 'marketplaces',
  'mcp', 'lsp', 'models', 'worktrees', 'import', 'setup',
]);

function parseRoute() {
  const h = (location.hash || '#/').replace(/^#/, '');
  const parts = h.split('/').filter(Boolean);
  if (!parts.length) return { name: 'home' };
  if (parts[0] === 'agents' && parts[1]) return { name: 'chat', agentId: parts[1] };
  if (parts[0] === 'settings') {
    return { name: 'settings', sub: parts[1] || 'general' };
  }
  if (SYSTEM_AREAS.has(parts[0])) return { name: 'system', area: parts[0], parts };
  // Legacy / external links: an old #/<area> URL that's now a settings
  // sub-page gets rewritten in-place. The hashchange listener will fire
  // again on the new URL and route properly.
  if (SETTINGS_AREAS.has(parts[0])) {
    return { name: 'redirect', to: `#/settings/${parts[0]}` };
  }
  return { name: 'home' };
}

function navigate(hash) {
  if (location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = hash;
  }
}

// ── drawer (mobile sidebar) ────────────────────────────────────────────

function openDrawer() {
  document.body.setAttribute('data-drawer-open', '');
  const btn = document.getElementById('hamburger-btn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  const bd = document.getElementById('drawer-backdrop');
  if (bd) bd.hidden = false;
}
function closeDrawer() {
  document.body.removeAttribute('data-drawer-open');
  const btn = document.getElementById('hamburger-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  const bd = document.getElementById('drawer-backdrop');
  if (bd) bd.hidden = true;
}
function toggleDrawer() {
  if (document.body.hasAttribute('data-drawer-open')) closeDrawer();
  else openDrawer();
}

// ── dashboard mount ────────────────────────────────────────────────────

function makeRailIcon({ href, title, area, iconName, label }) {
  // Build the icon element via innerHTML since iconHtml() returns a full
  // <svg> string. el() doesn't accept raw HTML by default, so we wrap it
  // in a span and assign innerHTML once.
  const a = el('a', {
    class: 'left-rail-item',
    href,
    title,
    'aria-label': title,
    'data-area': area,
  });
  const icon = document.createElement('span');
  icon.className = 'left-rail-icon';
  icon.innerHTML = iconHtml(iconName);
  a.appendChild(icon);
  const lbl = el('span', { class: 'left-rail-label' }, label || title);
  a.appendChild(lbl);
  return a;
}

function buildLeftRail() {
  const rail = el('nav', { class: 'left-rail', 'aria-label': 'top-level navigation' });
  rail.appendChild(makeRailIcon({
    href: '#/', title: 'conversations', area: 'home', iconName: 'home', label: 'chats',
  }));
  for (const p of SYSTEM_PAGES) {
    rail.appendChild(makeRailIcon({
      href: `#/${p.area}`, title: p.label, area: p.area, iconName: p.iconName, label: p.label,
    }));
  }
  return rail;
}

function updateRailHighlight(route) {
  const rail = document.querySelector('.left-rail');
  if (!rail) return;
  let activeArea = 'home';
  if (route.name === 'chat') activeArea = 'home';
  else if (route.name === 'system') activeArea = route.area;
  for (const item of rail.querySelectorAll('.left-rail-item')) {
    item.classList.toggle('left-rail-item--active', item.dataset.area === activeArea);
  }
}

function mountDashboard() {
  const host = document.getElementById('app');
  if (!host) return;
  host.replaceChildren();

  let currentAgent = null;
  let activeSystemPage = null; // { area, module }
  const chat     = new ChatView();
  const settings = new SettingsView();
  const sidebar  = new AgentsSidebar({
    onSelect: (id) => {
      chat.focusConversation();
      navigate(`#/agents/${encodeURIComponent(id)}`);
    },
    onCreate: () => { chat.focusConversation(); },
    onDelete: (id) => {
      if (currentAgent && currentAgent.id === id) {
        currentAgent = null;
        navigate('#/');
      }
    },
  });

  const mainHost = el('div', { class: 'main-pane' });
  const railHost = buildLeftRail();
  const shell = el('div', { class: 'dashboard dashboard--with-rail' });
  host.appendChild(shell);
  shell.appendChild(railHost);

  // Split host: holds the two Split.js panes (sidebar + main). The rail
  // sits OUTSIDE this container so Split.js never sees it. On mobile,
  // .sidebar-pane is collapsed to display: contents and the sidebar
  // becomes an off-canvas drawer (see CSS).
  const splitHost   = el('div', { class: 'split-host' });
  const sidebarPane = el('div', { class: 'sidebar-pane' });
  const mainPane    = el('div', { class: 'main-pane-wrap' });
  sidebar.mount(sidebarPane);
  mainPane.appendChild(mainHost);
  splitHost.appendChild(sidebarPane);
  splitHost.appendChild(mainPane);
  shell.appendChild(splitHost);

  installOuterSplit(splitHost, sidebarPane, mainPane);
  installToolsToggle();

  // hook up settings button in topbar
  const settingsBtn = document.getElementById('open-settings');
  if (settingsBtn) {
    settingsBtn.innerHTML = iconHtml('settings');
    settingsBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      navigate('#/settings');
      closeDrawer();
    });
  }
  const brandLink = document.getElementById('brand-link');
  if (brandLink) {
    brandLink.addEventListener('click', (ev) => {
      ev.preventDefault();
      navigate('#/');
      closeDrawer();
    });
  }

  // "Any agent active" indicator on the brand + document title prefix.
  // Listens to the same agents-refresh event the sidebar dispatches and
  // shows a pulsing amber dot whenever at least one agent has inFlight > 0
  // or is running. The title prefix surfaces activity in browser tabs and
  // the dock when the dashboard is fully out of view.
  // Stamp the brand-version span from the package.json version baked in by
  // Vite at build time. Falls back to the hardcoded HTML value if for some
  // reason the define didn't fire.
  const brandVersion = document.getElementById('brand-version');
  if (brandVersion && typeof __APP_VERSION__ === 'string' && __APP_VERSION__) {
    brandVersion.textContent = 'v' + __APP_VERSION__;
    brandVersion.title = `grok-remote v${__APP_VERSION__}`;
  }

  const brandActive = document.getElementById('brand-active');
  const baseTitle = document.title;
  document.addEventListener('grok-remote:agents-refresh', (ev) => {
    const list = (ev && ev.detail) || [];
    const active = list.some((a) =>
      (typeof a?.inFlight === 'number' && a.inFlight > 0) ||
      (a?.status === 'running')
    );
    if (brandActive) brandActive.hidden = !active;
    const wantTitle = active ? `(*) ${baseTitle}` : baseTitle;
    if (document.title !== wantTitle) document.title = wantTitle;
  });

  // ── Global background-process tracker ────────────────────────────────
  // Polls every 3s for every running terminal across every agent so the
  // user can see persistent bg work (e.g. `npm run dev`) from any page
  // and from any device. Survives page reload (server-side state).
  installBgTracker();

  // close drawer when a sidebar agent is picked on narrow screens.
  shell.addEventListener('click', (ev) => {
    if (!document.body.hasAttribute('data-drawer-open')) return;
    const target = ev.target;
    if (target && target.closest && target.closest('.sidebar .agent-item')) {
      closeDrawer();
    }
  });

  let activeSettings = false;

  function unmountActiveSystemPage() {
    if (!activeSystemPage) return;
    try { activeSystemPage.module.unmount?.(); } catch { /* ignore */ }
    activeSystemPage = null;
  }
  function unmountActiveSettings() {
    if (!activeSettings) return;
    try { settings.unmount(); } catch { /* ignore */ }
    activeSettings = false;
  }

  function renderRoute() {
    const route = parseRoute();
    if (route.name === 'redirect') {
      // Replace, not assign, so the bad URL doesn't pollute history.
      location.replace(location.pathname + location.search + route.to);
      return;
    }
    // Same-area shortcut: navigating within #/settings/* swaps the
    // sub-page without remounting the shell.
    if (route.name === 'settings' && activeSettings) {
      updateRailHighlight(route);
      settings.setActive(route.sub);
      return;
    }
    // Unmount the previous system page FIRST so its teardown (e.g.
    // ReactFlow's root.unmount) runs against the DOM it still owns. Wiping
    // mainHost first triggers React's "node to be removed is not a child"
    // NotFoundError because the nodes are already gone by the time React
    // tries to reconcile.
    unmountActiveSystemPage();
    unmountActiveSettings();
    mainHost.replaceChildren();
    updateRailHighlight(route);
    if (route.name === 'system') {
      const page = getSystemPage(route.area);
      if (page && page.module && typeof page.module.mount === 'function') {
        page.module.mount(mainHost, route);
        activeSystemPage = page;
        return;
      }
      // Unknown system area: fall through to home.
    }
    if (route.name === 'settings') {
      settings.mount(mainHost);
      settings.setActive(route.sub);
      activeSettings = true;
      return;
    }
    if (route.name === 'chat') {
      chat.mount(mainHost);
      // try to find the agent in sidebar list, otherwise fetch
      const found = sidebar.agents.find(a => a.id === route.agentId);
      if (found) {
        currentAgent = found;
        sidebar.selectedId = found.id;
        sidebar.renderList();
        chat.setAgent(found);
      } else {
        // fetch single
        api.getAgent(route.agentId).then((a) => {
          currentAgent = a || { id: route.agentId };
          sidebar.selectedId = currentAgent.id;
          sidebar.renderList();
          chat.setAgent(currentAgent);
        }).catch(() => {
          currentAgent = { id: route.agentId };
          chat.setAgent(currentAgent);
        });
      }
      return;
    }
    // home / empty
    chat.mount(mainHost);
    chat.setAgent(null);
  }

  window.addEventListener('hashchange', renderRoute);
  renderRoute();
}

// ── boot ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Kick off api ping immediately.
  pingHello();
  setInterval(pingHello, 10000);

  mountDashboard();

  // wire the topbar theme toggle.
  syncThemeToggle(getTheme());
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      const n = nextTheme(getTheme());
      syncThemeToggle(n);
      window.dispatchEvent(new CustomEvent('grok-remote:theme-change', { detail: { theme: n } }));
    });
  }

  // wire mobile drawer affordances.
  const ham = document.getElementById('hamburger-btn');
  if (ham) {
    ham.addEventListener('click', (ev) => {
      ev.preventDefault();
      toggleDrawer();
    });
  }
  const backdrop = document.getElementById('drawer-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', () => closeDrawer());
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && document.body.hasAttribute('data-drawer-open')) {
      closeDrawer();
    }
  });
  // Sidebar's internal close button (× at the top of the drawer on mobile)
  // dispatches this event so it works regardless of when the sidebar is
  // mounted / re-rendered.
  document.addEventListener('grok-remote:close-drawer', () => closeDrawer());

  // wire PWA install banner + service worker.
  registerPwa();

  // install the bottom-of-app version footer. Lives as a sibling of #app so
  // it spans the full viewport width on desktop and mobile.
  installVersionFooter();
});

// ── Outer split (sidebar vs main) via Split.js ───────────────────────────
//
// Two persistent bits of state:
//   grok-remote.split.sidebar           [number, number] sizes in %
//   grok-remote.split.sidebar.collapsed '1' | '0' (or missing)
//
// On mobile (<= MOBILE_MAX) Split.js does NOT initialize at all. The
// sidebar reverts to its CSS off-canvas drawer behavior (driven by
// body[data-drawer-open]). A viewport-cross resize triggers location.reload()
// so we never have to juggle two layout modes at runtime.
const SIDEBAR_SIZES_KEY = 'grok-remote.split.sidebar';
const SIDEBAR_COLLAPSED_KEY = 'grok-remote.split.sidebar.collapsed';
const SIDEBAR_DEFAULT_SIZES = [22, 78];
const MOBILE_MAX = 720;

function isMobileViewport() {
  return window.innerWidth <= MOBILE_MAX;
}

function readSidebarSizes() {
  try {
    const raw = localStorage.getItem(SIDEBAR_SIZES_KEY);
    if (!raw) return SIDEBAR_DEFAULT_SIZES.slice();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === 2 &&
        parsed.every((n) => typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100)) {
      return parsed;
    }
  } catch { /* ignore */ }
  return SIDEBAR_DEFAULT_SIZES.slice();
}

function isSidebarCollapsed() {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch { return false; }
}

function installToolsToggle() {
  const btn = document.getElementById('topbar-sidebar-right');
  if (!btn) return;
  if (isMobileViewport()) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  let collapsed = false;
  function paint() {
    btn.innerHTML = iconHtml(collapsed ? 'panel-right-open' : 'panel-right-close');
    btn.title = collapsed ? 'show tool calls panel' : 'hide tool calls panel';
    btn.setAttribute('aria-label', btn.title);
  }
  paint();
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    document.dispatchEvent(new CustomEvent('grok-remote:tools-toggle'));
  });
  document.addEventListener('grok-remote:tools-state', (ev) => {
    collapsed = !!(ev && ev.detail && ev.detail.collapsed);
    paint();
  });
}

function installOuterSplit(splitHost, sidebarPane, mainPane) {
  const topbarBtn = document.getElementById('topbar-sidebar-left');

  // Mobile: skip Split.js entirely. The sidebar drawer is driven by CSS +
  // body[data-drawer-open]. Reload on threshold cross to re-init cleanly.
  if (isMobileViewport()) {
    if (topbarBtn) topbarBtn.hidden = true;
    let wasMobile = true;
    window.addEventListener('resize', () => {
      const nowMobile = isMobileViewport();
      if (wasMobile !== nowMobile) {
        wasMobile = nowMobile;
        location.reload();
      }
    });
    return;
  }

  if (topbarBtn) topbarBtn.hidden = false;

  let collapsed = isSidebarCollapsed();
  let lastExpandedSizes = readSidebarSizes();
  let split = null;

  function persistSizes(sizes) {
    try { localStorage.setItem(SIDEBAR_SIZES_KEY, JSON.stringify(sizes)); } catch { /* ignore */ }
  }
  function persistCollapsed(v) {
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  }

  function updateTopbarBtn() {
    if (!topbarBtn) return;
    topbarBtn.innerHTML = iconHtml(collapsed ? 'panel-left-open' : 'panel-left-close');
    topbarBtn.title = collapsed ? 'show conversations sidebar' : 'hide conversations sidebar';
    topbarBtn.setAttribute('aria-label', collapsed ? 'show conversations sidebar' : 'hide conversations sidebar');
  }

  function buildSplit(initialSizes) {
    split = Split([sidebarPane, mainPane], {
      sizes: initialSizes,
      minSize: [220, 480],
      maxSize: [560, Infinity],
      gutterSize: 6,
      snapOffset: 0,
      expandToMin: true,
      direction: 'horizontal',
      elementStyle: (dim, size, gutterSize) => ({
        'flex-basis': `calc(${size}% - ${gutterSize}px)`,
      }),
      gutterStyle: (dim, gutterSize) => ({ 'flex-basis': `${gutterSize}px` }),
      onDragEnd: (sizes) => {
        lastExpandedSizes = sizes;
        persistSizes(sizes);
      },
    });
  }

  function destroySplit() {
    if (split) {
      // Pass no args so Split.js removes its inline flex-basis from both
      // panes (and removes the gutter). Otherwise the inline style locks
      // .main-pane-wrap to ~78% width even after the sidebar collapses,
      // which is exactly the bug that left the chat content blank.
      try { split.destroy(); } catch { /* ignore */ }
      split = null;
    }
  }

  function applyCollapsedState() {
    splitHost.classList.toggle('sidebar-collapsed', collapsed);
    if (collapsed) {
      destroySplit();
    } else if (!split) {
      buildSplit(lastExpandedSizes);
    }
    updateTopbarBtn();
  }

  function setCollapsed(next) {
    if (collapsed === next) return;
    collapsed = next;
    persistCollapsed(collapsed);
    applyCollapsedState();
  }

  // Initial mount.
  if (collapsed) {
    splitHost.classList.add('sidebar-collapsed');
  } else {
    buildSplit(lastExpandedSizes);
  }
  updateTopbarBtn();

  // Topbar button + same legacy event listener for any other dispatchers.
  if (topbarBtn) {
    topbarBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      setCollapsed(!collapsed);
    });
  }
  document.addEventListener('grok-remote:sidebar-toggle', () => setCollapsed(!collapsed));

  // Reload when crossing the mobile threshold so we don't have to juggle
  // both layouts at runtime.
  let wasMobile = false;
  window.addEventListener('resize', () => {
    const nowMobile = isMobileViewport();
    if (wasMobile !== nowMobile) {
      wasMobile = nowMobile;
      location.reload();
    }
  });
}

// ── Background-process tracker (persistent across pages + reloads) ──────
// Polls /api/system/bg-terminals every 3s while the tab is visible. Shows
// "bg: N" in the topbar when at least one terminal is running, and opens
// a global viewer on click. Server-side state survives client reloads.
function installBgTracker() {
  const btn   = document.getElementById('topbar-bg');
  const count = btn ? btn.querySelector('.topbar-bg__count') : null;
  if (!btn || !count) return;

  let lastSnapshot = null;

  async function tick() {
    if (document.hidden) return;
    try {
      const data = await api.terminals.global();
      lastSnapshot = data;
      const n = (data && data.runningCount) || 0;
      const totalEntries = (data && Array.isArray(data.agents))
        ? data.agents.reduce((a, g) => a + (g.terminals?.length || 0), 0)
        : 0;
      btn.hidden = totalEntries === 0;
      count.textContent = `bg: ${n}`;
      btn.classList.toggle('topbar-bg--active', n > 0);
      btn.classList.toggle('topbar-bg--exited-only', n === 0 && totalEntries > 0);
    } catch {
      // server may not implement the route yet; hide.
      btn.hidden = true;
    }
  }
  btn.addEventListener('click', () => openBgViewer(() => lastSnapshot));
  tick();
  setInterval(tick, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

function openBgViewer(getSnapshot) {
  // Reuse fresh data and re-fetch every 1s while the modal is open.
  const overlay = el('div', { class: 'bgglobal-viewer' });
  const closeBtn = el('button', {
    type: 'button', class: 'bgglobal-viewer__close',
    onclick: () => overlay.remove(),
  }, '×');
  const title = el('div', { class: 'bgglobal-viewer__title' }, 'background processes');
  const body  = el('div', { class: 'bgglobal-viewer__body' });
  overlay.appendChild(el('div', { class: 'bgglobal-viewer__head' }, title, closeBtn));
  overlay.appendChild(body);
  document.body.appendChild(overlay);

  async function render() {
    if (!overlay.isConnected) return;
    let data = getSnapshot && getSnapshot();
    try { data = await api.terminals.global(); } catch { /* keep stale */ }
    body.replaceChildren();
    const groups = (data && Array.isArray(data.agents)) ? data.agents : [];
    if (!groups.length) {
      body.appendChild(el('div', { class: 'bgglobal-viewer__empty' },
        'no background processes are running.'));
      return;
    }
    for (const g of groups) {
      const groupEl = el('div', { class: 'bgglobal-viewer__group' });
      groupEl.appendChild(el('div', { class: 'bgglobal-viewer__group-head' },
        el('span', { class: 'bgglobal-viewer__agent-name' }, g.agentName || g.agentId),
        el('button', {
          type: 'button',
          class: 'bgglobal-viewer__open-conv',
          onclick: () => {
            overlay.remove();
            navigate(`#/agents/${encodeURIComponent(g.agentId)}`);
          },
        }, 'open conversation'),
      ));
      for (const t of (g.terminals || [])) {
        const exited = !!t.exited;
        const code = t.exitStatus && (t.exitStatus.exitCode ?? t.exitStatus.signal);
        const row = el('div', { class: `bgglobal-viewer__term ${exited ? 'bgglobal-viewer__term--exited' : ''}` },
          el('span', { class: 'bgglobal-viewer__term-status' },
            el('span', { class: 'bgglobal-viewer__term-dot' }),
            exited ? `exit ${code ?? '?'}` : 'running'),
          el('div', { class: 'bgglobal-viewer__term-cmd' }, t.command || ''),
          el('div', { class: 'bgglobal-viewer__term-cwd' }, t.cwd || ''),
          el('div', { class: 'bgglobal-viewer__term-actions' },
            (t.url && !exited) && el('a', {
              class: 'bgglobal-viewer__open-url',
              href: t.url,
              target: '_blank',
              rel: 'noopener',
              title: `open ${t.url}`,
              html: `<span class="bgglobal-viewer__open-url-ico">${iconHtml('globe')}</span><span class="bgglobal-viewer__open-url-label">Open App</span>`,
            }),
            el('button', {
              type: 'button', class: 'bgglobal-viewer__open-output',
              onclick: () => {
                // Hand off to the chat view's bg-term viewer by navigating
                // there with a query param the chat view can pick up. For
                // now: navigate to the conversation, the per-conversation
                // strip will be visible and the user can click the chip.
                overlay.remove();
                navigate(`#/agents/${encodeURIComponent(g.agentId)}`);
              },
            }, 'view in conversation'),
            !exited && el('button', {
              type: 'button', class: 'bgglobal-viewer__kill',
              onclick: async (ev) => {
                const btn = ev.currentTarget;
                btn.disabled = true;
                btn.textContent = 'killing...';
                row.classList.add('bgglobal-viewer__term--killing');
                try {
                  await api.terminals.kill(g.agentId, t.id);
                  btn.textContent = 'kill sent';
                  // Replace the status pill text so the user sees an
                  // immediate confirmation before the next poll arrives.
                  const stEl = row.querySelector('.bgglobal-viewer__term-status');
                  if (stEl) {
                    stEl.replaceChildren(
                      el('span', { class: 'bgglobal-viewer__term-dot' }),
                      document.createTextNode('killing'),
                    );
                  }
                } catch (err) {
                  btn.disabled = false;
                  btn.textContent = 'kill failed; retry';
                  btn.title = err.message;
                }
              },
            }, 'kill'),
          ),
        );
        groupEl.appendChild(row);
      }
      body.appendChild(groupEl);
    }
  }

  render();
  const timer = setInterval(() => {
    if (!overlay.isConnected) { clearInterval(timer); return; }
    render();
  }, 1500);
}
