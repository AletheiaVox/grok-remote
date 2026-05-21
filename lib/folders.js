// Persist sidebar folders under ~/.grok-remote/folders.json.
//
// A folder is a flat list of agent ids. An agent belongs to at most one
// folder; assigning it to a folder removes it from any other folder first.
//
// Public type:
//   Folder { id: string; name: string; agentIds: string[]; createdAt: string }
//
// The store is a small JSON blob:
//   { folders: Folder[] }

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const ROOT = path.join(os.homedir(), '.grok-remote');
const FILE = path.join(ROOT, 'folders.json');

function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true });
}

function nowIso() { return new Date().toISOString(); }

function newId() {
  return crypto.randomUUID();
}

function normalizeFolder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  const name = typeof raw.name === 'string' ? raw.name : '';
  const agentIds = Array.isArray(raw.agentIds)
    ? raw.agentIds.filter((x) => typeof x === 'string' && x)
    : [];
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt
    ? raw.createdAt
    : nowIso();
  if (!id || !name.trim()) return null;
  return { id, name: name.trim(), agentIds, createdAt };
}

function loadRaw() {
  ensureRoot();
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const folders = Array.isArray(parsed?.folders) ? parsed.folders : [];
    return folders.map(normalizeFolder).filter(Boolean);
  } catch {
    return [];
  }
}

function persist(folders) {
  ensureRoot();
  fs.writeFileSync(FILE, JSON.stringify({ folders }, null, 2));
}

export function list() {
  return loadRaw();
}

export function get(id) {
  return loadRaw().find((f) => f.id === id) || null;
}

export function create({ name }) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('name required');
  }
  const folders = loadRaw();
  const folder = {
    id: newId(),
    name: name.trim().slice(0, 200),
    agentIds: [],
    createdAt: nowIso(),
  };
  folders.push(folder);
  persist(folders);
  return folder;
}

export function update(id, patch) {
  if (!patch || typeof patch !== 'object') throw new Error('invalid patch');
  const folders = loadRaw();
  const idx = folders.findIndex((f) => f.id === id);
  if (idx < 0) throw new Error('folder not found');
  const cur = folders[idx];
  let next = { ...cur };
  if (typeof patch.name === 'string') {
    const name = patch.name.trim();
    if (!name) throw new Error('name cannot be empty');
    next.name = name.slice(0, 200);
  }
  if (Array.isArray(patch.agentIds)) {
    const cleaned = patch.agentIds.filter((x) => typeof x === 'string' && x);
    // Ensure each agent only lives in one folder. Strip these ids from any
    // other folder first.
    for (let i = 0; i < folders.length; i++) {
      if (folders[i].id === id) continue;
      const filtered = folders[i].agentIds.filter((aid) => !cleaned.includes(aid));
      if (filtered.length !== folders[i].agentIds.length) {
        folders[i] = { ...folders[i], agentIds: filtered };
      }
    }
    next.agentIds = cleaned;
  }
  folders[idx] = next;
  persist(folders);
  return next;
}

export function remove(id) {
  const folders = loadRaw();
  const idx = folders.findIndex((f) => f.id === id);
  if (idx < 0) return false;
  folders.splice(idx, 1);
  persist(folders);
  return true;
}

// Move an agent into a folder (or remove it from all folders when folderId is
// null). Returns the updated folder list.
export function assignAgent(agentId, folderId) {
  if (typeof agentId !== 'string' || !agentId) throw new Error('agentId required');
  const folders = loadRaw();
  let dirty = false;
  for (let i = 0; i < folders.length; i++) {
    const has = folders[i].agentIds.includes(agentId);
    if (folders[i].id === folderId) {
      if (!has) {
        folders[i] = { ...folders[i], agentIds: [...folders[i].agentIds, agentId] };
        dirty = true;
      }
    } else if (has) {
      folders[i] = {
        ...folders[i],
        agentIds: folders[i].agentIds.filter((x) => x !== agentId),
      };
      dirty = true;
    }
  }
  if (folderId && !folders.some((f) => f.id === folderId)) {
    throw new Error('folder not found');
  }
  if (dirty) persist(folders);
  return folders;
}

export function paths() {
  return { root: ROOT, file: FILE };
}
