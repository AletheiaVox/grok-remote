// LSP servers page.

import {
  loadInspect, buildPageShell, setStatusLine, clearBody,
  addConfigFilesBanner,
  buildGroup, buildItem, emptyState, buildFooterHint, copyToClipboard,
  shortenPath, scopeLabel,
  type ConfigFile,
} from './_native_common.js';

interface LspSource { type?: string; path?: string; plugin_name?: string }
interface LspServer {
  language?: string;
  name?: string;
  command?: string;
  args?: string[];
  root_markers?: string[];
  rootMarkers?: string[];
  filetypes?: string[];
  scope?: string;
  source?: LspSource;
  env?: Record<string, unknown>;
  [k: string]: unknown;
}

interface InspectShape {
  lspServers?: LspServer[];
  configSources?: { userPath?: string; projectPaths?: string[] };
}

let activeContainer: HTMLElement | null = null;
let aborted = false;

const BLURB = `
  Language servers give grok code intelligence (hover, go-to-definition,
  references) while it works in your codebase. Each LSP entry binds a
  language to a server command. They are configured under
  <code>[[lsp]]</code> in <code>config.toml</code>. Most projects don't
  need this; it's an advanced opt-in.
`;

export async function mount(container: HTMLElement): Promise<void> {
  activeContainer = container;
  aborted = false;
  const section = buildPageShell(container, { title: 'LSP servers', blurb: BLURB });
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
  const items = Array.isArray(data.lspServers) ? data.lspServers : [];
  const cs = data.configSources || {};
  const banner: ConfigFile[] = [
    ...(cs.userPath ? [{ label: 'user config', path: cs.userPath }] : []),
    ...(Array.isArray(cs.projectPaths) ? cs.projectPaths.map((p) => ({ label: 'project config', path: p })) : []),
  ];
  addConfigFilesBanner(section, banner);
  clearBody(section);

  if (!items.length) {
    section.appendChild(emptyState({
      message: 'no LSP servers configured.',
      hint: 'add one under [[lsp]] in ~/.grok/config.toml',
    }));
    section.appendChild(buildFooterHint(
      'Starter snippet: ' +
      '<code>[[lsp]] language = "typescript" command = "typescript-language-server" ' +
      'args = ["--stdio"] root_markers = ["package.json", "tsconfig.json"]</code>',
    ));
    return;
  }

  const byKey = new Map<string, LspServer[]>();
  for (const s of items) {
    const key = String((s.source && s.source.type) || s.scope || 'user').toLowerCase();
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(s);
  }
  for (const [key, list] of byKey) {
    const { wrap, list: listEl } = buildGroup({ label: scopeLabel(key), count: list.length });
    for (const s of list) listEl.appendChild(makeLspCard(s));
    section.appendChild(wrap);
  }

  section.appendChild(buildFooterHint(
    'Edits land in <code>config.toml</code> under <code>[[lsp]]</code>. ' +
    'Use the per-entry copy buttons to grab a TOML snippet you can drop in.',
  ));
}

function makeLspCard(s: LspServer): HTMLElement {
  const lang = s.language || s.name || '(unknown)';
  const cmd = s.command || '';
  const args = Array.isArray(s.args) ? s.args : [];
  const markers = Array.isArray(s.root_markers || s.rootMarkers) ? (s.root_markers || s.rootMarkers)! : [];
  const tags: string[] = [];
  if (markers.length) tags.push(`roots: ${markers.join(', ')}`);
  if (Array.isArray(s.filetypes) && s.filetypes.length) tags.push(`filetypes: ${s.filetypes.join(', ')}`);

  const target = [cmd, ...args].filter(Boolean).join(' ');

  const actions = [{
    label: 'copy TOML',
    title: 'copy a [[lsp]] block you can paste into config.toml',
    onClick: async (ev: MouseEvent): Promise<void> => {
      const ok = await copyToClipboard(toToml(s));
      const btn = ev.currentTarget as HTMLButtonElement;
      const prior = btn.textContent;
      btn.textContent = ok ? 'copied' : 'copy failed';
      setTimeout(() => { btn.textContent = prior; }, 1500);
    },
  }];

  return buildItem({
    primary: lang,
    secondary: cmd || null,
    tags,
    path: shortenPath(target),
    sourceLabel: s.source?.plugin_name
      ? `from plugin: ${s.source.plugin_name}`
      : (s.source?.type ? `defined in ${scopeLabel(s.source.type)}:` : 'defined in:'),
    sourcePath: s.source?.path || '',
    fullRecord: s,
    actions,
  });
}

function toToml(s: LspServer): string {
  const lines: string[] = ['[[lsp]]'];
  const lang = s.language || s.name;
  if (lang) lines.push(`language = ${q(lang)}`);
  if (s.command) lines.push(`command = ${q(s.command)}`);
  if (Array.isArray(s.args) && s.args.length) {
    lines.push(`args = [${s.args.map(q).join(', ')}]`);
  }
  const markers = s.root_markers || s.rootMarkers;
  if (Array.isArray(markers) && markers.length) {
    lines.push(`root_markers = [${markers.map(q).join(', ')}]`);
  }
  if (s.env && typeof s.env === 'object') {
    const kvs = Object.entries(s.env).map(([k, v]) => `${k} = ${q(String(v))}`);
    if (kvs.length) {
      lines.push(`[lsp.env]`);
      lines.push(...kvs);
    }
  }
  return lines.join('\n') + '\n';
}

function q(s: string): string {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
