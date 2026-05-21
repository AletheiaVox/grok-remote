import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';

import { ENABLED, SKIP_REASON, bootServer, shutdown } from './_helpers.js';

// Phase 9 — more public endpoints. Read-only probes only; nothing in here
// mutates user state (no PATCH /api/settings, no agent spawns, no grok bin
// calls beyond what /api/system/health reads).

test('integration: GET /api/agents returns an array of agent records', { skip: !ENABLED && SKIP_REASON }, async () => {
  let proc: ChildProcess | null = null;
  try {
    const s = await bootServer();
    proc = s.proc;
    const r = await fetch(`${s.base}/api/agents`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body), 'expected array of agents');
    for (const a of body as unknown[]) {
      assert.equal(typeof a, 'object');
      assert.notEqual(a, null);
      assert.equal(typeof (a as { id?: unknown }).id, 'string');
    }
  } finally {
    await shutdown(proc);
  }
});

test('integration: GET /api/settings returns the persisted-or-default settings object', { skip: !ENABLED && SKIP_REASON }, async () => {
  let proc: ChildProcess | null = null;
  try {
    const s = await bootServer();
    proc = s.proc;
    const r = await fetch(`${s.base}/api/settings`);
    assert.equal(r.status, 200);
    const body = await r.json() as {
      defaultModel?: unknown; defaultCwd?: unknown; autoApprove?: unknown;
      retentionDays?: unknown; theme?: unknown; debug?: unknown;
    };
    // All Settings keys present (default may be null/0/false but never undefined).
    assert.ok('defaultModel'  in body);
    assert.ok('defaultCwd'    in body);
    assert.ok('autoApprove'   in body);
    assert.ok('retentionDays' in body);
    assert.ok('theme'         in body);
    assert.ok('debug'         in body);
    assert.equal(typeof body.autoApprove, 'boolean');
    assert.equal(typeof body.retentionDays, 'number');
    assert.equal(typeof body.theme, 'string');
    assert.equal(typeof body.debug, 'boolean');
  } finally {
    await shutdown(proc);
  }
});

test('integration: PATCH /api/settings with an empty body is idempotent (no-op)', { skip: !ENABLED && SKIP_REASON }, async () => {
  // Whole-object merge with {} should return the current settings unchanged.
  // We diff what GET returns before vs. after to catch any accidental write.
  let proc: ChildProcess | null = null;
  try {
    const s = await bootServer();
    proc = s.proc;
    const before = await (await fetch(`${s.base}/api/settings`)).json();
    const r = await fetch(`${s.base}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
    const merged = await r.json();
    const after  = await (await fetch(`${s.base}/api/settings`)).json();
    assert.deepEqual(merged, after);
    assert.deepEqual(before, after);
  } finally {
    await shutdown(proc);
  }
});

test('integration: /api/agents/stream opens an SSE stream and sends at least one event', { skip: !ENABLED && SKIP_REASON }, async () => {
  // Smoke test: we don't drive any agent activity, we just confirm the
  // endpoint emits a valid SSE byte stream. The server pings periodically
  // even on an idle channel, so we expect *something* within ~3s.
  let proc: ChildProcess | null = null;
  try {
    const s = await bootServer();
    proc = s.proc;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 3000);
    t.unref();
    const r = await fetch(`${s.base}/api/agents/stream`, { signal: ac.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/event-stream/);
    const reader = r.body?.getReader();
    assert.ok(reader, 'expected a readable body');
    const { value, done } = await reader!.read();
    clearTimeout(t);
    ac.abort();
    assert.equal(done, false);
    assert.ok(value && value.byteLength > 0, 'expected at least one byte from the SSE stream');
  } finally {
    await shutdown(proc);
  }
});

test('integration: GET /api/system/health returns version + update + server blocks', { skip: !ENABLED && SKIP_REASON }, async () => {
  // /api/system/health combines `grok version`, an update check, and a
  // server info block. The grok-dependent fields may carry errors when the
  // CLI isn't logged in — we only assert the envelope shape, not contents.
  let proc: ChildProcess | null = null;
  try {
    const s = await bootServer();
    proc = s.proc;
    const r = await fetch(`${s.base}/api/system/health`);
    // Endpoint should return 200 even when sub-tasks fail (they fold into
    // *Error fields on the response).
    assert.equal(r.status, 200);
    const body = await r.json() as Record<string, unknown>;
    assert.equal(typeof body, 'object');
    assert.notEqual(body, null);
    // server block is always populated locally.
    const server = body['server'] as { node?: unknown; platform?: unknown; uptimeSeconds?: unknown } | undefined;
    assert.equal(typeof server, 'object');
    assert.equal(typeof server?.node, 'string');
    assert.equal(typeof server?.platform, 'string');
    assert.equal(typeof server?.uptimeSeconds, 'number');
  } finally {
    await shutdown(proc);
  }
});
