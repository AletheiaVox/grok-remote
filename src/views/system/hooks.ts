// Hooks page.

import {
  loadInspect, buildPageShell, setStatusLine, clearBody,
  addConfigFilesBanner,
  buildGroup, buildItem, emptyState, buildFooterHint, copyToClipboard,
  shortenPath, scopeLabel,
  type ConfigFile,
} from './_native_common.js';

interface HookSource { type?: string; path?: string; plugin_name?: string }
interface HookRecord {
  event?: string;
  hookType?: string;
  target?: string;
  matcher?: unknown;
  source?: HookSource;
  [k: string]: unknown;
}

interface InspectShape {
  hooks?: HookRecord[];
  configSources?: { userPath?: string; projectPaths?: string[] };
}

let activeContainer: HTMLElement | null = null;
let aborted = false;

const BLURB = `
  Hooks let grok react to lifecycle events with shell commands. Each hook
  listens for an event like <code>OnUserPrompt</code> or
  <code>BeforeToolCall</code>, optionally filters by matcher, and runs a
  command with the event payload on stdin. Use them to log, audit, or
  rewrite behavior. User and workspace hooks live under
  <code>[[hooks]]</code> in <code>~/.grok/config.toml</code> or
  <code>&lt;project&gt;/.grok/config.toml</code>; plugins can ship their
  own.
`;

export async function mount(container: HTMLElement): Promise<void> {
  activeContainer = container;
  aborted = false;
  const section = buildPageShell(container, { title: 'Hooks', blurb: BLURB });
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
  const hooks = Array.isArray(data.hooks) ? data.hooks : [];
  const cs = data.configSources || {};
  const banner: ConfigFile[] = [
    ...(cs.userPath ? [{ label: 'user config', path: cs.userPath }] : []),
    ...(Array.isArray(cs.projectPaths) ? cs.projectPaths.map((p) => ({ label: 'project config', path: p })) : []),
  ];
  addConfigFilesBanner(section, banner);
  clearBody(section);

  if (!hooks.length) {
    const empty = emptyState({
      message: 'no hooks configured.',
      hint: 'edit ~/.grok/config.toml and add a [[hooks]] table',
    });
    section.appendChild(empty);
    section.appendChild(buildFooterHint(
      'Hooks are stored as <code>[[hooks]]</code> tables in config.toml. ' +
      'In-browser TOML editing is not yet available; for now use the copy buttons ' +
      'and paste into the right config file.',
    ));
    return;
  }

  const ORDER = ['user', 'project', 'cwd', 'workspace', 'plugin', 'builtin'];
  const byKey = new Map<string, HookRecord[]>();
  for (const h of hooks) {
    const src = h.source && h.source.type ? String(h.source.type).toLowerCase() : 'other';
    if (!byKey.has(src)) byKey.set(src, []);
    byKey.get(src)!.push(h);
  }
  const keys = [...byKey.keys()].sort((a, b) => {
    const ia = ORDER.indexOf(a); const ib = ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1; if (ib === -1) return -1;
    return ia - ib;
  });

  for (const key of keys) {
    const items = byKey.get(key) || [];
    const { wrap, list } = buildGroup({
      label: scopeLabel(key), count: items.length, openByDefault: true,
    });
    for (const h of items) list.appendChild(makeHookCard(h));
    section.appendChild(wrap);
  }

  section.appendChild(buildFooterHint(
    'Edits land in <code>config.toml</code>. To add a hook by hand: ' +
    '<code>[[hooks]] event = "OnUserPrompt" hookType = "command" target = "/path/to/script"</code>.',
  ));
}

function makeHookCard(h: HookRecord): HTMLElement {
  const event   = h.event || '(unknown event)';
  const ht      = h.hookType || '';
  const tgt     = h.target || (h.source && h.source.path) || '';
  const matcher = (h.matcher !== null && h.matcher !== undefined) ? truncate(stringify(h.matcher), 60) : '';
  const tags: string[] = [];
  if (ht) tags.push(`type: ${ht}`);
  if (matcher) tags.push(`matcher: ${matcher}`);
  const pluginTag = (h.source && h.source.plugin_name) || undefined;
  const fromPlugin = h.source && h.source.type === 'plugin';

  const actions: { label: string; title: string; onClick: (ev: MouseEvent) => Promise<void> }[] = [];
  if (!fromPlugin) {
    actions.push({
      label: 'copy TOML',
      title: 'copy a [[hooks]] block you can paste into config.toml',
      onClick: async (ev: MouseEvent): Promise<void> => {
        const ok = await copyToClipboard(toToml(h));
        const btn = ev.currentTarget as HTMLButtonElement;
        const prior = btn.textContent;
        btn.textContent = ok ? 'copied' : 'copy failed';
        setTimeout(() => { btn.textContent = prior; }, 1500);
      },
    });
  }

  return buildItem({
    primary: event,
    secondary: ht || null,
    tags,
    description: '',
    path: tgt ? shortenPath(tgt) : '',
    sourceLabel: pluginTag
      ? `from plugin: ${pluginTag}`
      : (h.source?.type ? `defined in ${scopeLabel(h.source.type)}:` : 'defined in:'),
    sourcePath: h.source?.path || '',
    fullRecord: h,
    actions,
    pluginTag,
  });
}

function toToml(h: HookRecord): string {
  const lines: string[] = ['[[hooks]]'];
  if (h.event)    lines.push(`event = ${q(h.event)}`);
  if (h.hookType) lines.push(`hookType = ${q(h.hookType)}`);
  if (h.target)   lines.push(`target = ${q(h.target)}`);
  if (h.matcher !== null && h.matcher !== undefined) {
    if (typeof h.matcher === 'string') lines.push(`matcher = ${q(h.matcher)}`);
    else lines.push(`# matcher = ${JSON.stringify(h.matcher)}`);
  }
  return lines.join('\n') + '\n';
}

function q(s: string): string {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function truncate(s: string, n: number): string {
  s = String(s); if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}
