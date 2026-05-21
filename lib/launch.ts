import { bindHostForMode, modeFromArgs, pm2EnvForMode } from './install-mode.js';
import type { InstallMode } from './install-mode.js';

export interface Pm2Record {
  pm2_env?: {
    HOST?: string;
    env?: { HOST?: string };
    pm2_env?: { HOST?: string };
  };
}

export interface TailnetInfo {
  available?: boolean;
  url?: string | null;
}

export interface ModeForLaunchInputs {
  args?: string[];
  tailnetAvailable?: boolean;
}

export interface DashboardUrlInputs {
  port?: number;
  configuredHost?: string;
  tailnet?: TailnetInfo;
}

export function localUrlForPort(port: number = 7910): string {
  return `http://localhost:${port}`;
}

export function pm2ConfiguredHost(record: Pm2Record | null | undefined): string {
  const env = record?.pm2_env || {};
  return env.HOST || env.env?.HOST || env.pm2_env?.HOST || '';
}

export function modeForLaunch(
  { args = [], tailnetAvailable = false }: ModeForLaunchInputs = {},
): InstallMode {
  const explicit = modeFromArgs(args);
  if (explicit) return explicit;
  return tailnetAvailable ? 'tailnet' : 'local';
}

export function launchEnvForMode(
  mode: InstallMode | string | null | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...pm2EnvForMode(mode, baseEnv),
    HOST: bindHostForMode(mode),
  };
}

export function dashboardUrlFor(
  { port = 7910, configuredHost = '', tailnet = {} }: DashboardUrlInputs = {},
): string {
  const localURL = localUrlForPort(port);
  const host = String(configuredHost || '').toLowerCase();
  if (host === '127.0.0.1' || host === 'localhost') return localURL;
  if (tailnet.available && tailnet.url) return tailnet.url;
  return localURL;
}

export function healthUrlForDashboard(url: string): string {
  return new URL('/api/health', url).toString();
}
