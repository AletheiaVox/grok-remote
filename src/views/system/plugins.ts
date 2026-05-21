// Plugins page.

import {
  loadInspect, buildPageShell, setStatusLine, clearBody,
  addConfigFilesBanner,
  buildGroup, buildItem, emptyState, buildFooterHint, copyToClipboard,
  shortenPath, scopeLabel,
  type ConfigFile,
} from './_native_common.js';

interface PluginRecord {
  name?: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
  path?: string;
  provides?: {
    skills?: number;
    agents?: number;
    mcpServers?: number;
    hooks?: boolean | number;
  };
  [k: string]: unknown;
}

interface InspectShape {
  plugins?: PluginRecord[];
  configSources?: { userPath?: string; projectPaths?: string[] };
}

let activeContainer: HTMLElement | null = null;
let aborted = false;

const BLURB = `
  Plugins bundle skills, subagents, MCP servers, and hooks into a single
  installable unit. Each plugin lives in its own directory and is listed
  in your config. Toggle them on or off (in <code>config.toml</code>) to
  control what's loaded into your sessions. Use the CLI to install a new
  plugin; the dashboard is for inspecting and disabling what's already
  there.
`;

export async function mount(container: HTMLElement): Promise<void> {
  activeContainer = container;
  aborted = false;
  const section = buildPageShell(container, { title: 'Plugins', blurb: BLURB });
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
  const plugins = Array.isArray(data.plugins) ? data.plugins : [];
  const cs = data.configSources || {};
  const banner: ConfigFile[] = [
    ...(cs.userPath ? [{ label: 'user config', path: cs.userPath }] : []),
    ...(Array.isArray(cs.projectPaths) ? cs.projectPaths.map((p) => ({ label: 'project config', path: p })) : []),
  ];
  addConfigFilesBanner(section, banner);
  clearBody(section);

  if (!plugins.length) {
    section.appendChild(emptyState({
      message: 'no plugins installed.',
      hint: 'install one via the CLI: grok plugins add <path-or-url>',
    }));
    return;
  }

  const sorted = [...plugins].sort((a, b) => {
    const ea = a.enabled === false ? 1 : 0;
    const eb = b.enabled === false ? 1 : 0;
    if (ea !== eb) return ea - eb;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });

  const enabled  = sorted.filter((p) => p.enabled !== false);
  const disabled = sorted.filter((p) => p.enabled === false);

  if (enabled.length) {
    const { wrap, list } = buildGroup({ label: 'enabled', count: enabled.length });
    for (const p of enabled) list.appendChild(makePluginCard(p));
    section.appendChild(wrap);
  }
  if (disabled.length) {
    const { wrap, list } = buildGroup({ label: 'disabled', count: disabled.length, openByDefault: false });
    for (const p of disabled) list.appendChild(makePluginCard(p));
    section.appendChild(wrap);
  }

  section.appendChild(buildFooterHint(
    'Install plugins via the CLI: <code>grok plugins add &lt;path&gt;</code>. ' +
    'Disabling a plugin writes <code>[plugins.&lt;name&gt;] enabled = false</code> to ' +
    'config.toml; in-place edits from the dashboard are not yet wired up, so use the ' +
    '"copy disable line" button and paste manually.',
  ));
}

function makePluginCard(p: PluginRecord): HTMLElement {
  const provides = p.provides || {};
  const tags: string[] = [];
  if (p.version) tags.push(`v${p.version}`);
  if (p.scope) tags.push(scopeLabel(p.scope));
  if (provides.skills)     tags.push(`skills: ${provides.skills}`);
  if (provides.agents)     tags.push(`agents: ${provides.agents}`);
  if (provides.mcpServers) tags.push(`mcp: ${provides.mcpServers}`);
  if (provides.hooks)      tags.push('hooks');

  const enabled = p.enabled !== false;
  const actions = [{
    label: enabled ? 'copy disable' : 'copy enable',
    title: enabled
      ? 'copy a [plugins.<name>] enabled = false snippet for config.toml'
      : 'copy a [plugins.<name>] enabled = true snippet for config.toml',
    onClick: async (ev: MouseEvent): Promise<void> => {
      const snippet = `[plugins.${tomlKey(p.name)}]\nenabled = ${enabled ? 'false' : 'true'}\n`;
      const ok = await copyToClipboard(snippet);
      const btn = ev.currentTarget as HTMLButtonElement;
      const prior = btn.textContent;
      btn.textContent = ok ? 'copied' : 'copy failed';
      setTimeout(() => { btn.textContent = prior; }, 1500);
    },
  }];

  return buildItem({
    primary: p.name || '(unnamed)',
    secondary: enabled ? 'enabled' : 'disabled',
    secondaryClass: enabled ? 'health-good' : 'health-warn',
    tags,
    path: p.path ? shortenPath(p.path) : '',
    sourceLabel: p.scope ? `installed in ${scopeLabel(p.scope)}:` : 'installed at:',
    sourcePath: p.path || '',
    fullRecord: p,
    actions,
  });
}

function tomlKey(name: string | null | undefined): string {
  if (typeof name !== 'string' || !name) return '"_"';
  if (/^[A-Za-z0-9_-]+$/.test(name)) return name;
  return '"' + name.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
