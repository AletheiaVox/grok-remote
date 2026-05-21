import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// folders.js writes to ~/.grok-remote/folders.json. Redirect HOME to a
// throwaway directory so the suite cannot stomp on a real user file.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-folders-test-'));
process.env.HOME = TMP_HOME;
const folders = await import('../lib/folders.js');

function reset() {
  const { file } = folders.paths();
  try { fs.unlinkSync(file); } catch { /* ignore */ }
}

test('list returns [] when nothing is persisted yet', () => {
  reset();
  assert.deepEqual(folders.list(), []);
});

test('create writes a folder with a normalized name and a uuid id', () => {
  reset();
  const f = folders.create({ name: '  Inbox  ' });
  assert.equal(f.name, 'Inbox');
  assert.match(f.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(f.agentIds, []);
  assert.equal(folders.list().length, 1);
});

test('create rejects empty names', () => {
  reset();
  assert.throws(() => folders.create({ name: '' }), /name required/);
  assert.throws(() => folders.create({}), /name required/);
});

test('update renames a folder', () => {
  reset();
  const f = folders.create({ name: 'work' });
  const next = folders.update(f.id, { name: 'work-stuff' });
  assert.equal(next.name, 'work-stuff');
  assert.equal(folders.get(f.id).name, 'work-stuff');
});

test('update with agentIds enforces a single-folder-per-agent rule', () => {
  reset();
  const a = folders.create({ name: 'a' });
  const b = folders.create({ name: 'b' });
  folders.update(a.id, { agentIds: ['agent-1', 'agent-2'] });
  folders.update(b.id, { agentIds: ['agent-2', 'agent-3'] });
  assert.deepEqual(folders.get(a.id).agentIds, ['agent-1']);
  assert.deepEqual(folders.get(b.id).agentIds, ['agent-2', 'agent-3']);
});

test('assignAgent moves an agent into a folder', () => {
  reset();
  const a = folders.create({ name: 'a' });
  folders.assignAgent('agent-1', a.id);
  assert.deepEqual(folders.get(a.id).agentIds, ['agent-1']);
});

test('assignAgent with null removes an agent from all folders', () => {
  reset();
  const a = folders.create({ name: 'a' });
  folders.assignAgent('agent-1', a.id);
  folders.assignAgent('agent-1', null);
  assert.deepEqual(folders.get(a.id).agentIds, []);
});

test('assignAgent rejects unknown folder ids', () => {
  reset();
  assert.throws(() => folders.assignAgent('agent-1', 'no-such-folder'), /folder not found/);
});

test('remove deletes a folder; agents inside it are not removed elsewhere', () => {
  reset();
  const a = folders.create({ name: 'a' });
  folders.assignAgent('agent-1', a.id);
  assert.equal(folders.remove(a.id), true);
  assert.equal(folders.list().length, 0);
});
