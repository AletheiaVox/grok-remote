// Skills routes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { send, readJsonBody } from '../helpers.js';
import type { RouteRegistrar } from '../system.js';

const HISTORY_DIR_NAME = '.history';
const HISTORY_CAP      = 50;
const USAGE_FILE       = path.join(os.homedir(), '.grok-remote', 'skill-usage.json');

type SkillScope = 'cwd' | 'repo' | 'user-grok' | 'user-claude';

interface SkillSource { scope: SkillScope; dir: string | null }

interface UsageEntry {
  count?: number;
  lastUsedAt?: string | null;
  lastAgentId?: string | null;
}

type UsageMap = Record<string, UsageEntry>;

interface SkillRecord {
  scope: SkillScope;
  name: string;
  dir: string;
  mdPath: string;
  title: string;
  description: string;
  shortDescription: string;
  otherFiles: string[];
  mtime: string | null;
  archived: boolean;
  usageCount: number;
  lastUsedAt: string | null;
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  shortDescription?: string;
}

interface HistoryEntry {
  ts: string;
  file: string;
  size: number;
}

export function register(add: RouteRegistrar): void {
  add('GET',  '/api/system/skills',                 listHandler);
  add('GET',  '/api/system/skills/read',            readHandler);
  add('POST', '/api/system/skills/archive',         archiveHandler);
  add('POST', '/api/system/skills/restore',         restoreHandler);
  add('POST', '/api/system/skills/move',            moveHandler);
  add('PUT',  '/api/system/skills/content',         saveContentHandler);
  add('GET',  '/api/system/skills/history',         historyListHandler);
  add('GET',  '/api/system/skills/history/content', historySnapshotHandler);
  add('POST', '/api/system/skills/history/restore', historyRestoreHandler);
  add('POST', '/api/system/skills/use',             useHandler);
  add('GET',  '/api/system/skills/usage',           usageHandler);
}

function isNodeErr(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in (err as object);
}

function activeSources(): { scope: SkillScope; dir: string }[] {
  const cwd = process.cwd();
  const home = os.homedir();
  const repo = findRepoRoot(cwd);
  const sources: SkillSource[] = [
    { scope: 'cwd',         dir: path.join(cwd, '.grok', 'skills') },
    { scope: 'repo',        dir: repo ? path.join(repo, '.grok', 'skills') : null },
    { scope: 'user-grok',   dir: path.join(home, '.grok', 'skills') },
    { scope: 'user-claude', dir: path.join(home, '.claude', 'skills') },
  ];
  const present = sources.filter((s): s is { scope: SkillScope; dir: string } =>
    Boolean(s.dir) && safeIsDir(s.dir as string));
  return present.filter((s, i, arr) =>
    arr.findIndex((x) => path.resolve(x.dir) === path.resolve(s.dir)) === i);
}

function allScopes(): { scope: SkillScope; dir: string }[] {
  const cwd = process.cwd();
  const home = os.homedir();
  const repo = findRepoRoot(cwd);
  const sources: SkillSource[] = [
    { scope: 'cwd',         dir: path.join(cwd, '.grok', 'skills') },
    { scope: 'repo',        dir: repo ? path.join(repo, '.grok', 'skills') : null },
    { scope: 'user-grok',   dir: path.join(home, '.grok', 'skills') },
    { scope: 'user-claude', dir: path.join(home, '.claude', 'skills') },
  ];
  return sources.filter((s): s is { scope: SkillScope; dir: string } => Boolean(s.dir));
}

function scopeDir(scope: string): string | null {
  const s = allScopes().find((x) => x.scope === scope);
  return s ? s.dir : null;
}

function archiveDirForScope(scope: string): string | null {
  const dir = scopeDir(scope);
  if (!dir) return null;
  return dir + '.archive';
}

function listHandler(req: IncomingMessage, res: ServerResponse): void {
  const urlObj = new URL(req.url || '/', 'http://x');
  const includeArchived = urlObj.searchParams.get('includeArchived') === '1';
  const sources = activeSources();
  const usage = readUsageMap();

  const skills: SkillRecord[] = [];
  for (const { scope, dir } of sources) {
    for (const name of safeReaddir(dir)) {
      const skillDir = path.join(dir, name);
      try {
        if (!fs.statSync(skillDir).isDirectory()) continue;
      } catch { continue; }
      const mdPath = path.join(skillDir, 'SKILL.md');
      if (!safeIsFile(mdPath)) continue;
      skills.push(buildSkillRecord({
        scope, name, skillDir, mdPath, archived: false, usage,
      }));
    }
  }

  if (includeArchived) {
    for (const { scope } of allScopes()) {
      const adir = archiveDirForScope(scope);
      if (!adir || !safeIsDir(adir)) continue;
      for (const name of safeReaddir(adir)) {
        const skillDir = path.join(adir, name);
        try {
          if (!fs.statSync(skillDir).isDirectory()) continue;
        } catch { continue; }
        const mdPath = path.join(skillDir, 'SKILL.md');
        if (!safeIsFile(mdPath)) continue;
        skills.push(buildSkillRecord({
          scope, name, skillDir, mdPath, archived: true, usage,
        }));
      }
    }
  }

  send(res, 200, {
    ok: true,
    skills,
    sources: sources.map((s) => ({ scope: s.scope, dir: s.dir })),
  });
}

interface BuildSkillArgs {
  scope: SkillScope;
  name: string;
  skillDir: string;
  mdPath: string;
  archived: boolean;
  usage: UsageMap;
}

function buildSkillRecord({ scope, name, skillDir, mdPath, archived, usage }: BuildSkillArgs): SkillRecord {
  const parsed = parseSkillHeader(mdPath);
  const u: UsageEntry | null = (usage && usage[name]) || null;
  return {
    scope,
    name,
    dir: skillDir,
    mdPath,
    title:            parsed.name || name,
    description:      parsed.description || '',
    shortDescription: parsed.shortDescription || '',
    otherFiles: safeReaddir(skillDir).filter((f) => f !== 'SKILL.md' && f !== HISTORY_DIR_NAME),
    mtime: safeMtime(mdPath),
    archived: !!archived,
    usageCount: u ? (u.count || 0) : 0,
    lastUsedAt: u ? (u.lastUsedAt || null) : null,
  };
}

function readHandler(req: IncomingMessage, res: ServerResponse): void {
  const urlObj = new URL(req.url || '/', 'http://x');
  const target = urlObj.searchParams.get('path') || '';
  if (!target) { send(res, 400, { ok: false, error: 'path required' }); return; }
  const resolved = path.resolve(target);

  if (!isUnderAnySkillRoot(resolved)) {
    send(res, 400, { ok: false, error: 'path is outside any skill directory' });
    return;
  }
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) { send(res, 400, { ok: false, error: 'target is not a file' }); return; }
    if (stat.size > 1024 * 1024) { send(res, 413, { ok: false, error: 'file too large for inline read (>1MB)' }); return; }
    const content = fs.readFileSync(resolved, 'utf8');
    send(res, 200, { ok: true, path: resolved, size: stat.size, mtime: stat.mtime.toISOString(), content });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 404, { ok: false, error: msg });
  }
}

function isUnderAnySkillRoot(resolved: string): boolean {
  const home = os.homedir();
  const roots: string[] = [];
  for (const s of allScopes()) {
    roots.push(s.dir);
    roots.push(s.dir + '.archive');
  }
  roots.push(path.resolve(process.cwd(), '.grok', 'skills'));
  roots.push(path.join(home, '.grok', 'skills'));
  roots.push(path.join(home, '.claude', 'skills'));
  return roots.some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

interface ScopeNameBody { scope?: unknown; name?: unknown }

async function archiveHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: ScopeNameBody;
  try { body = (await readJsonBody(req)) as ScopeNameBody; }
  catch (err) { const msg = err instanceof Error ? err.message : String(err); send(res, 400, { ok: false, error: msg }); return; }
  const scope = typeof body.scope === 'string' ? body.scope : '';
  const name  = typeof body.name  === 'string' ? body.name  : '';
  if (!scope || !name) { send(res, 400, { ok: false, error: 'scope and name required' }); return; }
  if (!safeName(name)) { send(res, 400, { ok: false, error: 'invalid name' }); return; }

  const sdir = scopeDir(scope);
  const adir = archiveDirForScope(scope);
  if (!sdir || !adir) { send(res, 400, { ok: false, error: `unknown scope: ${scope}` }); return; }

  const from = path.join(sdir, name);
  const to   = path.join(adir, name);
  if (!safeIsDir(from)) { send(res, 404, { ok: false, error: `skill not found: ${scope}/${name}` }); return; }
  if (safeIsDir(to))    { send(res, 409, { ok: false, error: `archive already has ${scope}/${name}` }); return; }

  try {
    fs.mkdirSync(adir, { recursive: true });
    fs.renameSync(from, to);
    send(res, 200, { ok: true, scope, name, archived: true, archivedDir: to });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: msg });
  }
}

async function restoreHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: ScopeNameBody;
  try { body = (await readJsonBody(req)) as ScopeNameBody; }
  catch (err) { const msg = err instanceof Error ? err.message : String(err); send(res, 400, { ok: false, error: msg }); return; }
  const scope = typeof body.scope === 'string' ? body.scope : '';
  const name  = typeof body.name  === 'string' ? body.name  : '';
  if (!scope || !name) { send(res, 400, { ok: false, error: 'scope and name required' }); return; }
  if (!safeName(name)) { send(res, 400, { ok: false, error: 'invalid name' }); return; }

  const sdir = scopeDir(scope);
  const adir = archiveDirForScope(scope);
  if (!sdir || !adir) { send(res, 400, { ok: false, error: `unknown scope: ${scope}` }); return; }

  const from = path.join(adir, name);
  const to   = path.join(sdir, name);
  if (!safeIsDir(from)) { send(res, 404, { ok: false, error: `archived skill not found: ${scope}/${name}` }); return; }
  if (safeIsDir(to))    { send(res, 409, { ok: false, error: `active scope already has ${scope}/${name}` }); return; }

  try {
    fs.mkdirSync(sdir, { recursive: true });
    fs.renameSync(from, to);
    send(res, 200, { ok: true, scope, name, archived: false, restoredDir: to });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: msg });
  }
}

async function moveHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { scope?: unknown; name?: unknown; toScope?: unknown };
  try { body = (await readJsonBody(req)) as { scope?: unknown; name?: unknown; toScope?: unknown }; }
  catch (err) { const msg = err instanceof Error ? err.message : String(err); send(res, 400, { ok: false, error: msg }); return; }
  const scope   = typeof body.scope === 'string' ? body.scope : '';
  const name    = typeof body.name  === 'string' ? body.name  : '';
  const toScope = typeof body.toScope === 'string' ? body.toScope : '';
  if (!scope || !name || !toScope) { send(res, 400, { ok: false, error: 'scope, name, toScope required' }); return; }
  if (scope === toScope) { send(res, 400, { ok: false, error: 'toScope equals scope' }); return; }
  if (!safeName(name))   { send(res, 400, { ok: false, error: 'invalid name' }); return; }

  const fromBase = scopeDir(scope);
  const toBase   = scopeDir(toScope);
  if (!fromBase) { send(res, 400, { ok: false, error: `unknown scope: ${scope}` }); return; }
  if (!toBase)   { send(res, 400, { ok: false, error: `unknown toScope: ${toScope}` }); return; }

  const from = path.join(fromBase, name);
  const to   = path.join(toBase,   name);
  if (!safeIsDir(from)) { send(res, 404, { ok: false, error: `skill not found: ${scope}/${name}` }); return; }
  if (safeIsDir(to))    { send(res, 409, { ok: false, error: `destination already has ${toScope}/${name}` }); return; }

  try {
    fs.mkdirSync(toBase, { recursive: true });
    fs.renameSync(from, to);
    send(res, 200, { ok: true, scope: toScope, name, dir: to });
  } catch (err) {
    if (isNodeErr(err) && err.code === 'EXDEV') {
      try {
        copyRecursive(from, to);
        fs.rmSync(from, { recursive: true, force: true });
        send(res, 200, { ok: true, scope: toScope, name, dir: to, fallback: 'copy' });
        return;
      } catch (err2) {
        const msg = err2 instanceof Error ? err2.message : String(err2);
        send(res, 500, { ok: false, error: msg });
        return;
      }
    }
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: msg });
  }
}

async function saveContentHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { scope?: unknown; name?: unknown; content?: unknown };
  try { body = (await readJsonBody(req, 4 * 1024 * 1024)) as { scope?: unknown; name?: unknown; content?: unknown }; }
  catch (err) { const msg = err instanceof Error ? err.message : String(err); send(res, 400, { ok: false, error: msg }); return; }
  const scope   = typeof body.scope === 'string' ? body.scope : '';
  const name    = typeof body.name  === 'string' ? body.name  : '';
  const content = body.content;
  if (!scope || !name) { send(res, 400, { ok: false, error: 'scope and name required' }); return; }
  if (typeof content !== 'string') { send(res, 400, { ok: false, error: 'content must be a string' }); return; }
  if (!safeName(name)) { send(res, 400, { ok: false, error: 'invalid name' }); return; }

  const sdir = scopeDir(scope);
  if (!sdir) { send(res, 400, { ok: false, error: `unknown scope: ${scope}` }); return; }
  const skillDir = path.join(sdir, name);
  if (!safeIsDir(skillDir)) { send(res, 404, { ok: false, error: `skill not found: ${scope}/${name}` }); return; }
  const mdPath = path.join(skillDir, 'SKILL.md');

  const parsed = parseFrontmatterFromText(content);
  if (!parsed || !parsed.name) {
    send(res, 400, { ok: false, error: 'frontmatter missing `name:` field' });
    return;
  }
  if (parsed.name !== name) {
    send(res, 400, { ok: false, error: `frontmatter name (${parsed.name}) does not match skill name (${name})` });
    return;
  }

  try {
    if (safeIsFile(mdPath)) {
      try { snapshotIntoHistory(skillDir, mdPath); }
      catch { /* non-fatal */ }
    }
    atomicWrite(mdPath, content);
    const stat = fs.statSync(mdPath);
    send(res, 200, {
      ok: true, scope, name, path: mdPath,
      size: stat.size, mtime: stat.mtime.toISOString(),
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

function historyDirFor(skillDir: string): string {
  return path.join(skillDir, HISTORY_DIR_NAME);
}

function snapshotIntoHistory(skillDir: string, mdPath: string): void {
  const histDir = historyDirFor(skillDir);
  fs.mkdirSync(histDir, { recursive: true });
  const ts = new Date().toISOString().replace(/:/g, '-');
  const dest = path.join(histDir, ts + '.md');
  const prior = fs.readFileSync(mdPath, 'utf8');
  fs.writeFileSync(dest, prior, 'utf8');
  pruneHistory(histDir);
}

function pruneHistory(histDir: string): void {
  let entries: string[] = [];
  try { entries = fs.readdirSync(histDir); } catch { return; }
  entries = entries.filter((f) => f.endsWith('.md')).sort();
  if (entries.length <= HISTORY_CAP) return;
  const toDrop = entries.slice(0, entries.length - HISTORY_CAP);
  for (const f of toDrop) {
    try { fs.unlinkSync(path.join(histDir, f)); } catch { /* ignore */ }
  }
}

function listHistory(skillDir: string): HistoryEntry[] {
  const histDir = historyDirFor(skillDir);
  let entries: string[] = [];
  try { entries = fs.readdirSync(histDir); } catch { return []; }
  return entries
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .map((f) => {
      const full = path.join(histDir, f);
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* ignore */ }
      const stem = f.slice(0, -3);
      const ts = stemToIso(stem);
      return { ts, file: f, size };
    });
}

function stemToIso(stem: string): string {
  const t = stem.indexOf('T');
  if (t < 0) return stem;
  const date = stem.slice(0, t);
  const time = stem.slice(t).replace(/-/g, ':');
  return date + time;
}

function isoToStem(iso: string): string {
  return iso.replace(/:/g, '-');
}

function historyListHandler(req: IncomingMessage, res: ServerResponse): void {
  const urlObj = new URL(req.url || '/', 'http://x');
  const scope = urlObj.searchParams.get('scope') || '';
  const name  = urlObj.searchParams.get('name')  || '';
  if (!scope || !name) { send(res, 400, { ok: false, error: 'scope and name required' }); return; }
  if (!safeName(name)) { send(res, 400, { ok: false, error: 'invalid name' }); return; }
  const sdir = scopeDir(scope);
  if (!sdir) { send(res, 400, { ok: false, error: `unknown scope: ${scope}` }); return; }
  const skillDir = path.join(sdir, name);
  if (!safeIsDir(skillDir)) {
    const adir = archiveDirForScope(scope);
    const archived = adir ? path.join(adir, name) : null;
    if (archived && safeIsDir(archived)) {
      send(res, 200, { ok: true, scope, name, archived: true, history: listHistory(archived) });
      return;
    }
    send(res, 404, { ok: false, error: `skill not found: ${scope}/${name}` });
    return;
  }
  send(res, 200, { ok: true, scope, name, history: listHistory(skillDir) });
}

function historySnapshotHandler(req: IncomingMessage, res: ServerResponse): void {
  const urlObj = new URL(req.url || '/', 'http://x');
  const scope = urlObj.searchParams.get('scope') || '';
  const name  = urlObj.searchParams.get('name')  || '';
  const ts    = urlObj.searchParams.get('ts')    || '';
  if (!scope || !name || !ts) { send(res, 400, { ok: false, error: 'scope, name, ts required' }); return; }
  if (!safeName(name)) { send(res, 400, { ok: false, error: 'invalid name' }); return; }
  const sdir = scopeDir(scope);
  if (!sdir) { send(res, 400, { ok: false, error: `unknown scope: ${scope}` }); return; }
  let skillDir = path.join(sdir, name);
  if (!safeIsDir(skillDir)) {
    const adir = archiveDirForScope(scope);
    const archived = adir ? path.join(adir, name) : null;
    if (archived && safeIsDir(archived)) skillDir = archived;
    else { send(res, 404, { ok: false, error: `skill not found: ${scope}/${name}` }); return; }
  }
  const stem = isoToStem(ts);
  const file = path.join(historyDirFor(skillDir), stem + '.md');
  if (!safeIsFile(file)) { send(res, 404, { ok: false, error: `snapshot not found: ${ts}` }); return; }
  try {
    const content = fs.readFileSync(file, 'utf8');
    const stat = fs.statSync(file);
    send(res, 200, { ok: true, ts, size: stat.size, content });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: msg });
  }
}

async function historyRestoreHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { scope?: unknown; name?: unknown; ts?: unknown };
  try { body = (await readJsonBody(req)) as { scope?: unknown; name?: unknown; ts?: unknown }; }
  catch (err) { const msg = err instanceof Error ? err.message : String(err); send(res, 400, { ok: false, error: msg }); return; }
  const scope = typeof body.scope === 'string' ? body.scope : '';
  const name  = typeof body.name  === 'string' ? body.name  : '';
  const ts    = typeof body.ts    === 'string' ? body.ts    : '';
  if (!scope || !name || !ts) { send(res, 400, { ok: false, error: 'scope, name, ts required' }); return; }
  if (!safeName(name)) { send(res, 400, { ok: false, error: 'invalid name' }); return; }
  const sdir = scopeDir(scope);
  if (!sdir) { send(res, 400, { ok: false, error: `unknown scope: ${scope}` }); return; }
  const skillDir = path.join(sdir, name);
  if (!safeIsDir(skillDir)) { send(res, 404, { ok: false, error: `skill not found: ${scope}/${name}` }); return; }
  const mdPath = path.join(skillDir, 'SKILL.md');
  const stem = isoToStem(ts);
  const file = path.join(historyDirFor(skillDir), stem + '.md');
  if (!safeIsFile(file)) { send(res, 404, { ok: false, error: `snapshot not found: ${ts}` }); return; }

  try {
    const content = fs.readFileSync(file, 'utf8');
    if (safeIsFile(mdPath)) {
      try { snapshotIntoHistory(skillDir, mdPath); }
      catch { /* ignore */ }
    }
    atomicWrite(mdPath, content);
    send(res, 200, { ok: true, scope, name, restoredFrom: ts });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(res, 500, { ok: false, error: msg });
  }
}

function readUsageMap(): UsageMap {
  try {
    const raw = fs.readFileSync(USAGE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj as UsageMap : {};
  } catch {
    return {};
  }
}

function writeUsageMap(map: UsageMap): void {
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    const tmp = USAGE_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
    fs.renameSync(tmp, USAGE_FILE);
  } catch { /* best-effort */ }
}

async function useHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { name?: unknown; agentId?: unknown };
  try { body = (await readJsonBody(req)) as { name?: unknown; agentId?: unknown }; }
  catch (err) { const msg = err instanceof Error ? err.message : String(err); send(res, 400, { ok: false, error: msg }); return; }
  const name = typeof body.name === 'string' ? body.name : '';
  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  if (!name) { send(res, 400, { ok: false, error: 'name required' }); return; }
  if (!safeName(name)) { send(res, 400, { ok: false, error: 'invalid name' }); return; }
  const map = readUsageMap();
  const prior: UsageEntry = map[name] || { count: 0, lastUsedAt: null };
  const next: UsageEntry = {
    count: (prior.count || 0) + 1,
    lastUsedAt: new Date().toISOString(),
    lastAgentId: agentId || prior.lastAgentId || null,
  };
  map[name] = next;
  writeUsageMap(map);
  send(res, 200, { ok: true, name, usage: next });
}

function usageHandler(_req: IncomingMessage, res: ServerResponse): void {
  send(res, 200, { ok: true, usage: readUsageMap() });
}

function findRepoRoot(start: string): string | null {
  let cur = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function safeIsDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function safeIsFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }
function safeReaddir(p: string): string[] { try { return fs.readdirSync(p); } catch { return []; } }
function safeMtime(p: string): string | null { try { return fs.statSync(p).mtime.toISOString(); } catch { return null; } }

function safeName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (!name) return false;
  if (name === '.' || name === '..') return false;
  if (name.startsWith('.')) return false;
  if (/[\/\\]/.test(name)) return false;
  if (name.length > 128) return false;
  return true;
}

function copyRecursive(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else if (stat.isFile()) {
    fs.copyFileSync(src, dest);
  }
}

function parseFrontmatterFromText(text: unknown): ParsedFrontmatter | null {
  if (typeof text !== 'string') return null;
  if (!text.startsWith('---')) return null;
  const after = text.indexOf('\n', 3);
  if (after === -1) return null;
  const end = text.indexOf('\n---', after);
  if (end === -1) return null;
  const fm = text.slice(after + 1, end);
  return parseFrontmatterBlock(fm);
}

function parseSkillHeader(mdPath: string): ParsedFrontmatter {
  let text = '';
  try { text = fs.readFileSync(mdPath, 'utf8'); }
  catch { return {}; }
  if (!text.startsWith('---')) return {};
  const after = text.indexOf('\n', 3);
  if (after === -1) return {};
  const end = text.indexOf('\n---', after);
  if (end === -1) return {};
  const fm = text.slice(after + 1, end);
  return parseFrontmatterBlock(fm);
}

function parseFrontmatterBlock(fm: string): ParsedFrontmatter {
  const lines = fm.split('\n');
  const out: ParsedFrontmatter = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] || '';
    const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1] || '';
    let val = (m[2] || '').trim();

    if (key === 'metadata' && (val === '' || val === undefined)) {
      i++;
      while (i < lines.length && /^\s+/.test(lines[i] || '')) {
        const subm = (lines[i] || '').match(/^\s+([A-Za-z][\w-]*)\s*:\s*(.*)$/);
        if (subm) {
          const subKey = subm[1] || '';
          let subVal = (subm[2] || '').trim();
          subVal = unquote(subVal);
          if (subKey === 'short-description') out.shortDescription = subVal;
        }
        i++;
      }
      continue;
    }

    if (val === '>' || val === '|') {
      const collected: string[] = [];
      i++;
      while (i < lines.length && /^\s+/.test(lines[i] || '')) {
        collected.push((lines[i] || '').replace(/^\s+/, ''));
        i++;
      }
      val = val === '>' ? collected.join(' ') : collected.join('\n');
    } else {
      val = unquote(val);
      i++;
    }

    if (key === 'name') out.name = val;
    else if (key === 'description') out.description = val;
  }
  return out;
}

function unquote(s: string): string {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
