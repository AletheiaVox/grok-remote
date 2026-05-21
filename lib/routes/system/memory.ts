// Memory routes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { send, readJsonBody } from '../helpers.js';
import { runGrok, errorToResponse } from '../../grok-cli.js';
import type { RouteRegistrar } from '../system.js';

const SNIPPET_BYTES = 240;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export function register(add: RouteRegistrar): void {
  add('GET',    '/api/system/memory',         getHandler);
  add('GET',    '/api/system/memory/read',    readFileHandler);
  add('POST',   '/api/system/memory/clear',   clearHandler);
  add('PUT',    '/api/system/memory/content', saveContentHandler);
  add('POST',   '/api/system/memory/file',    createFileHandler);
  add('DELETE', '/api/system/memory/file',    deleteFileHandler);
}

type MemoryScope = 'workspace' | 'global';

interface MemoryRoot { scope: MemoryScope; dir: string }

interface FileRecord {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  mtime?: string;
  snippet: string;
  error?: string;
}

interface RootListing {
  scope: MemoryScope;
  dir: string;
  exists: boolean;
  files: FileRecord[];
  error?: string;
}

interface CompatBlock {
  path: string;
  exists: boolean;
  size: number;
  mtime: string | null;
}

function workspaceRoot(): string {
  return path.join(process.cwd(), '.grok', 'memory');
}

function globalRoot(): string {
  return path.join(os.homedir(), '.grok', 'memory');
}

function allRoots(): MemoryRoot[] {
  return [
    { scope: 'workspace', dir: workspaceRoot() },
    { scope: 'global',    dir: globalRoot()    },
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

async function getHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const roots = await Promise.all(allRoots().map(buildRootListing));
    const compat: Record<string, CompatBlock> = {};
    for (const r of roots) {
      compat[r.scope] = compatBlock(r);
    }
    send(res, 200, { ok: true, roots, ...compat });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: msg });
  }
}

async function buildRootListing(root: MemoryRoot): Promise<RootListing> {
  const out: RootListing = {
    scope:   root.scope,
    dir:     root.dir,
    exists:  false,
    files:   [],
  };
  let entries;
  try {
    entries = await fsp.readdir(root.dir, { withFileTypes: true });
    out.exists = true;
  } catch (err) {
    if (isNodeErr(err) && err.code === 'ENOENT') {
      return out;
    }
    out.error = err instanceof Error ? err.message : String(err);
    return out;
  }
  const fileEntries = entries.filter((e) => e.isFile() && e.name.endsWith('.md'));
  const records = await Promise.all(fileEntries.map(async (e) => {
    const full = path.join(root.dir, e.name);
    return readFileMeta(full, e.name);
  }));
  records.sort((a, b) => {
    if (a.name === 'MEMORY.md' && b.name !== 'MEMORY.md') return -1;
    if (b.name === 'MEMORY.md' && a.name !== 'MEMORY.md') return 1;
    return a.name.localeCompare(b.name);
  });
  out.files = records;
  return out;
}

async function readFileMeta(full: string, name: string): Promise<FileRecord> {
  const rec: FileRecord = { path: full, name, size: 0, mtimeMs: 0, snippet: '' };
  try {
    const st = await fsp.stat(full);
    rec.size    = st.size;
    rec.mtimeMs = st.mtimeMs;
    rec.mtime   = st.mtime.toISOString();
    if (st.size > 0) {
      const fh = await fsp.open(full, 'r');
      try {
        const buf = Buffer.alloc(Math.min(SNIPPET_BYTES, st.size));
        await fh.read(buf, 0, buf.length, 0);
        rec.snippet = buf.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 200);
      } finally {
        await fh.close().catch(() => { /* ignore */ });
      }
    }
  } catch (err) {
    rec.error = err instanceof Error ? err.message : String(err);
  }
  return rec;
}

function compatBlock(root: RootListing): CompatBlock {
  const mdPath = path.join(root.dir, 'MEMORY.md');
  const rec = (root.files || []).find((f) => f.name === 'MEMORY.md');
  if (!rec) {
    return { path: mdPath, exists: false, size: 0, mtime: null };
  }
  return {
    path:   rec.path,
    exists: true,
    size:   rec.size,
    mtime:  rec.mtime || null,
  };
}

function readFileHandler(req: IncomingMessage, res: ServerResponse): void {
  const urlObj = new URL(req.url || '/', 'http://x');
  const target = urlObj.searchParams.get('path') || '';
  if (!target) { send(res, 400, { ok: false, error: 'path required' }); return; }
  const resolved = path.resolve(target);
  if (!isUnderAnyRoot(resolved)) {
    send(res, 400, { ok: false, error: 'path is outside any memory root' });
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

async function clearHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { scope?: unknown };
  try {
    body = (await readJsonBody(req)) as { scope?: unknown };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid body';
    send(res, 400, { ok: false, error: msg });
    return;
  }

  const scope = typeof body.scope === 'string' ? body.scope : '';
  let scopeFlag: string | null = null;
  if (scope === 'workspace') scopeFlag = '--workspace';
  else if (scope === 'global') scopeFlag = '--global';
  else if (scope === 'all') scopeFlag = '--all';
  else {
    send(res, 400, { ok: false, error: 'scope must be one of workspace, global, all' });
    return;
  }

  try {
    await runGrok(['memory', 'clear', scopeFlag, '-y']);
  } catch (err) {
    send(res, 500, errorToResponse(err));
    return;
  }

  try {
    const roots = await Promise.all(allRoots().map(buildRootListing));
    const compat: Record<string, CompatBlock> = {};
    for (const r of roots) compat[r.scope] = compatBlock(r);
    send(res, 200, { ok: true, roots, ...compat });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 200, { ok: true, warning: msg });
  }
}

async function saveContentHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { path?: unknown; content?: unknown };
  try {
    body = (await readJsonBody(req, MAX_FILE_BYTES)) as { path?: unknown; content?: unknown };
  } catch (err) {
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
    send(res, 400, { ok: false, error: 'path is outside any memory root' });
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

function atomicWrite(targetPath: string, content: string): void {
  const tmp = targetPath + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, targetPath);
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
    send(res, 400, { ok: false, error: 'invalid name (kebab-case .md only)' });
    return;
  }

  const full = path.resolve(path.join(rootDir, name));
  if (!isUnderAnyRoot(full)) {
    send(res, 400, { ok: false, error: 'resolved path is outside the memory root' });
    return;
  }
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (fs.existsSync(full)) {
      send(res, 409, { ok: false, error: 'file already exists' });
      return;
    }
    atomicWrite(full, content);
    const st = fs.statSync(full);
    send(res, 200, {
      ok: true,
      scope,
      path: full,
      name,
      size: st.size,
      mtime: st.mtime.toISOString(),
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
    send(res, 400, { ok: false, error: 'path is outside any memory root' });
    return;
  }
  if (allRoots().some((r) => path.resolve(r.dir) === resolved)) {
    send(res, 400, { ok: false, error: 'cannot delete the memory root' });
    return;
  }
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile()) {
      send(res, 400, { ok: false, error: 'target is not a file' });
      return;
    }
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

function safeFileName(name: string | null | undefined): boolean {
  if (typeof name !== 'string') return false;
  if (!name) return false;
  if (name === '.' || name === '..') return false;
  if (name.startsWith('.')) return false;
  if (/[\/\\]/.test(name)) return false;
  if (name.length > 200) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name)) return false;
  return true;
}
