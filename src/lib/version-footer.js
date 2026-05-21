// Bottom-of-app version footer.
//
// Shows the running version + short sha on the left, and an update
// indicator + "update now" button on the right. Polls /api/version/latest
// every 10 min to keep the indicator fresh.
//
// The footer lives as a sibling of #app inside <body> (added at boot from
// main.js). It is fixed-height; the dashboard above gets a matching
// padding-bottom (or height calc) so nothing is hidden behind it.

import { el } from './render.js';
import { iconHtml } from './icons';
import { api } from './api.js';
import { openUpdateModal } from '../views/update-modal.js';
import { openChangelogModal } from '../views/changelog-modal.js';

const POLL_MS = 10 * 60 * 1000;
const LAST_SEEN_VERSION_KEY = 'grok-remote.update.lastSeenVersion';

let footerEl = null;
let leftEl = null;
let rightEl = null;
let updateBtn = null;
let currentInfo = null;
let latestInfo = null;
let pollTimer = null;

export function installVersionFooter({ host } = {}) {
  if (footerEl) return footerEl;

  // The whole left cluster acts as a "open changelog" button. We use a
  // <button> so it gets keyboard focus + a proper click target; the inner
  // spans keep their existing classes so the existing styles still apply.
  leftEl = el('button', {
    type: 'button',
    class: 'app-footer__left app-footer__left--btn',
    title: 'view changelog',
    'aria-label': 'view changelog',
    onclick: () => {
      const version = (currentInfo && currentInfo.version) ||
        (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '');
      openChangelogModal({ currentVersion: version });
    },
  },
    el('span', { class: 'app-footer__brand' }, 'grok-remote'),
    el('span', { class: 'app-footer__version' }, 'v?'),
    el('span', { class: 'app-footer__sep' }, '·'),
    el('span', { class: 'app-footer__sha', title: 'git sha' }, '...'),
  );

  rightEl = el('div', { class: 'app-footer__right' });

  footerEl = el('footer', { class: 'app-footer', role: 'contentinfo' }, leftEl, rightEl);
  // Mount as a sibling of #app, just before .bottombar so the small
  // disclaimer line keeps its place at the very bottom. Falls back to
  // appendChild on <body> when .bottombar is missing.
  const parent = host || document.body;
  const bottombar = parent.querySelector ? parent.querySelector('.bottombar') : null;
  if (bottombar && bottombar.parentNode === parent) {
    parent.insertBefore(footerEl, bottombar);
  } else {
    parent.appendChild(footerEl);
  }

  // Mark <body> so the rest of the layout can pad/shrink to make room.
  document.body.classList.add('has-app-footer');

  // Show any "you just updated" toast if main.js detected a bump.
  maybeShowJustUpdatedToast();

  // Kick off the polls.
  refreshCurrent();
  refreshLatest();
  pollTimer = setInterval(refreshLatest, POLL_MS);
  // Also re-poll when the user returns to the tab so they don't see stale
  // info after closing a laptop overnight.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshLatest();
  });

  return footerEl;
}

async function refreshCurrent() {
  try {
    const data = await api.version.current();
    currentInfo = data;
    paint();
  } catch {
    // Not fatal: leave defaults. The brand-version span is the source of
    // truth for the running version when the endpoint is unreachable.
  }
}

async function refreshLatest() {
  try {
    const data = await api.version.latest();
    if (data && data.ok) {
      latestInfo = data;
      paint();
    } else if (data) {
      latestInfo = { ok: false, error: data.error || 'fetch failed' };
      paint();
    }
  } catch (err) {
    latestInfo = { ok: false, error: err.message };
    paint();
  }
}

function paint() {
  if (!footerEl) return;
  const ver = (currentInfo && currentInfo.version) || (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '?');
  const sha = (currentInfo && currentInfo.gitShaShort) || '';
  const dirty = !!(currentInfo && currentInfo.gitDirty);

  leftEl.querySelector('.app-footer__version').textContent = `v${ver}`;
  const shaEl = leftEl.querySelector('.app-footer__sha');
  shaEl.textContent = sha ? `${sha}${dirty ? '*' : ''}` : '';
  shaEl.title = sha ? `${currentInfo.gitSha}${dirty ? ' (working tree dirty)' : ''}` : 'git sha';

  rightEl.replaceChildren();

  if (!latestInfo) {
    rightEl.appendChild(el('span', { class: 'app-footer__hint' }, 'checking for updates...'));
    return;
  }
  if (!latestInfo.ok) {
    rightEl.appendChild(el('span', {
      class: 'app-footer__hint app-footer__hint--warn',
      title: latestInfo.error || '',
    }, 'update check failed'));
    rightEl.appendChild(makeIconBtn('refresh-cw', 'retry', () => {
      latestInfo = null;
      paint();
      refreshLatest();
    }));
    return;
  }

  const behind = latestInfo.behind || 0;
  const ahead  = latestInfo.ahead  || 0;
  if (behind === 0 && ahead === 0) {
    rightEl.appendChild(el('span', { class: 'app-footer__hint app-footer__hint--ok' },
      el('span', { class: 'app-footer__hint-ico', html: iconHtml('check') }),
      el('span', { class: 'app-footer__hint-label' }, 'up to date'),
    ));
    return;
  }
  if (behind === 0 && ahead > 0) {
    // local is ahead of origin/main (likely dev work). Not an update target.
    rightEl.appendChild(el('span', { class: 'app-footer__hint' },
      `local is ${ahead} ahead of origin/main`));
    return;
  }
  // behind > 0: show update affordance.
  const txt = `${behind} commit${behind === 1 ? '' : 's'} behind`;
  rightEl.appendChild(el('span', { class: 'app-footer__hint app-footer__hint--avail' },
    el('span', { class: 'app-footer__hint-dot' }),
    el('span', { class: 'app-footer__hint-label' }, `update available · ${txt}`),
  ));
  updateBtn = el('button', {
    type: 'button',
    class: 'btn app-footer__update-btn',
    title: 'pull origin/main, build, and restart',
    onclick: () => {
      openUpdateModal({ current: currentInfo, latest: latestInfo });
    },
  },
    el('span', { class: 'app-footer__update-ico', html: iconHtml('refresh-cw') }),
    el('span', { class: 'app-footer__update-label' }, 'update now'),
  );
  rightEl.appendChild(updateBtn);
}

function makeIconBtn(name, title, onclick) {
  return el('button', {
    type: 'button',
    class: 'app-footer__icon-btn',
    title,
    'aria-label': title,
    onclick,
    html: iconHtml(name),
  });
}

function maybeShowJustUpdatedToast() {
  let justUpdated = null;
  try { justUpdated = localStorage.getItem('grok-remote.update.justUpdatedTo'); }
  catch { /* ignore */ }
  if (!justUpdated) return;
  try { localStorage.removeItem('grok-remote.update.justUpdatedTo'); }
  catch { /* ignore */ }

  let prev = null;
  try { prev = localStorage.getItem('grok-remote.update.beforeVersion'); }
  catch { /* ignore */ }
  try {
    localStorage.removeItem('grok-remote.update.beforeVersion');
    localStorage.removeItem('grok-remote.update.beforeSha');
  } catch { /* ignore */ }

  const text = prev && prev !== justUpdated
    ? `updated to v${justUpdated} (from v${prev})`
    : `updated to v${justUpdated}`;

  const toast = el('div', { class: 'app-footer-toast' }, text);
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('app-footer-toast--show'), 30);
  setTimeout(() => {
    toast.classList.remove('app-footer-toast--show');
    setTimeout(() => toast.remove(), 400);
  }, 5000);

  try { localStorage.setItem(LAST_SEEN_VERSION_KEY, justUpdated); }
  catch { /* ignore */ }
}
