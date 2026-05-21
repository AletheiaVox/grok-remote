// Changelog modal.

import { el } from '../lib/render.js';
import { iconHtml } from '../lib/icons.js';
import { api } from '../lib/api.js';

interface ReleaseSummary {
  tag?: string;
  name?: string;
  url?: string;
  body?: string;
  publishedAt?: string;
  draft?: boolean;
  prerelease?: boolean;
}

interface ReleasesResult {
  ok: boolean;
  repo?: string;
  releases?: ReleaseSummary[];
  error?: string;
  detail?: string;
}

interface ActiveModal {
  overlay: HTMLElement;
  body:    HTMLElement;
  meta:    HTMLElement;
}

let activeModal: ActiveModal | null = null;

export interface ChangelogOptions {
  currentVersion?: string;
}

export function openChangelogModal({ currentVersion = '' }: ChangelogOptions = {}): ActiveModal | undefined {
  if (activeModal) return activeModal;

  const overlay = el('div', {
    class: 'changelog-modal',
    role: 'dialog',
    'aria-label': 'changelog',
    onclick: (ev: MouseEvent) => { if (ev.target === overlay) close(); },
  }) as HTMLElement;

  const closeBtn = el('button', {
    type: 'button',
    class: 'changelog-modal__close',
    title: 'close',
    'aria-label': 'close',
    onclick: () => close(),
    innerHTML: iconHtml('x-circle'),
  });

  const refreshBtn = el('button', {
    type: 'button',
    class: 'changelog-modal__refresh',
    title: 'refresh from github',
    'aria-label': 'refresh',
    onclick: () => loadReleases({ force: true }),
    innerHTML: iconHtml('refresh-cw'),
  });

  const body = el('div', { class: 'changelog-modal__body' }) as HTMLElement;
  const meta = el('div', { class: 'changelog-modal__meta' }) as HTMLElement;

  const card = el('div', { class: 'changelog-modal__card', role: 'document' },
    el('header', { class: 'changelog-modal__head' },
      el('div', { class: 'changelog-modal__title' },
        el('span', { class: 'changelog-modal__title-text' }, 'Changelog'),
        currentVersion
          ? el('span', { class: 'changelog-modal__current' }, `running v${currentVersion}`)
          : null,
      ),
      el('div', { class: 'changelog-modal__head-actions' },
        refreshBtn,
        closeBtn,
      ),
    ),
    body,
    meta,
  );

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);
  activeModal = { overlay, body, meta };

  void loadReleases();
  return activeModal;

  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') close();
  }
  function close(): void {
    if (!activeModal) return;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    activeModal = null;
  }

  async function loadReleases({ force = false }: { force?: boolean } = {}): Promise<void> {
    body.replaceChildren(loadingRow());
    meta.replaceChildren();
    try {
      const data = await api.version.releases({ force }) as ReleasesResult;
      renderResult(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      renderError(msg);
    }
  }

  function renderResult(data: ReleasesResult | null | undefined): void {
    if (!data || !data.ok) {
      const reason = data && (data.error || data.detail) || 'unknown error';
      renderError(`could not load releases: ${reason}`);
      return;
    }
    const list = Array.isArray(data.releases) ? data.releases : [];
    if (!list.length) {
      body.replaceChildren(el('div', { class: 'changelog-modal__empty' },
        el('div', { class: 'changelog-modal__empty-headline' }, 'no releases yet'),
        el('div', { class: 'changelog-modal__empty-sub' },
          'releases are tagged automatically by the release workflow on every push to main.'),
      ));
      return;
    }
    body.replaceChildren(...list.map((r, idx) => releaseRow(r, idx === 0)));

    meta.replaceChildren(
      el('span', { class: 'changelog-modal__meta-text' },
        `${list.length} release${list.length === 1 ? '' : 's'} · cached up to 5 min · `),
      el('a', {
        class: 'changelog-modal__meta-link',
        href: `https://github.com/${data.repo}/releases`,
        target: '_blank',
        rel: 'noreferrer noopener',
      }, 'view on GitHub'),
    );
  }

  function renderError(message: string): void {
    body.replaceChildren(el('div', { class: 'changelog-modal__error' },
      el('div', { class: 'changelog-modal__error-headline' }, 'changelog unavailable'),
      el('div', { class: 'changelog-modal__error-sub' }, message),
      el('button', {
        type: 'button',
        class: 'btn changelog-modal__retry',
        onclick: () => loadReleases({ force: true }),
      }, 'retry'),
    ));
  }
}

function loadingRow(): HTMLElement {
  return el('div', { class: 'changelog-modal__loading' }, 'loading releases...') as HTMLElement;
}

function releaseRow(r: ReleaseSummary, isLatest: boolean): HTMLElement {
  const date = r.publishedAt ? new Date(r.publishedAt) : null;
  const dateStr = date && !isNaN(date.getTime()) ? formatDate(date) : '';
  const tags: string[] = [];
  if (isLatest) tags.push('latest');
  if (r.prerelease) tags.push('prerelease');
  if (r.draft) tags.push('draft');

  return el('article', { class: 'changelog-release' },
    el('header', { class: 'changelog-release__head' },
      el('a', {
        class: 'changelog-release__tag',
        href: r.url,
        target: '_blank',
        rel: 'noreferrer noopener',
      }, r.tag || r.name || '(untagged)'),
      tags.length
        ? el('span', { class: 'changelog-release__tags' },
            ...tags.map((t) => el('span', {
              class: `changelog-release__chip changelog-release__chip--${t}`,
            }, t)))
        : null,
      dateStr
        ? el('span', { class: 'changelog-release__date' }, dateStr)
        : null,
    ),
    r.body
      ? renderBody(r.body)
      : el('div', { class: 'changelog-release__empty' }, 'no notes for this release.'),
  ) as HTMLElement;
}

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function renderBody(text: string): HTMLElement {
  const wrap = el('div', { class: 'changelog-release__body' }) as HTMLElement;
  const lines = String(text).split(/\r?\n/);
  let listBuf: HTMLElement | null = null;
  let paraBuf: string[] = [];

  const flushPara = (): void => {
    if (paraBuf.length) {
      const p = el('p', { class: 'changelog-release__p' }) as HTMLElement;
      p.innerHTML = inlineFmt(paraBuf.join(' '));
      wrap.appendChild(p);
      paraBuf = [];
    }
  };
  const flushList = (): void => {
    if (listBuf) {
      wrap.appendChild(listBuf);
      listBuf = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min((heading[1] || '').length, 4);
      const h = el(`h${level + 2}`, { class: 'changelog-release__h' }) as HTMLElement;
      h.innerHTML = inlineFmt(heading[2] || '');
      wrap.appendChild(h);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushPara();
      if (!listBuf) listBuf = el('ul', { class: 'changelog-release__list' }) as HTMLElement;
      const li = el('li', { class: 'changelog-release__li' }) as HTMLElement;
      li.innerHTML = inlineFmt(bullet[1] || '');
      listBuf.appendChild(li);
      continue;
    }
    flushList();
    paraBuf.push(line);
  }
  flushPara();
  flushList();
  return wrap;
}

function inlineFmt(s: string): string {
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, '<code class="changelog-release__code">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a class="changelog-release__link" href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
  );
  out = out.replace(
    /(?<!["=>])(https?:\/\/[^\s<]+)/g,
    '<a class="changelog-release__link" href="$1" target="_blank" rel="noreferrer noopener">$1</a>',
  );
  return out;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
