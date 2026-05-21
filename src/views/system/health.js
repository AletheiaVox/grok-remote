// Health page. Surfaces the full `grok inspect` payload (identity,
// permissions, hooks, skills, agents, plugins, marketplaces, MCP and LSP
// servers, config sources) plus `grok version`, an update check, and a
// small "server info" block. A recheck button re-runs the underlying
// commands.

import { api } from '../../lib/api';

let activeContainer = null;
let abortToken      = 0;
let lastUpdatedAt   = null;

export function mount(container) {
  activeContainer = container;
  abortToken += 1;
  const myToken = abortToken;

  container.replaceChildren();
  container.innerHTML = `
    <section class="system-page health-page">
      <header class="system-page-header health-header">
        <div>
          <h2 class="system-page-title">Health</h2>
          <p class="system-page-sub">
            What this grok build sees about itself. Combines
            <code>grok inspect</code>, <code>grok version</code>, and an
            update check.
          </p>
          <p class="health-last" data-role="last-updated" hidden></p>
        </div>
        <button type="button" class="health-recheck-btn" data-role="recheck">
          <span class="health-recheck-spinner" data-role="recheck-spinner" aria-hidden="true"></span>
          <span data-role="recheck-label">recheck</span>
        </button>
      </header>

      <div class="health-top-grid">
        <article class="health-card" data-card="version">
          <header class="health-card-head">version</header>
          <div class="health-card-body" data-role="version-body">
            <p class="health-status">loading...</p>
          </div>
        </article>

        <article class="health-card" data-card="update">
          <header class="health-card-head">update</header>
          <div class="health-card-body" data-role="update-body">
            <p class="health-status">loading...</p>
          </div>
        </article>

        <article class="health-card" data-card="server">
          <header class="health-card-head">server</header>
          <div class="health-card-body" data-role="server-body">
            <p class="health-status">loading...</p>
          </div>
        </article>
      </div>

      <div class="health-inspect" data-role="inspect-root">
        <p class="health-status">loading inspect...</p>
      </div>

      <p class="health-error" data-role="error" hidden></p>
    </section>
  `;

  const btn = container.querySelector('[data-role="recheck"]');
  if (btn) {
    btn.addEventListener('click', () => {
      recheck(container, () => myToken === abortToken).catch(() => {});
    });
  }

  load(container, () => myToken === abortToken).catch(() => {});
}

export function unmount() {
  abortToken += 1;
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

// ----- data flow -----

async function load(root, alive) {
  setLoading(root);
  try {
    const data = await api.systemHealth.get();
    if (!alive()) return;
    lastUpdatedAt = new Date();
    renderAll(root, data);
  } catch (err) {
    if (!alive()) return;
    showError(root, err);
  }
}

async function recheck(root, alive) {
  const btn = root.querySelector('[data-role="recheck"]');
  const label = root.querySelector('[data-role="recheck-label"]');
  if (btn) btn.disabled = true;
  if (btn) btn.dataset.busy = '1';
  if (label) label.textContent = 'rechecking...';
  setLoading(root);
  try {
    const data = await api.systemHealth.recheck();
    if (!alive()) return;
    lastUpdatedAt = new Date();
    renderAll(root, data);
  } catch (err) {
    if (!alive()) return;
    showError(root, err);
  } finally {
    if (alive() && btn) {
      btn.disabled = false;
      delete btn.dataset.busy;
    }
    if (alive() && label) label.textContent = 'recheck';
  }
}

function setLoading(root) {
  for (const sel of ['version-body', 'update-body', 'server-body']) {
    const el = root.querySelector(`[data-role="${sel}"]`);
    if (el) el.innerHTML = '<p class="health-status">loading...</p>';
  }
  const insp = root.querySelector('[data-role="inspect-root"]');
  if (insp) insp.innerHTML = '<p class="health-status">loading inspect...</p>';
  const err = root.querySelector('[data-role="error"]');
  if (err) { err.hidden = true; err.textContent = ''; }
}

function showError(root, err) {
  const errEl = root.querySelector('[data-role="error"]');
  if (errEl) {
    errEl.hidden = false;
    errEl.textContent = err?.message || String(err);
  }
}

function renderAll(root, data) {
  renderVersion(root.querySelector('[data-role="version-body"]'), data?.version, data?.versionError);
  renderUpdate(root.querySelector('[data-role="update-body"]'),  data?.update,  data?.updateError);
  renderServer(root.querySelector('[data-role="server-body"]'),  data?.server);
  renderInspect(root.querySelector('[data-role="inspect-root"]'), data?.inspect, data?.inspectError);
  renderLastUpdated(root);
}

function renderLastUpdated(root) {
  const el = root.querySelector('[data-role="last-updated"]');
  if (!el) return;
  if (!lastUpdatedAt) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `last checked ${fmtTimestamp(lastUpdatedAt)}`;
}

// ----- inspect renderer (the meat) -----

function renderInspect(host, inspect, errMsg) {
  if (!host) return;
  host.replaceChildren();
  if (errMsg) {
    host.appendChild(errorNote(errMsg));
    return;
  }
  if (!inspect || typeof inspect !== 'object') {
    host.appendChild(plain('(no inspect data)'));
    return;
  }

  // Identity card. Single non-collapsible block with the high-level
  // top-level facts about this project.
  host.appendChild(buildIdentity(inspect));

  // Sections in display order. Each is a collapsible card with a count.
  host.appendChild(buildPermissions(inspect.permissions));
  host.appendChild(buildProjectInstructions(inspect.projectInstructions));
  host.appendChild(buildHooks(inspect.hooks));
  host.appendChild(buildSkills(inspect.skills));
  host.appendChild(buildAgents(inspect.agents));
  host.appendChild(buildPlugins(inspect.plugins));
  host.appendChild(buildMarketplaces(inspect.marketplaces));
  host.appendChild(buildMcpServers(inspect.mcpServers));
  host.appendChild(buildLspServers(inspect.lspServers));

  // Any extra top-level keys we don't know about yet: dump as raw JSON
  // so we don't silently swallow them.
  const known = new Set([
    'grokVersion', 'cwd', 'projectRoot', 'projectTrusted', 'projectInstructions',
    'permissions', 'hooks', 'skills', 'agents', 'plugins', 'marketplaces',
    'mcpServers', 'lspServers', 'configSources',
  ]);
  const extras = Object.fromEntries(
    Object.entries(inspect).filter(([k]) => !known.has(k))
  );
  if (Object.keys(extras).length) {
    host.appendChild(buildSection({
      title: 'other',
      count: Object.keys(extras).length,
      buildBody: () => {
        const pre = document.createElement('pre');
        pre.className = 'health-json-block';
        pre.textContent = safeStringify(extras, 2);
        return pre;
      },
    }));
  }
}

function buildIdentity(inspect) {
  const card = document.createElement('article');
  card.className = 'health-identity';
  const head = document.createElement('header');
  head.className = 'health-identity-head';
  head.textContent = 'identity';
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'health-identity-body';

  const rows = [
    ['grokVersion',       inspect.grokVersion],
    ['cwd',               inspect.cwd],
    ['projectRoot',       inspect.projectRoot],
    ['projectTrusted',    inspect.projectTrusted],
    ['configSources.userPath',     inspect.configSources?.userPath],
    ['configSources.projectPaths', inspect.configSources?.projectPaths],
  ];

  const dl = document.createElement('dl');
  dl.className = 'health-kv';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd');
    if (Array.isArray(v)) {
      if (!v.length) {
        dd.textContent = '(none)';
        dd.className = 'health-dim';
      } else {
        for (const item of v) {
          const code = document.createElement('code');
          code.className = 'health-path';
          code.textContent = String(item);
          dd.appendChild(code);
        }
      }
    } else if (typeof v === 'boolean') {
      dd.textContent = v ? 'true' : 'false';
      dd.className = v ? 'health-good' : 'health-warn';
    } else if (v === undefined || v === null || v === '') {
      dd.textContent = '(unset)';
      dd.className = 'health-dim';
    } else if (typeof v === 'string' && (k.endsWith('Path') || k === 'cwd' || k === 'projectRoot' || k.includes('userPath'))) {
      const code = document.createElement('code');
      code.className = 'health-path';
      code.textContent = v;
      dd.appendChild(code);
    } else {
      dd.textContent = stringify(v);
    }
    dl.append(dt, dd);
  }
  body.appendChild(dl);
  card.appendChild(body);
  return card;
}

// ----- sections -----

function buildPermissions(perm) {
  perm = perm || {};
  const sources = Array.isArray(perm.sources) ? perm.sources : [];
  const skipped = Array.isArray(perm.skipped) ? perm.skipped : [];
  const mcpAllow = Array.isArray(perm.mcpServerAllowlist) ? perm.mcpServerAllowlist : [];
  const mktAllow = Array.isArray(perm.marketplaceAllowlist) ? perm.marketplaceAllowlist : [];
  const loaded = typeof perm.loaded === 'number' ? perm.loaded : null;

  return buildSection({
    title: 'permissions',
    count: loaded == null ? sources.length : loaded,
    countLabel: loaded == null ? null : `${loaded} loaded`,
    buildBody: () => {
      const wrap = document.createElement('div');
      wrap.className = 'health-section-body';

      // loaded count summary
      const kv = document.createElement('dl');
      kv.className = 'health-kv';
      const dtL = document.createElement('dt'); dtL.textContent = 'loaded';
      const ddL = document.createElement('dd'); ddL.textContent = loaded == null ? '(unknown)' : String(loaded);
      kv.append(dtL, ddL);
      wrap.appendChild(kv);

      wrap.appendChild(buildList('sources', sources, (s) => {
        const code = document.createElement('code');
        code.className = 'health-path';
        code.textContent = String(s);
        return code;
      }));

      wrap.appendChild(buildList('skipped', skipped, (s) => {
        if (typeof s === 'string') {
          const code = document.createElement('code');
          code.className = 'health-path';
          code.textContent = s;
          return code;
        }
        return rawJsonBlock(s);
      }));

      wrap.appendChild(buildList('mcpServerAllowlist', mcpAllow, (s) => {
        const code = document.createElement('code');
        code.className = 'health-path';
        code.textContent = String(s);
        return code;
      }));

      wrap.appendChild(buildList('marketplaceAllowlist', mktAllow, (s) => {
        const code = document.createElement('code');
        code.className = 'health-path';
        code.textContent = String(s);
        return code;
      }));

      return wrap;
    },
  });
}

function buildProjectInstructions(items) {
  items = Array.isArray(items) ? items : [];
  return buildSection({
    title: 'project instructions',
    count: items.length,
    buildBody: () => {
      if (!items.length) return dimText('(none)');
      const ul = document.createElement('ul');
      ul.className = 'health-flat-list';
      for (const it of items) {
        const li = document.createElement('li');
        if (typeof it === 'string') {
          const code = document.createElement('code');
          code.className = 'health-path';
          code.textContent = it;
          li.appendChild(code);
        } else {
          li.appendChild(rawJsonBlock(it));
        }
        ul.appendChild(li);
      }
      return ul;
    },
  });
}

function buildHooks(hooks) {
  hooks = Array.isArray(hooks) ? hooks : [];
  return buildSection({
    title: 'hooks',
    count: hooks.length,
    buildBody: () => {
      if (!hooks.length) return dimText('(none)');
      const list = document.createElement('div');
      list.className = 'health-item-list';
      for (const h of hooks) {
        list.appendChild(buildItem({
          primary: h.event || '(unknown event)',
          secondary: h.hookType || '',
          tags: [
            h.matcher ? `matcher: ${truncate(stringify(h.matcher), 60)}` : null,
            h.source?.type ? `source: ${h.source.type}` : null,
            h.source?.plugin_name ? `plugin: ${h.source.plugin_name}` : null,
          ].filter(Boolean),
          sourceLabel: h.source?.plugin_name
            ? `from plugin: ${h.source.plugin_name}`
            : (h.source?.type ? `defined in: ${h.source.type}` : 'defined in:'),
          sourcePath: h.source?.path || h.target || '',
          fullRecord: h,
        }));
      }
      return list;
    },
  });
}

function buildSkills(skills) {
  skills = Array.isArray(skills) ? skills : [];
  return buildSection({
    title: 'skills',
    count: skills.length,
    buildBody: () => {
      if (!skills.length) return dimText('(none)');
      const list = document.createElement('div');
      list.className = 'health-item-list';
      for (const s of skills) {
        list.appendChild(buildItem({
          primary: s.name || '(unnamed)',
          secondary: s.source?.type ? scopeLabel(s.source.type) : '',
          tags: [
            s.userInvocable ? 'user-invocable' : null,
          ].filter(Boolean),
          description: s.description || '',
          sourceLabel: s.source?.plugin_name
            ? `from plugin: ${s.source.plugin_name}`
            : (s.source?.type ? `from ${scopeLabel(s.source.type)}:` : 'from:'),
          sourcePath: s.source?.path || '',
          fullRecord: s,
        }));
      }
      return list;
    },
  });
}

function buildAgents(agents) {
  agents = Array.isArray(agents) ? agents : [];
  return buildSection({
    title: 'agents',
    count: agents.length,
    buildBody: () => {
      if (!agents.length) return dimText('(none)');
      const list = document.createElement('div');
      list.className = 'health-item-list';
      for (const a of agents) {
        list.appendChild(buildItem({
          primary: a.name || '(unnamed)',
          secondary: a.source?.type ? scopeLabel(a.source.type) : '',
          tags: [
            a.model ? `model: ${a.model}` : null,
            Array.isArray(a.tools) ? `tools: ${a.tools.length}` : null,
          ].filter(Boolean),
          description: a.description || a.systemPrompt || '',
          sourceLabel: a.source?.plugin_name
            ? `from plugin: ${a.source.plugin_name}`
            : (a.source?.type ? `from ${scopeLabel(a.source.type)}:` : 'from:'),
          sourcePath: a.source?.path || '',
          fullRecord: a,
        }));
      }
      return list;
    },
  });
}

function buildPlugins(plugins) {
  plugins = Array.isArray(plugins) ? plugins : [];
  // sort: enabled first, then by name
  const sorted = [...plugins].sort((a, b) => {
    const ea = a.enabled === false ? 1 : 0;
    const eb = b.enabled === false ? 1 : 0;
    if (ea !== eb) return ea - eb;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  return buildSection({
    title: 'plugins',
    count: plugins.length,
    buildBody: () => {
      if (!plugins.length) return dimText('(none)');
      const list = document.createElement('div');
      list.className = 'health-item-list';
      for (const p of sorted) {
        const provides = p.provides || {};
        const tags = [];
        if (p.scope) tags.push(scopeLabel(p.scope));
        if (p.version) tags.push(`v${p.version}`);
        if (provides.skills)     tags.push(`skills: ${provides.skills}`);
        if (provides.agents)     tags.push(`agents: ${provides.agents}`);
        if (provides.mcpServers) tags.push(`mcp: ${provides.mcpServers}`);
        if (provides.hooks)      tags.push('hooks');
        list.appendChild(buildItem({
          primary: p.name || '(unnamed)',
          secondary: p.enabled === false ? 'disabled' : 'enabled',
          secondaryClass: p.enabled === false ? 'health-warn' : 'health-good',
          tags,
          sourceLabel: p.scope ? `installed in ${scopeLabel(p.scope)}:` : 'installed at:',
          sourcePath: p.path || '',
          fullRecord: p,
        }));
      }
      return list;
    },
  });
}

function buildMarketplaces(items) {
  items = Array.isArray(items) ? items : [];
  return buildSection({
    title: 'marketplaces',
    count: items.length,
    buildBody: () => {
      if (!items.length) return dimText('(none)');
      const list = document.createElement('div');
      list.className = 'health-item-list';
      for (const m of items) {
        list.appendChild(buildItem({
          primary: m.name || m.id || '(unnamed)',
          secondary: m.scope ? scopeLabel(m.scope) : '',
          tags: [
            m.url ? `url: ${truncate(m.url, 60)}` : null,
            typeof m.plugins === 'number' ? `plugins: ${m.plugins}` : null,
          ].filter(Boolean),
          path: m.path || m.url || '',
          fullRecord: m,
        }));
      }
      return list;
    },
  });
}

function buildMcpServers(servers) {
  servers = Array.isArray(servers) ? servers : [];
  return buildSection({
    title: 'mcp servers',
    count: servers.length,
    buildBody: () => {
      if (!servers.length) return dimText('(none)');
      const list = document.createElement('div');
      list.className = 'health-item-list';
      for (const s of servers) {
        const transport = s.transport || s.type || (s.url ? 'http' : 'stdio');
        const target = s.url || s.command || (Array.isArray(s.args) ? s.args.join(' ') : '');
        list.appendChild(buildItem({
          primary: s.name || '(unnamed)',
          secondary: transport,
          tags: [
            s.scope ? scopeLabel(s.scope) : null,
            s.enabled === false ? 'disabled' : null,
          ].filter(Boolean),
          path: target,
          fullRecord: s,
        }));
      }
      return list;
    },
  });
}

function buildLspServers(servers) {
  servers = Array.isArray(servers) ? servers : [];
  return buildSection({
    title: 'lsp servers',
    count: servers.length,
    buildBody: () => {
      if (!servers.length) return dimText('(none)');
      const list = document.createElement('div');
      list.className = 'health-item-list';
      for (const s of servers) {
        list.appendChild(buildItem({
          primary: s.name || s.language || '(unnamed)',
          secondary: s.language || '',
          tags: [
            Array.isArray(s.filetypes) && s.filetypes.length ? `filetypes: ${s.filetypes.join(', ')}` : null,
          ].filter(Boolean),
          path: s.command || (Array.isArray(s.args) ? s.args.join(' ') : ''),
          fullRecord: s,
        }));
      }
      return list;
    },
  });
}

// ----- building blocks -----

function buildSection({ title, count, countLabel, buildBody }) {
  const wrap = document.createElement('article');
  wrap.className = 'health-section';

  const head = document.createElement('header');
  head.className = 'health-section-head';
  head.setAttribute('role', 'button');
  head.setAttribute('tabindex', '0');
  head.setAttribute('aria-expanded', 'false');

  const chevron = document.createElement('span');
  chevron.className = 'health-section-chev';
  chevron.textContent = '▸'; // right-pointing triangle
  head.appendChild(chevron);

  const titleEl = document.createElement('span');
  titleEl.className = 'health-section-title';
  titleEl.textContent = title;
  head.appendChild(titleEl);

  const countEl = document.createElement('span');
  countEl.className = 'health-section-count';
  countEl.textContent = countLabel || String(count);
  if (count === 0) countEl.classList.add('health-section-count--zero');
  head.appendChild(countEl);

  wrap.appendChild(head);

  const body = document.createElement('div');
  body.className = 'health-section-body-wrap hidden';
  wrap.appendChild(body);

  let built = false;
  function expand() {
    if (!built) {
      try {
        const content = buildBody();
        body.replaceChildren();
        if (content) body.appendChild(content);
      } catch (err) {
        body.replaceChildren(errorNote(err?.message || String(err)));
      }
      built = true;
    }
    body.classList.remove('hidden');
    chevron.textContent = '▾'; // down-pointing triangle
    head.setAttribute('aria-expanded', 'true');
  }
  function collapse() {
    body.classList.add('hidden');
    chevron.textContent = '▸';
    head.setAttribute('aria-expanded', 'false');
  }
  head.addEventListener('click', () => {
    if (body.classList.contains('hidden')) expand();
    else collapse();
  });
  head.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      head.click();
    }
  });

  return wrap;
}

function buildList(title, items, renderItem) {
  const wrap = document.createElement('div');
  wrap.className = 'health-sublist';
  const h = document.createElement('div');
  h.className = 'health-sublist-title';
  h.textContent = `${title} (${items.length})`;
  wrap.appendChild(h);
  if (!items.length) {
    wrap.appendChild(dimText('(none)'));
    return wrap;
  }
  const ul = document.createElement('ul');
  ul.className = 'health-flat-list';
  for (const item of items) {
    const li = document.createElement('li');
    const rendered = renderItem(item);
    if (rendered) li.appendChild(rendered);
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  return wrap;
}

function buildItem({ primary, secondary, secondaryClass, tags, description, path, sourceLabel, sourcePath, fullRecord }) {
  const card = document.createElement('div');
  card.className = 'health-item';

  const head = document.createElement('div');
  head.className = 'health-item-head';

  const left = document.createElement('div');
  left.className = 'health-item-left';

  const name = document.createElement('span');
  name.className = 'health-item-name';
  name.textContent = primary || '';
  left.appendChild(name);

  if (secondary) {
    const sec = document.createElement('span');
    sec.className = `health-item-secondary ${secondaryClass || ''}`.trim();
    sec.textContent = secondary;
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

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'health-item-toggle';
  toggle.textContent = 'show json';
  head.appendChild(toggle);

  card.appendChild(head);

  if (description) {
    const p = document.createElement('p');
    p.className = 'health-item-desc';
    p.textContent = description;
    card.appendChild(p);
  }

  // Source attribution: every config item came from somewhere on disk or
  // from a plugin. Make it visible so users can find + edit the source.
  if (sourceLabel || sourcePath || path) {
    const src = document.createElement('div');
    src.className = 'health-item-source';
    if (sourceLabel) {
      const lbl = document.createElement('span');
      lbl.className = 'health-item-source-label';
      lbl.textContent = sourceLabel;
      src.appendChild(lbl);
    }
    const finalPath = sourcePath || path;
    if (finalPath) {
      const code = document.createElement('code');
      code.className = 'health-path health-item-path';
      code.textContent = finalPath;
      src.appendChild(code);
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'health-copy-btn';
      copyBtn.textContent = 'copy';
      copyBtn.title = 'copy path to clipboard';
      copyBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await navigator.clipboard.writeText(finalPath);
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

function rawJsonBlock(value) {
  const pre = document.createElement('pre');
  pre.className = 'health-json-block';
  pre.textContent = safeStringify(value, 2);
  return pre;
}

function dimText(text) {
  const p = document.createElement('p');
  p.className = 'health-status health-dim';
  p.textContent = text;
  return p;
}

function scopeLabel(s) {
  if (!s) return '';
  const lc = String(s).toLowerCase();
  if (lc === 'user' || lc === 'global') return 'user';
  if (lc === 'project' || lc === 'cwd' || lc === 'repo') return lc;
  if (lc === 'builtin') return 'builtin';
  if (lc === 'plugin') return 'plugin';
  return lc;
}

// ----- top-row renderers (version / update / server) -----

function renderVersion(host, version, errMsg) {
  if (!host) return;
  host.replaceChildren();
  if (errMsg) { host.appendChild(errorNote(errMsg)); return; }
  if (!version || typeof version !== 'object') {
    host.appendChild(plain('(no data)'));
    return;
  }
  const dl = document.createElement('dl');
  dl.className = 'health-kv';
  const KNOWN = ['version', 'commit', 'build', 'buildHash', 'hash', 'channel', 'timestamp', 'buildTimestamp', 'binary', 'path'];
  const seen = new Set();
  for (const key of KNOWN) {
    if (version[key] === undefined || version[key] === null) continue;
    seen.add(key);
    const dt = document.createElement('dt'); dt.textContent = key;
    const dd = document.createElement('dd'); dd.textContent = stringify(version[key]);
    dl.append(dt, dd);
  }
  for (const [k, v] of Object.entries(version)) {
    if (seen.has(k)) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') continue;
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = stringify(v);
    dl.append(dt, dd);
  }
  if (!dl.childElementCount) {
    host.appendChild(plain('(empty)'));
    return;
  }
  host.appendChild(dl);
}

function renderUpdate(host, update, errMsg) {
  if (!host) return;
  host.replaceChildren();
  if (errMsg && !update) {
    host.appendChild(errorNote(errMsg));
    return;
  }
  if (!update || typeof update !== 'object') {
    host.appendChild(plain('(no data)'));
    return;
  }

  const available = !!(update.available || update.update || update.hasUpdate);
  const latest    = update.latest || update.latestVersion || update.target || '';
  const current   = update.current || update.currentVersion || update.installed || '';
  const channel   = update.channel || '';

  const status = document.createElement('p');
  status.className = 'health-update-status';
  status.dataset.status = available ? 'available' : 'current';
  status.textContent = available
    ? `update available${latest ? `: ${latest}` : ''}`
    : 'up to date';
  host.appendChild(status);

  const dl = document.createElement('dl');
  dl.className = 'health-kv';
  if (current) {
    const dt = document.createElement('dt'); dt.textContent = 'current';
    const dd = document.createElement('dd'); dd.textContent = stringify(current);
    dl.append(dt, dd);
  }
  if (latest) {
    const dt = document.createElement('dt'); dt.textContent = 'latest';
    const dd = document.createElement('dd'); dd.textContent = stringify(latest);
    dl.append(dt, dd);
  }
  if (channel) {
    const dt = document.createElement('dt'); dt.textContent = 'channel';
    const dd = document.createElement('dd'); dd.textContent = stringify(channel);
    dl.append(dt, dd);
  }
  if (dl.childElementCount) host.appendChild(dl);

  if (available) {
    const row = document.createElement('div');
    row.className = 'health-update-action';
    const cmd = document.createElement('code');
    cmd.className = 'health-update-cmd';
    cmd.textContent = 'grok update';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'health-copy-btn';
    btn.textContent = 'copy';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText('grok update');
        btn.textContent = 'copied';
        setTimeout(() => { btn.textContent = 'copy'; }, 1500);
      } catch {
        btn.textContent = 'copy failed';
        setTimeout(() => { btn.textContent = 'copy'; }, 1500);
      }
    });
    row.append(cmd, btn);
    host.appendChild(row);
  }

  if (errMsg) {
    host.appendChild(errorNote(errMsg));
  }
}

function renderServer(host, server) {
  if (!host) return;
  host.replaceChildren();
  if (!server || typeof server !== 'object') {
    host.appendChild(plain('(no data)'));
    return;
  }
  const dl = document.createElement('dl');
  dl.className = 'health-kv';
  const rows = [
    ['node',     server.node || ''],
    ['platform', server.platform || ''],
    ['uptime',   fmtUptime(server.uptimeSeconds)],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v || '';
    dl.append(dt, dd);
  }
  host.appendChild(dl);
}

// ----- formatters -----

function plain(text) {
  const p = document.createElement('p');
  p.className = 'health-status';
  p.textContent = text;
  return p;
}

function errorNote(msg) {
  const p = document.createElement('p');
  p.className = 'health-card-error';
  p.textContent = msg;
  return p;
}

function stringify(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

function safeStringify(v, indent) {
  try { return JSON.stringify(v, null, indent); }
  catch { return String(v); }
}

function truncate(s, n) {
  s = String(s);
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

function fmtTimestamp(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function fmtUptime(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '0s';
  const days = Math.floor(s / 86400);
  const hrs  = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hrs)  parts.push(`${hrs}h`);
  if (mins) parts.push(`${mins}m`);
  if (!parts.length || secs) parts.push(`${secs}s`);
  return parts.join(' ');
}
