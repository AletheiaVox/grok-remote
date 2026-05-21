// Health routes.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { send } from '../helpers.js';
import { runGrokJson, errorToResponse } from '../../grok-cli.js';
import type { RouteRegistrar } from '../system.js';

export function register(add: RouteRegistrar): void {
  add('GET',  '/api/system/health',         getHandler);
  add('POST', '/api/system/health/recheck', getHandler);
}

interface ServerInfo {
  node: string;
  platform: NodeJS.Platform;
  uptimeSeconds: number;
}

interface HealthPayload {
  inspect: unknown;
  version: unknown;
  update:  unknown;
  server:  ServerInfo;
  inspectError?: string;
  versionError?: string;
  updateError?:  string;
}

function serverInfo(): ServerInfo {
  return {
    node:           process.version,
    platform:       process.platform,
    uptimeSeconds:  Math.floor(process.uptime()),
  };
}

interface SafeJsonOk { ok: true; value: unknown }
interface SafeJsonErr { ok: false; error: { error: string } }

async function safeJson(args: string[]): Promise<SafeJsonOk | SafeJsonErr> {
  try {
    return { ok: true, value: await runGrokJson(args) };
  } catch (err) {
    return { ok: false, error: errorToResponse(err) };
  }
}

async function collect(): Promise<HealthPayload> {
  const [inspectRes, versionRes, updateRes] = await Promise.all([
    safeJson(['inspect', '--json']),
    safeJson(['version', '--json']),
    safeJson(['update', '--check', '--json']),
  ]);

  const payload: HealthPayload = {
    inspect: inspectRes.ok ? inspectRes.value : null,
    version: versionRes.ok ? versionRes.value : null,
    update:  updateRes.ok ? updateRes.value : null,
    server:  serverInfo(),
  };

  if (!inspectRes.ok) payload.inspectError = inspectRes.error?.error || 'inspect failed';
  if (!versionRes.ok) payload.versionError = versionRes.error?.error || 'version failed';
  if (!updateRes.ok)  payload.updateError  = updateRes.error?.error  || 'update check failed';

  return payload;
}

async function getHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await collect();
    send(res, 200, { ok: true, ...data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: msg });
  }
}
