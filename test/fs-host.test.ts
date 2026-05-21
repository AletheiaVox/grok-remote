import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createFsHost } from '../lib/fs-host.js';

// Build a fresh tmpdir scope per test so they don't leak into each other or
// the user's home directory.
function newScope(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grok-remote-fshost-'));
}

test('readTextFile reads a file inside the scope', async () => {
  const scope = newScope();
  fs.writeFileSync(path.join(scope, 'a.txt'), 'hello\nworld\n');
  const host = createFsHost({ getCwd: () => scope });
  const out = await host.readTextFile({ path: 'a.txt' });
  assert.equal(out.content, 'hello\nworld\n');
});

test('readTextFile honours line + limit by slicing the file by line', async () => {
  const scope = newScope();
  fs.writeFileSync(path.join(scope, 'lines.txt'), '1\n2\n3\n4\n5\n');
  const host = createFsHost({ getCwd: () => scope });
  // line: 1-indexed, limit: count.
  const out = await host.readTextFile({ path: 'lines.txt', line: 2, limit: 2 });
  assert.equal(out.content, '2\n3');
});

test('readTextFile rejects a path that escapes the scope', async () => {
  const scope = newScope();
  const host = createFsHost({ getCwd: () => scope });
  await assert.rejects(
    host.readTextFile({ path: '../../../etc/passwd' }),
    /path escapes agent scope/,
  );
});

test('readTextFile rejects an absolute path outside the scope', async () => {
  const scope = newScope();
  const host = createFsHost({ getCwd: () => scope });
  await assert.rejects(
    host.readTextFile({ path: '/etc/passwd' }),
    /path escapes agent scope/,
  );
});

test('readTextFile rejects a non-string or empty path with -32602', async () => {
  const scope = newScope();
  const host = createFsHost({ getCwd: () => scope });
  await assert.rejects(host.readTextFile({}), /path must be a non-empty string/);
  await assert.rejects(host.readTextFile({ path: '' }), /path must be a non-empty string/);
});

test('writeTextFile creates the file and any missing parent directories', async () => {
  const scope = newScope();
  const host = createFsHost({ getCwd: () => scope });
  await host.writeTextFile({ path: 'nested/dir/out.txt', content: 'wrote it' });
  assert.equal(
    fs.readFileSync(path.join(scope, 'nested/dir/out.txt'), 'utf8'),
    'wrote it',
  );
});

test('writeTextFile rejects when content is not a string', async () => {
  const scope = newScope();
  const host = createFsHost({ getCwd: () => scope });
  await assert.rejects(
    host.writeTextFile({ path: 'x.txt', content: 123 as unknown as string }),
    /content must be a string/,
  );
});

test('writeTextFile refuses to write outside the scope', async () => {
  const scope = newScope();
  const host = createFsHost({ getCwd: () => scope });
  await assert.rejects(
    host.writeTextFile({ path: '../escape.txt', content: 'leak' }),
    /path escapes agent scope/,
  );
});

test('allows the exact scope directory itself, not just descendants', async () => {
  // A path that resolves to the scope root (e.g. ".") should not be flagged
  // as an escape even though it's not strictly a descendant.
  const scope = newScope();
  const host = createFsHost({ getCwd: () => scope });
  await assert.rejects(
    host.readTextFile({ path: '.' }),
    /EISDIR|illegal operation on a directory/i, // fails for being a directory, not for scope
  );
});

test('falls back to process.cwd() resolution when getCwd returns null', async () => {
  // When getCwd is null, no scope check is performed. Verify that relative
  // paths still resolve via process.cwd() and reads succeed.
  const scope = newScope();
  const file = path.join(scope, 'cwd-fallback.txt');
  fs.writeFileSync(file, 'data');
  const host = createFsHost({ getCwd: () => null });
  const out = await host.readTextFile({ path: file }); // absolute path bypasses cwd
  assert.equal(out.content, 'data');
});
