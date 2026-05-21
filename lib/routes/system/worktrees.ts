// worktrees routes.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { send, readJsonBody } from '../helpers.js';
import { runGrok, runGrokJson, runGrokText, errorToResponse } from '../../grok-cli.js';
import type { RouteRegistrar, RouteParams } from '../system.js';

export function register(add: RouteRegistrar): void {
  add('GET',    '/api/system/worktrees',              handleList);
  add('GET',    '/api/system/worktrees/db/stats',     handleDbStats);
  add('GET',    '/api/system/worktrees/db/path',      handleDbPath);
  add('POST',   '/api/system/worktrees/db/rebuild',   handleDbRebuild);
  add('POST',   '/api/system/worktrees/gc',           handleGc);
  add('GET',    '/api/system/worktrees/:id',          handleShow);
  add('DELETE', '/api/system/worktrees/:id',          handleRm);
}

function isValidId(s: unknown): s is string {
  if (typeof s !== 'string' || !s.length) return false;
  if (/[\s;&|`$<>"'\\]/.test(s)) return false;
  return true;
}

async function handleList(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const args = ['worktree', 'list', '--json'];
  const params = url && url.searchParams ? url.searchParams : new URLSearchParams();
  if (params.get('all') === '1') args.push('--all');
  const repo = params.get('repo');
  if (repo) args.push('--repo', repo);
  const type = params.get('type');
  if (type) args.push('--type', type);
  try {
    const data = await runGrokJson(args);
    send(res, 200, { ok: true, data });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleShow(_req: IncomingMessage, res: ServerResponse, _url: URL, params?: RouteParams): Promise<void> {
  const id = (params && params['id']) || '';
  if (!isValidId(id)) {
    send(res, 400, { ok: false, error: 'invalid worktree id' });
    return;
  }
  try {
    const output = await runGrokText(['worktree', 'show', id]);
    send(res, 200, { ok: true, output });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleRm(_req: IncomingMessage, res: ServerResponse, url: URL, params?: RouteParams): Promise<void> {
  const id = (params && params['id']) || '';
  if (!isValidId(id)) {
    send(res, 400, { ok: false, error: 'invalid worktree id' });
    return;
  }
  const q = url && url.searchParams ? url.searchParams : new URLSearchParams();
  const args = ['worktree', 'rm'];
  if (q.get('force') === '1') args.push('-f');
  if (q.get('dryRun') === '1') args.push('--dry-run');
  args.push(id);
  try {
    const output = await runGrokText(args);
    send(res, 200, { ok: true, output });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

interface GcBody {
  dryRun?: boolean;
  force?: boolean;
  maxAge?: string;
}

async function handleGc(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: GcBody = {};
  try { body = (await readJsonBody(req) || {}) as GcBody; }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 400, { ok: false, error: msg });
    return;
  }

  const args = ['worktree', 'gc'];
  if (body && body.dryRun) args.push('--dry-run');
  if (body && body.force) args.push('-f');
  if (body && typeof body.maxAge === 'string' && body.maxAge.trim()) {
    if (!/^[0-9a-zA-Z]+$/.test(body.maxAge.trim())) {
      send(res, 400, { ok: false, error: 'maxAge must be alphanumeric (e.g. 7d, 48h)' });
      return;
    }
    args.push('--max-age', body.maxAge.trim());
  }

  try {
    const output = await runGrokText(args);
    send(res, 200, { ok: true, output });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleDbStats(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const output = await runGrokText(['worktree', 'db', 'stats']);
    send(res, 200, { ok: true, output });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleDbPath(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const output = await runGrokText(['worktree', 'db', 'path']);
    send(res, 200, { ok: true, output: output.trim() });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}

async function handleDbRebuild(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const output = await runGrokText(['worktree', 'db', 'rebuild']);
    send(res, 200, { ok: true, output });
  } catch (err) {
    send(res, 502, errorToResponse(err));
  }
}
