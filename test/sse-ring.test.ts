import test from 'node:test';
import assert from 'node:assert/strict';

import { createRing, type SseRingEntry } from '../lib/sse.js';

interface Entry extends SseRingEntry {
  id: number;
  body?: string;
}

test('createRing starts empty', () => {
  const ring = createRing<Entry>();
  assert.equal(ring.size(), 0);
  assert.deepEqual(ring.all(), []);
});

test('push appends entries in order', () => {
  const ring = createRing<Entry>();
  ring.push({ id: 1, body: 'a' });
  ring.push({ id: 2, body: 'b' });
  ring.push({ id: 3, body: 'c' });
  assert.equal(ring.size(), 3);
  assert.deepEqual(ring.all().map((e) => e.id), [1, 2, 3]);
});

test('ring evicts oldest entries when capacity is exceeded', () => {
  const ring = createRing<Entry>(3);
  for (let i = 1; i <= 5; i++) ring.push({ id: i });
  assert.equal(ring.size(), 3);
  assert.deepEqual(ring.all().map((e) => e.id), [3, 4, 5]);
});

test('since returns everything after the given id', () => {
  const ring = createRing<Entry>();
  for (let i = 1; i <= 4; i++) ring.push({ id: i });
  assert.deepEqual(ring.since(2).map((e) => e.id), [3, 4]);
});

test('since returns the full buffer when lastId is null, undefined, or empty', () => {
  const ring = createRing<Entry>();
  ring.push({ id: 1 });
  ring.push({ id: 2 });
  assert.deepEqual(ring.since(null).map((e) => e.id),      [1, 2]);
  assert.deepEqual(ring.since(undefined).map((e) => e.id), [1, 2]);
  assert.deepEqual(ring.since('').map((e) => e.id),        [1, 2]);
});

test('since returns the full buffer when lastId is not found', () => {
  // Reconnecting clients may carry a stale id that the server has since
  // evicted. Replaying everything is safer than dropping events silently.
  const ring = createRing<Entry>(3);
  for (let i = 1; i <= 5; i++) ring.push({ id: i });
  assert.deepEqual(ring.since(1).map((e) => e.id), [3, 4, 5]);
});

test('since coerces ids to strings before comparison', () => {
  // SSE Last-Event-ID arrives as a header string, while the ring may hold
  // numeric ids. The match should work across the type boundary.
  const ring = createRing<Entry>();
  ring.push({ id: 7 });
  ring.push({ id: 8 });
  assert.deepEqual(ring.since('7').map((e) => e.id), [8]);
});

test('all() returns a snapshot, not a live reference', () => {
  const ring = createRing<Entry>();
  ring.push({ id: 1 });
  const snap = ring.all();
  ring.push({ id: 2 });
  assert.deepEqual(snap.map((e) => e.id), [1]);
  assert.deepEqual(ring.all().map((e) => e.id), [1, 2]);
});
