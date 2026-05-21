// Agents (subagents) routes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { send, readJsonBody } from '../helpers.js';
import type { RouteRegistrar } from '../system.js';

const MAX_FILE_BYTES = 1 * 1024 * 1024;

export function register(add: RouteRegistrar): void {
  add('GET',    '/api/system/agents/read',    readFileHandler);
  add('PUT',    '/api/system/agents/content', saveContentHandler);
  add('POST',   '/api/system/agents/file',    createFileHandler);
  add('DELETE', '/api/system/agents/file',    deleteFileHandler);
}

interface AgentRoot { scope: 'workspace' | 'user'; dir: string }

function workspaceRoot(): string {
  return path.join(process.cwd(), '.grok', 'agents');
}
function userRoot(): string {
  return path.join(os.homedir(), '.grok', 'agents');
}
function allRoots(): AgentRoot[] {
  return [
    { scope: 'workspace', dir: workspaceRoot() },
    { scope: 'user',      dir: userRoot()      },
  ];
}
function rootForScope(scope: string): string | null {
  const r = allRoots().find((x) => x.scope === scope);
  return r ? r.dir : null;
}

function isUnderAnyRoot(resolved: string): boolean {
  const roots = allRoots().map((r) => path.resolve(r.dir));
  return roots.some((r) => resolved === r || resolved.startsWith(r + path.sep));
}

function isNodeErr(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in (err as object);
}

function readFileHandler(req: IncomingMessage, res: ServerResponse): void {
  const urlObj = new URL(req.url || '/', 'http://x');
  const target = urlObj.searchParams.get('path') || '';
  if (!target) { send(res, 400, { ok: false, error: 'path required' }); return; }
  const resolved = path.resolve(target);
  if (!isUnderAnyRoot(resolved)) {
    send(res, 400, { ok: false, error: 'path is outside any agents root' });
    return;
  }
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile()) { send(res, 400, { ok: false, error: 'target is not a file' }); return; }
    if (st.size > MAX_FILE_BYTES) {
      send(res, 413, { ok: false, error: 'file too large for inline read' });
      return;
    }
    const content = fs.readFileSync(resolved, 'utf8');
    send(res, 200, {
      ok: true,
      path: resolved,
      size: st.size,
      mtime: st.mtime.toISOString(),
      content,
    });
  } catch (err) {
    if (isNodeErr(err) && err.code === 'ENOENT') {
      send(res, 404, { ok: false, error: 'file not found' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: msg });
  }
}

async function saveContentHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { path?: unknown; content?: unknown };
  try { body = (await readJsonBody(req, MAX_FILE_BYTES)) as { path?: unknown; content?: unknown }; }
  catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid body';
    send(res, 400, { ok: false, error: msg });
    return;
  }
  const target = typeof body.path === 'string' ? body.path : '';
  const content = body.content;
  if (!target) { send(res, 400, { ok: false, error: 'path required' }); return; }
  if (typeof content !== 'string') {
    send(res, 400, { ok: false, error: 'content must be a string' });
    return;
  }
  const resolved = path.resolve(target);
  if (!isUnderAnyRoot(resolved)) {
    send(res, 400, { ok: false, error: 'path is outside any agents root' });
    return;
  }
  if (!resolved.endsWith('.md')) {
    send(res, 400, { ok: false, error: 'only .md files can be written' });
    return;
  }
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    atomicWrite(resolved, content);
    const st = fs.statSync(resolved);
    send(res, 200, {
      ok: true,
      path: resolved,
      size: st.size,
      mtime: st.mtime.toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: msg });
  }
}

async function createFileHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { scope?: unknown; name?: unknown; content?: unknown };
  try { body = (await readJsonBody(req, MAX_FILE_BYTES)) as { scope?: unknown; name?: unknown; content?: unknown }; }
  catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid body';
    send(res, 400, { ok: false, error: msg });
    return;
  }
  const scope = typeof body.scope === 'string' ? body.scope : '';
  const nameIn = typeof body.name === 'string' ? body.name : '';
  const content = typeof body.content === 'string' ? body.content : '';
  if (!scope || !nameIn) {
    send(res, 400, { ok: false, error: 'scope and name required' });
    return;
  }
  const rootDir = rootForScope(scope);
  if (!rootDir) { send(res, 400, { ok: false, error: `unknown scope: ${scope}` }); return; }

  const name = nameIn.endsWith('.md') ? nameIn : (nameIn + '.md');
  if (!safeFileName(name)) {
    send(res, 400, { ok: false, error: 'invalid name (use letters, digits, dash, underscore, dot)' });
    return;
  }
  const full = path.resolve(path.join(rootDir, name));
  if (!isUnderAnyRoot(full)) {
    send(res, 400, { ok: false, error: 'resolved path is outside agents root' });
    return;
  }
  const stem = name.replace(/\.md$/, '');
  const finalContent = content || stubAgentBody(stem);
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fs.existsSync(full)) {
      send(res, 409, { ok: false, error: 'file already exists' });
      return;
    }
    atomicWrite(full, finalContent);
    const st = fs.statSync(full);
    send(res, 200, {
      ok: true, scope, name, path: full,
      size: st.size, mtime: st.mtime.toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: msg });
  }
}

function deleteFileHandler(req: IncomingMessage, res: ServerResponse): void {
  const urlObj = new URL(req.url || '/', 'http://x');
  const target = urlObj.searchParams.get('path') || '';
  if (!target) { send(res, 400, { ok: false, error: 'path required' }); return; }
  const resolved = path.resolve(target);
  if (!isUnderAnyRoot(resolved)) {
    send(res, 400, { ok: false, error: 'path is outside any agents root' });
    return;
  }
  if (allRoots().some((r) => path.resolve(r.dir) === resolved)) {
    send(res, 400, { ok: false, error: 'cannot delete the agents root' });
    return;
  }
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile()) { send(res, 400, { ok: false, error: 'target is not a file' }); return; }
    fs.unlinkSync(resolved);
    send(res, 200, { ok: true, path: resolved });
  } catch (err) {
    if (isNodeErr(err) && err.code === 'ENOENT') {
      send(res, 404, { ok: false, error: 'file not found' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: msg });
  }
}

function atomicWrite(targetPath: string, content: string): void {
  const tmp = targetPath + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, targetPath);
}

function safeFileName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  if (!name) return false;
  if (name === '.' || name === '..') return false;
  if (name.startsWith('.')) return false;
  if (/[\/\\]/.test(name)) return false;
  if (name.length > 128) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name)) return false;
  return true;
}

function stubAgentBody(stem: string): string {
  return [
    '---',
    `name: ${stem}`,
    `description: TODO describe what this subagent is for and when to use it.`,
    `model: inherit`,
    `tools: ["*"]`,
    '---',
    '',
    `You are a focused subagent named "${stem}".`,
    '',
    'Describe the subagent\'s job, the inputs it receives, and the format of',
    'its final reply. Keep this section tight; the parent agent only sees',
    'what you produce at the end.',
    '',
  ].join('\n');
}
