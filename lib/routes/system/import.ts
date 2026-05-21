// import routes.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { send, readJsonBody } from '../helpers.js';
import { runGrokJson, errorToResponse } from '../../grok-cli.js';
import type { RouteRegistrar } from '../system.js';

export function register(add: RouteRegistrar): void {
  add('GET',  '/api/system/import', listHandler);
  add('POST', '/api/system/import', importHandler);
}

function toArray(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json === null || json === undefined) return [];
  return [json];
}

async function listHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const json = await runGrokJson(['import', '--list', '--json']);
    send(res, 200, { ok: true, available: toArray(json) });
  } catch (err) {
    send(res, 500, errorToResponse(err));
  }
}

function sanitizeTarget(t: unknown): string | null {
  if (typeof t !== 'string') return null;
  const s = t.trim();
  if (!s) return null;
  if (s.startsWith('-')) return null;
  return s;
}

async function importHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid body';
    send(res, 400, { ok: false, error: msg });
    return;
  }

  const rawTargets = Array.isArray((body as { targets?: unknown })?.targets)
    ? (body as { targets: unknown[] }).targets
    : [];
  const targets = rawTargets.map(sanitizeTarget).filter((s): s is string => Boolean(s));

  const argv = ['import', '--json', ...targets];

  try {
    const json = await runGrokJson(argv, { timeoutMs: 60_000 });
    send(res, 200, { ok: true, events: toArray(json) });
  } catch (err) {
    send(res, 500, errorToResponse(err));
  }
}
