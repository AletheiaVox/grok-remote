import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';

import { ENABLED, SKIP_REASON, bootServer, shutdown } from './_helpers.js';

// Phase 9 — smoke. Boot the real server.ts on a random port and probe the
// always-on endpoints. See ./_helpers.ts for the boot loop. Gated on the
// RUN_LOCAL_INTEGRATION=1 env var.

test('integration: /api/health returns ok + version + uptime', { skip: !ENABLED && SKIP_REASON }, async () => {
  let proc: ChildProcess | null = null;
  try {
    const s = await bootServer();
    proc = s.proc;
    const r = await fetch(`${s.base}/api/health`);
    assert.equal(r.status, 200);
    const body = await r.json() as { ok?: boolean; version?: string; uptime_seconds?: number };
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.uptime_seconds, 'number');
  } finally {
    await shutdown(proc);
  }
});

test('integration: /api/hello reports app identity, node, and tailscale block', { skip: !ENABLED && SKIP_REASON }, async () => {
  let proc: ChildProcess | null = null;
  try {
    const s = await bootServer();
    proc = s.proc;
    const r = await fetch(`${s.base}/api/hello`);
    assert.equal(r.status, 200);
    const body = await r.json() as {
      ok?: boolean; app?: string; version?: string; node?: string;
      platform?: string; hostname?: string;
      tailscale?: unknown;
    };
    assert.equal(body.ok, true);
    assert.equal(body.app, 'grok-remote');
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.node, 'string');
    assert.equal(typeof body.platform, 'string');
    assert.equal(typeof body.hostname, 'string');
    assert.ok(body.tailscale === null || typeof body.tailscale === 'object');
  } finally {
    await shutdown(proc);
  }
});

test('integration: /api/version/current responds with a CurrentVersion shape', { skip: !ENABLED && SKIP_REASON }, async () => {
  let proc: ChildProcess | null = null;
  try {
    const s = await bootServer();
    proc = s.proc;
    const r = await fetch(`${s.base}/api/version/current`);
    assert.equal(r.status, 200);
    const body = await r.json() as {
      ok?: boolean; version?: string; pkgVersion?: string;
      gitSha?: string | null; gitBranch?: string | null;
    };
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.pkgVersion, 'string');
    assert.ok(body.gitSha === null || typeof body.gitSha === 'string');
    assert.ok(body.gitBranch === null || typeof body.gitBranch === 'string');
  } finally {
    await shutdown(proc);
  }
});

test('integration: GET /api/unknown returns 404', { skip: !ENABLED && SKIP_REASON }, async () => {
  let proc: ChildProcess | null = null;
  try {
    const s = await bootServer();
    proc = s.proc;
    const r = await fetch(`${s.base}/api/not-a-real-endpoint`);
    assert.equal(r.status, 404);
  } finally {
    await shutdown(proc);
  }
});
