// Bottom-of-app version footer.

import { el } from './render.js';
import { iconHtml } from './icons.js';
import { api } from './api.js';
import { openUpdateModal } from '../views/update-modal';
import { openChangelogModal } from '../views/changelog-modal';

const POLL_MS = 10 * 60 * 1000;
const LAST_SEEN_VERSION_KEY = 'grok-remote.update.lastSeenVersion';

declare const __APP_VERSION__: string;

interface CurrentInfo {
  version?: string;
  gitShaShort?: string;
  gitSha?: string;
  gitDirty?: boolean;
}

type LatestInfo =
  | { ok: true; ahead?: number; behind?: number; [k: string]: unknown }
  | { ok: false; error?: string };

let footerEl: HTMLElement | null = null;
let leftEl: HTMLButtonElement | null = null;
let centerEl: HTMLDivElement | null = null;
let rightEl: HTMLDivElement | null = null;
let updateBtn: HTMLButtonElement | null = null;
let currentInfo: CurrentInfo | null = null;
let latestInfo: LatestInfo | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

export interface InstallVersionFooterOptions {
  host?: HTMLElement;
}

export function installVersionFooter({ host }: InstallVersionFooterOptions = {}): HTMLElement {
  if (footerEl) return footerEl;

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
  ) as HTMLButtonElement;

  centerEl = el('div', { class: 'app-footer__center' },
    el('span', { class: 'app-footer__disclaimer' }, 'not affiliated with xAI, grok, or Tailscale'),
    el('span', { class: 'app-footer__sep' }, '·'),
    el('a', {
      class: 'app-footer__credit',
      href: 'https://x.com/daniel_farinax',
      target: '_blank',
      rel: 'noopener noreferrer',
    }, '@daniel_farinax'),
  ) as HTMLDivElement;

  rightEl = el('div', { class: 'app-footer__right' }) as HTMLDivElement;

  footerEl = el('footer', { class: 'app-footer', role: 'contentinfo' }, leftEl, centerEl, rightEl) as HTMLElement;
  const parent = host || document.body;
  parent.appendChild(footerEl);

  document.body.classList.add('has-app-footer');

  maybeShowJustUpdatedToast();

  void refreshCurrent();
  void refreshLatest();
  pollTimer = setInterval(refreshLatest, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshLatest();
  });

  return footerEl;
}

async function refreshCurrent(): Promise<void> {
  try {
    const data = await api.version.current() as CurrentInfo;
    currentInfo = data;
    paint();
  } catch {
    /* not fatal */
  }
}

async function refreshLatest(): Promise<void> {
  try {
    const data = await api.version.latest() as LatestInfo;
    if (data && data.ok) {
      latestInfo = data;
      paint();
    } else if (data) {
      latestInfo = { ok: false, error: (data as { error?: string }).error || 'fetch failed' };
      paint();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    latestInfo = { ok: false, error: msg };
    paint();
  }
}

function paint(): void {
  if (!footerEl || !leftEl || !rightEl) return;
  const ver = (currentInfo && currentInfo.version) || (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '?');
  const sha = (currentInfo && currentInfo.gitShaShort) || '';
  const dirty = !!(currentInfo && currentInfo.gitDirty);

  const verEl = leftEl.querySelector('.app-footer__version');
  if (verEl) verEl.textContent = `v${ver}`;
  const shaEl = leftEl.querySelector('.app-footer__sha') as HTMLElement | null;
  if (shaEl) {
    shaEl.textContent = sha ? `${sha}${dirty ? '*' : ''}` : '';
    shaEl.title = sha && currentInfo ? `${currentInfo.gitSha}${dirty ? ' (working tree dirty)' : ''}` : 'git sha';
  }

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
      void refreshLatest();
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
    rightEl.appendChild(el('span', { class: 'app-footer__hint' },
      `local is ${ahead} ahead of origin/main`));
    return;
  }
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
      // latestInfo is narrowed to the available-update branch upstream of
      // this click handler, but TS can't see it through the closure.
      openUpdateModal({ current: currentInfo, latest: latestInfo as unknown as { latestSha?: string; latestVersion?: string; behind?: number } | null });
    },
  },
    el('span', { class: 'app-footer__update-ico', html: iconHtml('refresh-cw') }),
    el('span', { class: 'app-footer__update-label' }, 'update now'),
  ) as HTMLButtonElement;
  rightEl.appendChild(updateBtn);
}

function makeIconBtn(name: string, title: string, onclick: () => void): HTMLButtonElement {
  return el('button', {
    type: 'button',
    class: 'app-footer__icon-btn',
    title,
    'aria-label': title,
    onclick,
    html: iconHtml(name),
  }) as HTMLButtonElement;
}

function maybeShowJustUpdatedToast(): void {
  let justUpdated: string | null = null;
  try { justUpdated = localStorage.getItem('grok-remote.update.justUpdatedTo'); }
  catch { /* ignore */ }
  if (!justUpdated) return;
  try { localStorage.removeItem('grok-remote.update.justUpdatedTo'); }
  catch { /* ignore */ }

  let prev: string | null = null;
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

// Avoid an unused-warning for pollTimer if strict tsconfig flips on later.
void pollTimer;
