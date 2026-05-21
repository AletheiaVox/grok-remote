// Persist sidebar folder groupings under ~/.grok-remote/folders.json.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export interface Folder {
  id: string;
  name: string;
  agentIds: string[];
  createdAt: string;
}

interface FoldersFile {
  folders: Folder[];
}

function root(): string {
  return path.join(os.homedir(), '.grok-remote');
}

function file(): string {
  return path.join(root(), 'folders.json');
}

function ensureRoot(): void {
  fs.mkdirSync(root(), { recursive: true });
}

function readAll(): FoldersFile {
  ensureRoot();
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<FoldersFile>;
    const folders = Array.isArray(parsed.folders) ? parsed.folders : [];
    return { folders: folders.filter(isValidFolder).map(normalizeFolder) };
  } catch {
    return { folders: [] };
  }
}

function writeAll(data: FoldersFile): void {
  ensureRoot();
  fs.writeFileSync(file(), JSON.stringify(data, null, 2));
}

function isValidFolder(f: unknown): f is Folder {
  if (!f || typeof f !== 'object') return false;
  const r = f as Record<string, unknown>;
  return typeof r.id === 'string'
      && typeof r.name === 'string'
      && Array.isArray(r.agentIds)
      && typeof r.createdAt === 'string';
}

function normalizeFolder(f: Folder): Folder {
  return {
    id: f.id,
    name: String(f.name).slice(0, 200),
    agentIds: Array.from(new Set(f.agentIds.filter((x) => typeof x === 'string'))),
    createdAt: f.createdAt,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  // Short random id, prefixed for readability in the JSON file.
  return `fld_${crypto.randomBytes(6).toString('hex')}`;
}

export function listFolders(): Folder[] {
  return readAll().folders.slice();
}

export function createFolder(name: string): Folder {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('folder name required');
  const data = readAll();
  const folder: Folder = {
    id: newId(),
    name: trimmed.slice(0, 200),
    agentIds: [],
    createdAt: nowIso(),
  };
  data.folders.push(folder);
  writeAll(data);
  return folder;
}

export interface FolderPatch {
  name?: string;
  agentIds?: string[];
}

export function updateFolder(id: string, patch: FolderPatch): Folder {
  if (!id || typeof id !== 'string') throw new Error('folder id required');
  if (!patch || typeof patch !== 'object') throw new Error('invalid patch');
  const data = readAll();
  const idx = data.folders.findIndex((f) => f.id === id);
  if (idx < 0) throw new Error('folder not found');
  const cur = data.folders[idx]!;
  const next: Folder = { ...cur };
  if (typeof patch.name === 'string') {
    const trimmed = patch.name.trim();
    if (!trimmed) throw new Error('folder name required');
    next.name = trimmed.slice(0, 200);
  }
  if (Array.isArray(patch.agentIds)) {
    next.agentIds = Array.from(new Set(patch.agentIds.filter((x) => typeof x === 'string')));
  }
  data.folders[idx] = next;
  // Drop the agent from every OTHER folder so the single-folder-per-agent
  // invariant holds even when callers PATCH agentIds directly.
  if (Array.isArray(patch.agentIds)) {
    for (let i = 0; i < data.folders.length; i++) {
      if (i === idx) continue;
      const other = data.folders[i]!;
      const filtered = other.agentIds.filter((a) => !next.agentIds.includes(a));
      if (filtered.length !== other.agentIds.length) {
        data.folders[i] = { ...other, agentIds: filtered };
      }
    }
  }
  writeAll(data);
  return next;
}

export function removeFolder(id: string): boolean {
  if (!id || typeof id !== 'string') throw new Error('folder id required');
  const data = readAll();
  const before = data.folders.length;
  data.folders = data.folders.filter((f) => f.id !== id);
  if (data.folders.length === before) return false;
  writeAll(data);
  return true;
}

export function assignAgentToFolder(agentId: string, folderId: string | null): Folder | null {
  if (!agentId || typeof agentId !== 'string') throw new Error('agentId required');
  const data = readAll();
  let target: Folder | null = null;
  if (folderId != null) {
    const idx = data.folders.findIndex((f) => f.id === folderId);
    if (idx < 0) throw new Error('folder not found');
    target = data.folders[idx]!;
  }
  let changed = false;
  for (let i = 0; i < data.folders.length; i++) {
    const f = data.folders[i]!;
    const isTarget = target !== null && f.id === target.id;
    const has = f.agentIds.includes(agentId);
    if (isTarget && !has) {
      data.folders[i] = { ...f, agentIds: [...f.agentIds, agentId] };
      changed = true;
    } else if (!isTarget && has) {
      data.folders[i] = { ...f, agentIds: f.agentIds.filter((a) => a !== agentId) };
      changed = true;
    }
  }
  if (changed) writeAll(data);
  return target ? (data.folders.find((f) => f.id === target!.id) || null) : null;
}

export function paths(): { root: string; file: string } {
  return { root: root(), file: file() };
}
