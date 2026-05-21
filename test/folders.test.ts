import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each test mints a fresh tmpdir + points HOME at it BEFORE importing the
// module so it lazily resolves ~/.grok-remote inside the sandbox. Tests must
// not touch the real home directory.

function newHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grok-remote-folders-'));
}

async function freshModule(): Promise<typeof import('../lib/folders.js')> {
  // Bust the module cache so each test gets a clean instance that observes the
  // current HOME env var.
  const url = new URL('../lib/folders.js?bust=' + Math.random(), import.meta.url).href;
  return import(url) as Promise<typeof import('../lib/folders.js')>;
}

const ORIGINAL_HOME = process.env['HOME'];
const ORIGINAL_USERPROFILE = process.env['USERPROFILE'];

function setHome(dir: string): void {
  process.env['HOME'] = dir;
  process.env['USERPROFILE'] = dir;
}

function restoreHome(): void {
  if (ORIGINAL_HOME == null) delete process.env['HOME']; else process.env['HOME'] = ORIGINAL_HOME;
  if (ORIGINAL_USERPROFILE == null) delete process.env['USERPROFILE']; else process.env['USERPROFILE'] = ORIGINAL_USERPROFILE;
}

test('listFolders returns an empty array when the file is missing', async () => {
  setHome(newHome());
  try {
    const m = await freshModule();
    assert.deepEqual(m.listFolders(), []);
  } finally {
    restoreHome();
  }
});

test('createFolder persists a new folder with a trimmed name and id', async () => {
  setHome(newHome());
  try {
    const m = await freshModule();
    const f = m.createFolder('  research  ');
    assert.equal(f.name, 'research');
    assert.ok(f.id.startsWith('fld_'));
    assert.deepEqual(f.agentIds, []);
    const after = m.listFolders();
    assert.equal(after.length, 1);
    assert.equal(after[0]!.id, f.id);
  } finally {
    restoreHome();
  }
});

test('createFolder rejects empty or whitespace-only names', async () => {
  setHome(newHome());
  try {
    const m = await freshModule();
    assert.throws(() => m.createFolder(''), /folder name required/);
    assert.throws(() => m.createFolder('   '), /folder name required/);
    assert.throws(() => m.createFolder(undefined as unknown as string), /folder name required/);
  } finally {
    restoreHome();
  }
});

test('updateFolder renames an existing folder', async () => {
  setHome(newHome());
  try {
    const m = await freshModule();
    const f = m.createFolder('old');
    const renamed = m.updateFolder(f.id, { name: 'new name' });
    assert.equal(renamed.name, 'new name');
    assert.equal(m.listFolders()[0]!.name, 'new name');
  } finally {
    restoreHome();
  }
});

test('updateFolder rejects an unknown id', async () => {
  setHome(newHome());
  try {
    const m = await freshModule();
    assert.throws(() => m.updateFolder('fld_nope', { name: 'x' }), /folder not found/);
  } finally {
    restoreHome();
  }
});

test('removeFolder drops the folder and returns false on second delete', async () => {
  setHome(newHome());
  try {
    const m = await freshModule();
    const f = m.createFolder('temp');
    assert.equal(m.removeFolder(f.id), true);
    assert.deepEqual(m.listFolders(), []);
    assert.equal(m.removeFolder(f.id), false);
  } finally {
    restoreHome();
  }
});

test('assignAgentToFolder adds an agent and is idempotent', async () => {
  setHome(newHome());
  try {
    const m = await freshModule();
    const f = m.createFolder('inbox');
    const after = m.assignAgentToFolder('agent-1', f.id);
    assert.ok(after);
    assert.deepEqual(after!.agentIds, ['agent-1']);
    // Same call twice should not duplicate.
    m.assignAgentToFolder('agent-1', f.id);
    assert.deepEqual(m.listFolders()[0]!.agentIds, ['agent-1']);
  } finally {
    restoreHome();
  }
});

test('assignAgentToFolder moves an agent between folders (single-folder invariant)', async () => {
  setHome(newHome());
  try {
    const m = await freshModule();
    const a = m.createFolder('a');
    const b = m.createFolder('b');
    m.assignAgentToFolder('agent-7', a.id);
    m.assignAgentToFolder('agent-7', b.id);
    const all = m.listFolders();
    const aAfter = all.find((x) => x.id === a.id)!;
    const bAfter = all.find((x) => x.id === b.id)!;
    assert.deepEqual(aAfter.agentIds, []);
    assert.deepEqual(bAfter.agentIds, ['agent-7']);
  } finally {
    restoreHome();
  }
});

test('assignAgentToFolder with null removes the agent from every folder', async () => {
  setHome(newHome());
  try {
    const m = await freshModule();
    const f = m.createFolder('inbox');
    m.assignAgentToFolder('agent-7', f.id);
    const result = m.assignAgentToFolder('agent-7', null);
    assert.equal(result, null);
    assert.deepEqual(m.listFolders()[0]!.agentIds, []);
  } finally {
    restoreHome();
  }
});

test('assignAgentToFolder rejects an unknown folder id', async () => {
  setHome(newHome());
  try {
    const m = await freshModule();
    assert.throws(() => m.assignAgentToFolder('a1', 'fld_nope'), /folder not found/);
  } finally {
    restoreHome();
  }
});

test('updateFolder agentIds replacement also enforces the single-folder invariant', async () => {
  setHome(newHome());
  try {
    const m = await freshModule();
    const a = m.createFolder('a');
    const b = m.createFolder('b');
    m.assignAgentToFolder('agent-1', a.id);
    m.updateFolder(b.id, { agentIds: ['agent-1'] });
    const all = m.listFolders();
    const aAfter = all.find((x) => x.id === a.id)!;
    const bAfter = all.find((x) => x.id === b.id)!;
    assert.deepEqual(aAfter.agentIds, []);
    assert.deepEqual(bAfter.agentIds, ['agent-1']);
  } finally {
    restoreHome();
  }
});

test('list/create round-trip survives a fresh module load (persistence)', async () => {
  const home = newHome();
  setHome(home);
  try {
    const m1 = await freshModule();
    const f = m1.createFolder('persisted');
    const m2 = await freshModule();
    const after = m2.listFolders();
    assert.equal(after.length, 1);
    assert.equal(after[0]!.id, f.id);
    assert.equal(after[0]!.name, 'persisted');
  } finally {
    restoreHome();
  }
});
