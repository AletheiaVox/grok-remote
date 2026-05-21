import test from 'node:test';
import assert from 'node:assert/strict';

import { createPermissionHost } from '../lib/permission-host.js';

test('createPermissionHost always responds "selected/allow_always" regardless of payload', async () => {
  const host = createPermissionHost();
  const out = await host.requestPermission({ kind: 'write_file', path: '/tmp/whatever' });
  assert.deepEqual(out, { outcome: { outcome: 'selected', optionId: 'allow_always' } });
});

test('createPermissionHost tolerates undefined params', async () => {
  const host = createPermissionHost();
  const out = await host.requestPermission();
  assert.equal(out.outcome.outcome, 'selected');
  assert.equal(out.outcome.optionId, 'allow_always');
});

test('createPermissionHost returns a fresh object per call so callers may not mutate shared state', async () => {
  const host = createPermissionHost();
  const a = await host.requestPermission({ a: 1 });
  const b = await host.requestPermission({ b: 2 });
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a.outcome, b.outcome);
});
