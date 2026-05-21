// Registry of pages routed by the dashboard.

import * as mcp       from './mcp.js';
import * as leaders   from './leaders.js';
import * as worktrees from './worktrees.js';
import * as memory    from './memory.js';
import * as models    from './models.js';
import * as health    from './health.js';
import * as sessions  from './sessions.js';
import * as importV   from './import.js';
import * as flow      from './flow.js';
import * as setup     from './setup.js';
import * as skills    from './skills.js';
import * as hooks        from './hooks.js';
import * as nativeAgents from './agents.js';
import * as plugins      from './plugins.js';
import * as marketplaces from './marketplaces.js';
import * as lsp          from './lsp.js';

export interface PageModule {
  mount?(container: HTMLElement, ctx?: unknown): void;
  unmount?(): void;
}

export interface PageEntry {
  area: string;
  label: string;
  iconName?: string;
  module?: PageModule;
}

export interface SettingsSection {
  title: string;
  items: PageEntry[];
}

export const SYSTEM_PAGES: PageEntry[] = [
  { area: 'memory',   label: 'memory',    iconName: 'memory',   module: memory   as PageModule },
  { area: 'leaders',  label: 'leaders',   iconName: 'leaders',  module: leaders  as PageModule },
  { area: 'sessions', label: 'sessions',  iconName: 'sessions', module: sessions as PageModule },
  { area: 'health',   label: 'health',    iconName: 'health',   module: health   as PageModule },
  { area: 'flow',     label: 'live flow', iconName: 'flow',     module: flow     as PageModule },
];

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    title: 'general',
    items: [
      { area: 'general',  label: 'general',       iconName: 'settings' },
    ],
  },
  {
    title: 'native config',
    items: [
      { area: 'skills',       label: 'skills',       iconName: 'skills',   module: skills       as PageModule },
      { area: 'subagents',    label: 'subagents',    iconName: 'leaders',  module: nativeAgents as PageModule },
      { area: 'hooks',        label: 'hooks',        iconName: 'flow',     module: hooks        as PageModule },
      { area: 'plugins',      label: 'plugins',      iconName: 'mcp',      module: plugins      as PageModule },
      { area: 'marketplaces', label: 'marketplaces', iconName: 'import',   module: marketplaces as PageModule },
      { area: 'mcp',          label: 'mcp servers',  iconName: 'mcp',      module: mcp          as PageModule },
      { area: 'lsp',          label: 'lsp servers',  iconName: 'models',   module: lsp          as PageModule },
      { area: 'models',       label: 'models',       iconName: 'models',   module: models       as PageModule },
    ],
  },
  {
    title: 'tools',
    items: [
      { area: 'worktrees', label: 'worktrees', iconName: 'worktrees', module: worktrees as PageModule },
      { area: 'import',    label: 'import',    iconName: 'import',    module: importV   as PageModule },
      { area: 'setup',     label: 'setup',     iconName: 'setup',     module: setup     as PageModule },
    ],
  },
];

export const SETTINGS_PAGES: PageEntry[] = SETTINGS_SECTIONS.flatMap((s) => s.items);
export const ALL_PAGES: PageEntry[] = [...SYSTEM_PAGES, ...SETTINGS_PAGES];

export function getSystemPage(area: string): PageEntry | null {
  return SYSTEM_PAGES.find((p) => p.area === area) || null;
}

export function getSettingsPage(area: string): PageEntry | null {
  return SETTINGS_PAGES.find((p) => p.area === area) || null;
}

export function getAnyPage(area: string): PageEntry | null {
  return ALL_PAGES.find((p) => p.area === area) || null;
}
