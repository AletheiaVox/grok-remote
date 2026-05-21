import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Phase 9 integration test. Boots the real server.ts via tsx on a random
// high port, waits for /api/health to return 200, then exercises the public
// shape of /api/hello and /api/version/current. Gated on the env var so this
// only runs when the user explicitly invokes `npm run test:integration` and
// has a logged-in `grok` CLI on the host. See CONVERT.md, Phase 9.

const ENABLED = process.env['RUN_LOCAL_INTEGRATION'] === '1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Pick an unlikely-to-collide port. Avoids stomping on :7910 (the live
// dashboard) or :7911 (vite dev) the user may also have running.
const PORT = String(17910 + Math.floor(Math.random() * 1000));
const BASE = `http://127.0.0.1:${PORT}`;

async function bootServer(): Promise<ChildProcess> {
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(ROOT, 'server.ts')],
    {
      cwd: ROOT,
      env: { ...process.env, PORT, HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // Drain stdio so the buffer doesn't block.
  proc.stdout?.on('data', () => { /* swallow */ });
  proc.stderr?.on('data', () => { /* swallow */ });

  // Poll /api/health until it returns 200 (or give up after ~10s).
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return proc;
    } catch { /* not up yet */ }
    await delay(200);
  }
  proc.kill('SIGKILL');
  throw new Error(`server did not respond at ${BASE}/api/health within 10s`);
}

async function shutdown(proc: ChildProcess | null): Promise<void> {
  if (!proc) return;
  proc.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    if (proc.killed || proc.exitCode != null) { resolve(); return; }
    proc.once('exit', () => resolve());
    // Hard kill backstop in case SIGTERM hangs.
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 2000).unref();
  });
}

test('integration: /api/health returns ok + version + uptime', { skip: !ENABLED && 'set RUN_LOCAL_INTEGRATION=1 to enable' }, async () => {
  let proc: ChildProcess | null = null;
  try {
    proc = await bootServer();
    const r = await fetch(`${BASE}/api/health`);
    assert.equal(r.status, 200);
    const body = await r.json() as { ok?: boolean; version?: string; uptime_seconds?: number };
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.uptime_seconds, 'number');
  } finally {
    await shutdown(proc);
  }
});

test('integration: /api/hello reports app identity, node, and tailscale block', { skip: !ENABLED && 'set RUN_LOCAL_INTEGRATION=1 to enable' }, async () => {
  let proc: ChildProcess | null = null;
  try {
    proc = await bootServer();
    const r = await fetch(`${BASE}/api/hello`);
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
    // tailscale key is always present, even when offline (null or object).
    assert.ok(body.tailscale === null || typeof body.tailscale === 'object');
  } finally {
    await shutdown(proc);
  }
});

test('integration: /api/version/current responds with a CurrentVersion shape', { skip: !ENABLED && 'set RUN_LOCAL_INTEGRATION=1 to enable' }, async () => {
  let proc: ChildProcess | null = null;
  try {
    proc = await bootServer();
    const r = await fetch(`${BASE}/api/version/current`);
    assert.equal(r.status, 200);
    const body = await r.json() as {
      ok?: boolean; version?: string; pkgVersion?: string;
      gitSha?: string | null; gitBranch?: string | null;
    };
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.pkgVersion, 'string');
    // We expect git context to populate inside a real checkout.
    assert.ok(body.gitSha === null || typeof body.gitSha === 'string');
    assert.ok(body.gitBranch === null || typeof body.gitBranch === 'string');
  } finally {
    await shutdown(proc);
  }
});

test('integration: GET /api/unknown returns 404', { skip: !ENABLED && 'set RUN_LOCAL_INTEGRATION=1 to enable' }, async () => {
  let proc: ChildProcess | null = null;
  try {
    proc = await bootServer();
    const r = await fetch(`${BASE}/api/not-a-real-endpoint`);
    assert.equal(r.status, 404);
  } finally {
    await shutdown(proc);
  }
});
