// leaders routes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { send, readJsonBody } from '../helpers.js';
import { runGrok, runGrokJson, runGrokText, errorToResponse } from '../../grok-cli.js';
import type { RouteRegistrar, RouteParams } from '../system.js';

export function register(add: RouteRegistrar): void {
  add('GET',  '/api/system/leaders',                       handleList);
  add('POST', '/api/system/leaders/kill',                  handleKill);
  add('GET',  '/api/system/leaders/:pid',                  handleInfo);
  add('GET',  '/api/system/leaders/:pid/profile/status',   handleProfileStatus);
  add('POST', '/api/system/leaders/:pid/profile/start',    handleProfileStart);
  add('POST', '/api/system/leaders/:pid/profile/stop',     handleProfileStop);
}

function isValidPid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9]+$/.test(s);
}

async function handleList(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = await runGrokJson(['leader', 'list', '--json']);
    send(res, 200, { ok: true, data });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleInfo(_req: IncomingMessage, res: ServerResponse, _url: URL, params?: RouteParams): Promise<void> {
  const pid = (params && params['pid']) || '';
  if (!isValidPid(pid)) {
    send(res, 400, { ok: false, error: 'invalid pid' });
    return;
  }
  try {
    const data = await runGrokJson(['leader', 'info', '--pid', pid, '--json']);
    send(res, 200, { ok: true, data });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleKill(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await runGrok(['leader', 'kill']);
    send(res, 200, { ok: true });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleProfileStatus(_req: IncomingMessage, res: ServerResponse, _url: URL, params?: RouteParams): Promise<void> {
  const pid = (params && params['pid']) || '';
  if (!isValidPid(pid)) {
    send(res, 400, { ok: false, error: 'invalid pid' });
    return;
  }
  try {
    const output = await runGrokText(['leader', 'profile', 'status']);
    send(res, 200, { ok: true, output });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleProfileStart(req: IncomingMessage, res: ServerResponse, _url: URL, params?: RouteParams): Promise<void> {
  const pid = (params && params['pid']) || '';
  if (!isValidPid(pid)) {
    send(res, 400, { ok: false, error: 'invalid pid' });
    return;
  }
  let body: { frequencyHz?: unknown } = {};
  try { body = (await readJsonBody(req) || {}) as { frequencyHz?: unknown }; }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 400, { ok: false, error: msg });
    return;
  }

  const args = ['leader', 'profile', 'start'];
  if (body && body.frequencyHz != null) {
    const hz = Number(body.frequencyHz);
    if (!Number.isFinite(hz) || hz <= 0) {
      send(res, 400, { ok: false, error: 'frequencyHz must be a positive number' });
      return;
    }
    args.push('--frequency-hz', String(Math.floor(hz)));
  }

  try {
    const output = await runGrokText(args);
    send(res, 200, { ok: true, output });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleProfileStop(req: IncomingMessage, res: ServerResponse, _url: URL, params?: RouteParams): Promise<void> {
  const pid = (params && params['pid']) || '';
  if (!isValidPid(pid)) {
    send(res, 400, { ok: false, error: 'invalid pid' });
    return;
  }
  let body: { output?: unknown } = {};
  try { body = (await readJsonBody(req) || {}) as { output?: unknown }; }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 400, { ok: false, error: msg });
    return;
  }

  let out = body && typeof body.output === 'string' ? (body.output as string).trim() : '';
  if (!out) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    out = path.join(os.homedir(), '.grok-remote', `leader-profile-${pid}-${ts}.pprof`);
  }

  try {
    await runGrok(['leader', 'profile', 'stop', '--output', out]);
    send(res, 200, { ok: true, path: out });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}
