import test from 'node:test';
import assert from 'node:assert/strict';

import { sweepOnce } from '../lib/retention.js';

// Disabled-path coverage. The full sweep reads ~/.grok-remote/agents/ from
// disk, which we deliberately don't touch from tests. These cases lock in the
// safety contract: when retention is disabled (or misconfigured), sweepOnce
// MUST return zero counts and not touch the filesystem at all.

test('sweepOnce returns zero counts when called with no arguments', () => {
  assert.deepEqual(sweepOnce(), { scanned: 0, removed: 0, skipped: 0 });
});

test('sweepOnce returns zero counts when days is missing', () => {
  assert.deepEqual(sweepOnce({}), { scanned: 0, removed: 0, skipped: 0 });
});

test('sweepOnce returns zero counts when days is zero', () => {
  assert.deepEqual(sweepOnce({ days: 0 }), { scanned: 0, removed: 0, skipped: 0 });
});

test('sweepOnce returns zero counts when days is negative', () => {
  assert.deepEqual(sweepOnce({ days: -5 }), { scanned: 0, removed: 0, skipped: 0 });
});

test('sweepOnce returns zero counts when days is non-finite', () => {
  assert.deepEqual(sweepOnce({ days: NaN }), { scanned: 0, removed: 0, skipped: 0 });
  assert.deepEqual(sweepOnce({ days: Infinity }), { scanned: 0, removed: 0, skipped: 0 });
  // Stringly-typed config values from settings.json should also short-circuit
  // before any filesystem call.
  assert.deepEqual(sweepOnce({ days: 'soon' as unknown as number }), { scanned: 0, removed: 0, skipped: 0 });
});
