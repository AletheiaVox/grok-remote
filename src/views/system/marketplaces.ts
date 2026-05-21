// Marketplaces page.

import {
  loadInspect, buildPageShell, setStatusLine, clearBody,
  addConfigFilesBanner,
  buildGroup, buildItem, emptyState, buildFooterHint, copyToClipboard,
  shortenPath, scopeLabel,
  type ConfigFile,
} from './_native_common.js';

interface Marketplace {
  name?: string;
  id?: string;
  url?: string;
  path?: string;
  scope?: string;
  plugins?: number;
  lastRefreshed?: string;
  [k: string]: unknown;
}

interface InspectShape {
  marketplaces?: Marketplace[];
  configSources?: { userPath?: string; projectPaths?: string[] };
}

let activeContainer: HTMLElement | null = null;
let aborted = false;

const BLURB = `
  Marketplaces are catalogs of plugins you can browse and install. Each
  marketplace has a name and a source URL (a git repo or HTTPS endpoint).
  Marketplaces are the primary way to discover and add new plugins to
  your grok install; the actual install/remove happens via the CLI.
`;

export async function mount(container: HTMLElement): Promise<void> {
  activeContainer = container;
  aborted = false;
  const section = buildPageShell(container, { title: 'Marketplaces', blurb: BLURB });
  await reload(section);
}

export function unmount(): void {
  aborted = true;
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

async function reload(section: HTMLElement): Promise<void> {
  const { inspect, error } = await loadInspect();
  if (aborted) return;
  if (error) { setStatusLine(section, 'failed to load: ' + error); return; }

  const data = (inspect && typeof inspect === 'object') ? inspect as InspectShape : {};
  const items = Array.isArray(data.marketplaces) ? data.marketplaces : [];
  const cs = data.configSources || {};
  const banner: ConfigFile[] = [
    ...(cs.userPath ? [{ label: 'user config', path: cs.userPath }] : []),
    ...(Array.isArray(cs.projectPaths) ? cs.projectPaths.map((p) => ({ label: 'project config', path: p })) : []),
  ];
  addConfigFilesBanner(section, banner);
  clearBody(section);

  if (!items.length) {
    section.appendChild(emptyState({
      message: 'no marketplaces configured yet.',
      hint: 'add one via the CLI: grok plugins marketplace add <url>',
    }));
    section.appendChild(buildFooterHint(
      'A marketplace is just a manifest pointing at a set of plugins. ' +
      'Once you add one with the CLI, it shows up here with its plugin count.',
    ));
    return;
  }

  const byKey = new Map<string, Marketplace[]>();
  for (const m of items) {
    const key = String(m.scope || 'user').toLowerCase();
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(m);
  }
  for (const [key, list] of byKey) {
    const { wrap, list: listEl } = buildGroup({ label: scopeLabel(key), count: list.length });
    for (const m of list) listEl.appendChild(makeMarketplaceCard(m));
    section.appendChild(wrap);
  }

  section.appendChild(buildFooterHint(
    'Add: <code>grok plugins marketplace add &lt;url&gt;</code>. ' +
    'Refresh + remove flows also live in the CLI.',
  ));
}

function makeMarketplaceCard(m: Marketplace): HTMLElement {
  const tags: string[] = [];
  if (typeof m.plugins === 'number') tags.push(`plugins: ${m.plugins}`);
  if (m.lastRefreshed) tags.push(`refreshed: ${m.lastRefreshed}`);
  if (m.scope) tags.push(scopeLabel(m.scope));

  const actions: { label: string; onClick: (ev: MouseEvent) => Promise<void> }[] = [];
  if (m.url) {
    const url = m.url;
    actions.push({
      label: 'copy url',
      onClick: async (ev: MouseEvent): Promise<void> => {
        const ok = await copyToClipboard(url);
        const btn = ev.currentTarget as HTMLButtonElement;
        const prior = btn.textContent;
        btn.textContent = ok ? 'copied' : 'copy failed';
        setTimeout(() => { btn.textContent = prior; }, 1500);
      },
    });
  }

  return buildItem({
    primary: m.name || m.id || '(unnamed)',
    secondary: m.url ? 'remote' : 'local',
    tags,
    path: shortenPath(m.url || m.path || ''),
    sourceLabel: m.scope ? `registered in ${scopeLabel(m.scope)}:` : 'source:',
    sourcePath: m.path || m.url || '',
    fullRecord: m,
    actions,
  });
}
