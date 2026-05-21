// Shared rendering primitives for the "native config" dashboard pages
// (hooks, agents, plugins, marketplaces, lsp). Each of those pages is
// essentially the same shape: a blurb at the top, optional toolbar, a
// list of items grouped by scope/source, and per-item click-to-expand
// raw JSON. Centralizing the helpers here keeps the per-page modules
// small and visually consistent with the health page.
//
// All helpers return plain DOM nodes. CSS classes reuse the existing
// `system-page-*` and `health-item-*` rules from src/style.css so we do
// not need new styling.

import { api } from '../../lib/api';

/**
 * Fetch the inspect payload via the shared system-health endpoint.
 * The endpoint returns { ok, inspect, ... }; on failure we surface the
 * inspectError string when present.
 *
 * @returns {Promise<{ inspect: object|null, error: string|null }>}
 */
export async function loadInspect() {
  try {
    const data = await api.systemHealth.get();
    if (!data || !data.ok) {
      return { inspect: null, error: (data && data.error) || 'unknown failure' };
    }
    if (data.inspectError) {
      return { inspect: null, error: String(data.inspectError) };
    }
    return { inspect: data.inspect || null, error: null };
  } catch (err) {
    return { inspect: null, error: err && err.message ? err.message : String(err) };
  }
}

/** Render the standard page chrome (title + blurb), returning the section element. */
// Append a config-file banner to an existing page section (call this after
// the inspect payload arrives so paths land directly from configSources).
export function addConfigFilesBanner(section, configFiles) {
  if (!section || !Array.isArray(configFiles) || !configFiles.length) return;
  const header = section.querySelector('.system-page-header');
  if (!header) return;
  // Remove any previously-rendered banner so re-renders don't stack.
  const prev = header.querySelector('.system-page-configfiles');
  if (prev) prev.remove();
  const banner = document.createElement('div');
  banner.className = 'system-page-configfiles';
  for (const cf of configFiles) {
    if (!cf || (!cf.path && !cf.label)) continue;
    const row = document.createElement('div');
    row.className = 'system-page-configfile';
    if (cf.label) {
      const lbl = document.createElement('span');
      lbl.className = 'system-page-configfile-label';
      lbl.textContent = cf.label;
      row.appendChild(lbl);
    }
    if (cf.path) {
      const code = document.createElement('code');
      code.className = 'health-path';
      code.textContent = cf.path;
      row.appendChild(code);
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'health-copy-btn';
      copyBtn.textContent = 'copy';
      copyBtn.title = 'copy path to clipboard';
      copyBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await navigator.clipboard.writeText(cf.path);
          copyBtn.textContent = 'copied';
          setTimeout(() => { copyBtn.textContent = 'copy'; }, 1200);
        } catch { /* ignore */ }
      });
      row.appendChild(copyBtn);
    }
    banner.appendChild(row);
  }
  header.appendChild(banner);
}

export function buildPageShell(container, { title, blurb, configFiles }) {
  container.replaceChildren();
  const section = document.createElement('section');
  section.className = 'system-page';
  const header = document.createElement('header');
  header.className = 'system-page-header';
  const h2 = document.createElement('h2');
  h2.className = 'system-page-title';
  h2.textContent = title;
  const p = document.createElement('p');
  p.className = 'system-page-sub';
  // blurb may include <code> tags; assign as innerHTML for the few we need.
  p.innerHTML = blurb;
  header.appendChild(h2);
  header.appendChild(p);

  // Canonical config-file banner. Lists the file(s) that own this concept
  // so users know where to look + edit. Each entry: { label, path }. Path
  // gets a copy button next to it (handy for paste-into-terminal flows).
  if (Array.isArray(configFiles) && configFiles.length) {
    const banner = document.createElement('div');
    banner.className = 'system-page-configfiles';
    for (const cf of configFiles) {
      if (!cf || (!cf.path && !cf.label)) continue;
      const row = document.createElement('div');
      row.className = 'system-page-configfile';
      if (cf.label) {
        const lbl = document.createElement('span');
        lbl.className = 'system-page-configfile-label';
        lbl.textContent = cf.label;
        row.appendChild(lbl);
      }
      if (cf.path) {
        const code = document.createElement('code');
        code.className = 'health-path';
        code.textContent = cf.path;
        row.appendChild(code);
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'health-copy-btn';
        copyBtn.textContent = 'copy';
        copyBtn.title = 'copy path to clipboard';
        copyBtn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          try {
            await navigator.clipboard.writeText(cf.path);
            copyBtn.textContent = 'copied';
            setTimeout(() => { copyBtn.textContent = 'copy'; }, 1200);
          } catch { /* ignore */ }
        });
        row.appendChild(copyBtn);
      }
      banner.appendChild(row);
    }
    header.appendChild(banner);
  }
  section.appendChild(header);

  const status = document.createElement('div');
  status.className = 'system-page-empty';
  status.textContent = 'loading...';
  status.dataset.role = 'status';
  section.appendChild(status);

  container.appendChild(section);
  return section;
}

/** Replace whatever is below the header with a single "(message)" line. */
export function setStatusLine(section, text) {
  // Remove every direct child after the header.
  const header = section.querySelector('.system-page-header');
  section.replaceChildren();
  if (header) section.appendChild(header);
  const el = document.createElement('div');
  el.className = 'system-page-empty';
  el.textContent = text;
  el.dataset.role = 'status';
  section.appendChild(el);
}

/** Remove everything below the header (used before re-rendering content). */
export function clearBody(section) {
  const header = section.querySelector('.system-page-header');
  section.replaceChildren();
  if (header) section.appendChild(header);
}

/**
 * Build one collapsible "group" with a heading and an item-list inside.
 * Heading shows the label plus a count.
 */
export function buildGroup({ label, count, openByDefault = true }) {
  const wrap = document.createElement('section');
  wrap.className = 'health-section';
  const head = document.createElement('header');
  head.className = 'health-section-head';
  head.setAttribute('role', 'button');
  head.setAttribute('tabindex', '0');
  head.setAttribute('aria-expanded', String(!!openByDefault));

  const chev = document.createElement('span');
  chev.className = 'health-section-chev';
  chev.textContent = openByDefault ? '▾' : '▸';
  const title = document.createElement('span');
  title.className = 'health-section-title';
  title.textContent = label;
  const countEl = document.createElement('span');
  countEl.className = 'health-section-count';
  countEl.textContent = String(count);
  if (!count) countEl.classList.add('health-section-count--zero');
  head.appendChild(chev);
  head.appendChild(title);
  head.appendChild(countEl);
  wrap.appendChild(head);

  const body = document.createElement('div');
  body.className = 'health-section-body-wrap';
  if (!openByDefault) body.classList.add('hidden');

  const list = document.createElement('div');
  list.className = 'health-item-list';
  body.appendChild(list);
  wrap.appendChild(body);

  head.addEventListener('click', () => {
    const hidden = body.classList.toggle('hidden');
    chev.textContent = hidden ? '▸' : '▾';
    head.setAttribute('aria-expanded', String(!hidden));
  });
  head.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); head.click(); }
  });
  return { wrap, list };
}

/**
 * Build a single item card with optional secondary, tags, description,
 * path, and an expand-to-JSON toggle. Action buttons can be added via
 * the optional `actions` array (each entry: { label, className, onClick,
 * disabled, title }).
 */
export function buildItem({
  primary, secondary, secondaryClass,
  tags, description, path,
  sourceLabel, sourcePath,
  fullRecord, actions, pluginTag,
}) {
  const card = document.createElement('div');
  card.className = 'health-item';

  const head = document.createElement('div');
  head.className = 'health-item-head';
  const left = document.createElement('div');
  left.className = 'health-item-left';

  const name = document.createElement('span');
  name.className = 'health-item-name';
  name.textContent = primary || '(unnamed)';
  left.appendChild(name);

  if (secondary) {
    const sec = document.createElement('span');
    sec.className = `health-item-secondary ${secondaryClass || ''}`.trim();
    sec.textContent = secondary;
    left.appendChild(sec);
  }
  if (pluginTag) {
    const sec = document.createElement('span');
    sec.className = 'health-item-secondary health-dim';
    sec.textContent = `from plugin: ${pluginTag}`;
    left.appendChild(sec);
  }

  if (Array.isArray(tags) && tags.length) {
    const tagWrap = document.createElement('span');
    tagWrap.className = 'health-item-tags';
    for (const t of tags) {
      const tag = document.createElement('span');
      tag.className = 'health-item-tag';
      tag.textContent = t;
      tagWrap.appendChild(tag);
    }
    left.appendChild(tagWrap);
  }
  head.appendChild(left);

  const right = document.createElement('div');
  right.style.display = 'inline-flex';
  right.style.gap = '6px';
  right.style.alignItems = 'center';

  if (Array.isArray(actions)) {
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `health-item-toggle ${a.className || ''}`.trim();
      b.textContent = a.label;
      if (a.title) b.title = a.title;
      if (a.disabled) b.disabled = true;
      b.addEventListener('click', (ev) => { a.onClick && a.onClick(ev, card); });
      right.appendChild(b);
    }
  }
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'health-item-toggle';
  toggle.textContent = 'show json';
  right.appendChild(toggle);
  head.appendChild(right);
  card.appendChild(head);

  if (description) {
    const p = document.createElement('p');
    p.className = 'health-item-desc';
    p.textContent = description;
    card.appendChild(p);
  }
  if (path) {
    const code = document.createElement('code');
    code.className = 'health-path health-item-path';
    code.textContent = path;
    card.appendChild(code);
  }

  // Source attribution. When sourcePath is provided, render a dashed-top
  // row showing where this config item is defined plus a copy-to-clipboard
  // button so users can paste the path into a terminal or editor.
  if (sourceLabel || sourcePath) {
    const src = document.createElement('div');
    src.className = 'health-item-source';
    if (sourceLabel) {
      const lbl = document.createElement('span');
      lbl.className = 'health-item-source-label';
      lbl.textContent = sourceLabel;
      src.appendChild(lbl);
    }
    if (sourcePath) {
      const code = document.createElement('code');
      code.className = 'health-path';
      code.textContent = sourcePath;
      src.appendChild(code);
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'health-copy-btn';
      copyBtn.textContent = 'copy';
      copyBtn.title = 'copy path to clipboard';
      copyBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await navigator.clipboard.writeText(sourcePath);
          copyBtn.textContent = 'copied';
          setTimeout(() => { copyBtn.textContent = 'copy'; }, 1200);
        } catch { /* ignore */ }
      });
      src.appendChild(copyBtn);
    }
    card.appendChild(src);
  }

  const body = document.createElement('pre');
  body.className = 'health-json-block hidden';
  body.textContent = safeStringify(fullRecord, 2);
  card.appendChild(body);
  toggle.addEventListener('click', () => {
    const hidden = body.classList.toggle('hidden');
    toggle.textContent = hidden ? 'show json' : 'hide json';
  });

  return card;
}

/** Small helper: a "(empty state)" block with optional CLI hint. */
export function emptyState({ message, hint }) {
  const wrap = document.createElement('div');
  wrap.className = 'system-page-empty';
  const m = document.createElement('p');
  m.style.margin = '0';
  m.textContent = message;
  wrap.appendChild(m);
  if (hint) {
    const code = document.createElement('code');
    code.className = 'health-path';
    code.style.marginTop = '8px';
    code.style.display = 'inline-block';
    code.textContent = hint;
    wrap.appendChild(document.createTextNode(' '));
    wrap.appendChild(code);
  }
  return wrap;
}

/** Footer line showing the CLI hint at the bottom of the page. */
export function buildFooterHint(text) {
  const p = document.createElement('p');
  p.className = 'system-page-sub';
  p.style.marginTop = '12px';
  p.innerHTML = text;
  return p;
}

export function shortenPath(p) {
  if (!p) return '';
  const home = '/Users/dan';
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

export function safeStringify(v, indent) {
  try { return JSON.stringify(v, null, indent); }
  catch { return String(v); }
}

/** Map a scope/source value to a stable display label. */
export function scopeLabel(s) {
  if (!s) return 'unknown';
  const lc = String(s).toLowerCase();
  if (lc === 'user' || lc === 'global') return 'user';
  if (lc === 'project' || lc === 'cwd' || lc === 'repo' || lc === 'workspace') return 'workspace';
  if (lc === 'builtin') return 'builtin';
  if (lc === 'plugin') return 'plugin';
  return lc;
}

/** Copy text to the clipboard; resolve true on success. */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
