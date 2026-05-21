import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { createTerminalHost } from '../lib/terminal-host.js';

// terminal-host wraps node:child_process.spawn. These tests run real (but
// trivial) subprocesses — `echo`, `false`, and a sleep loop — so they exercise
// the create/output/waitForExit/kill/release flow end-to-end without touching
// any grok binary. They are platform-portable across darwin and linux (the
// only platforms grok-remote targets).

function makeScope(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grok-remote-termhost-'));
}

test('create + waitForExit + output collects stdout from a short-lived command', async () => {
  const host = createTerminalHost({ getCwd: () => makeScope() });
  const { terminalId } = await host.create({ command: 'echo hello-from-test' });
  const { exitStatus } = await host.waitForExit({ terminalId });
  const { output, truncated } = await host.output({ terminalId });

  assert.equal(exitStatus?.exitCode, 0);
  assert.equal(exitStatus?.signal, null);
  assert.equal(truncated, false);
  assert.match(output, /hello-from-test/);

  host.shutdownAll();
});

test('non-zero exit status is reported through waitForExit/output', async () => {
  const host = createTerminalHost({ getCwd: () => makeScope() });
  const { terminalId } = await host.create({ command: 'false' });
  const { exitStatus } = await host.waitForExit({ terminalId });
  assert.equal(exitStatus?.exitCode, 1);
  host.shutdownAll();
});

test('explicit args bypass the /bin/bash -lc wrapper', async () => {
  // When args are provided, the host calls cmd directly. Verify by passing
  // `/bin/echo` with args — the parent shell would otherwise interpret them.
  const host = createTerminalHost({ getCwd: () => makeScope() });
  const { terminalId } = await host.create({
    command: '/bin/echo',
    args: ['arg-one', 'arg-two'],
  });
  await host.waitForExit({ terminalId });
  const { output } = await host.output({ terminalId });
  assert.match(output, /arg-one arg-two/);
  host.shutdownAll();
});

test('environment variables from env array reach the subprocess', async () => {
  const host = createTerminalHost({ getCwd: () => makeScope() });
  const { terminalId } = await host.create({
    command: 'echo "$GROK_TEST_VAR"',
    env: [{ name: 'GROK_TEST_VAR', value: 'fromhost' }],
  });
  await host.waitForExit({ terminalId });
  const { output } = await host.output({ terminalId });
  assert.match(output, /fromhost/);
  host.shutdownAll();
});

test('output buffer truncates beyond outputByteLimit and sets truncated=true', async () => {
  // Emit 256 bytes of "x" with a 64-byte cap; the buffer should retain the
  // last 64 bytes (still 256 chars worth of "x", but flagged truncated).
  const host = createTerminalHost({ getCwd: () => makeScope() });
  const { terminalId } = await host.create({
    command: 'printf "%0.s=" {1..256}',
    outputByteLimit: 64,
  });
  await host.waitForExit({ terminalId });
  const { output, truncated } = await host.output({ terminalId });
  assert.equal(truncated, true);
  assert.equal(output.length, 64);
  assert.match(output, /^=+$/);
  host.shutdownAll();
});

test('create rejects when command is missing or empty', async () => {
  const host = createTerminalHost({ getCwd: () => makeScope() });
  await assert.rejects(host.create({}), /command required/);
  await assert.rejects(host.create({ command: '' }), /command required/);
});

test('output/waitForExit/kill all reject with -32004 for unknown terminalId', async () => {
  const host = createTerminalHost({ getCwd: () => makeScope() });
  await assert.rejects(host.output({ terminalId: 'nope' }),       /unknown terminalId/);
  await assert.rejects(host.waitForExit({ terminalId: 'nope' }),  /unknown terminalId/);
  await assert.rejects(host.kill({ terminalId: 'nope' }),         /unknown terminalId/);
});

test('release tears down a terminal and forgets it', async () => {
  const host = createTerminalHost({ getCwd: () => makeScope() });
  const { terminalId } = await host.create({ command: 'echo bye' });
  await host.waitForExit({ terminalId });
  await host.release({ terminalId });
  await assert.rejects(host.output({ terminalId }), /unknown terminalId/);
});

test('kill terminates a long-running process', async () => {
  const host = createTerminalHost({ getCwd: () => makeScope() });
  const { terminalId } = await host.create({ command: 'sleep 30' });
  await host.kill({ terminalId });
  const { exitStatus } = await host.waitForExit({ terminalId });
  // Either an exitCode (some shells) or a signal name — both are acceptable
  // evidence of a forced kill.
  const killed = (exitStatus?.signal != null) || (exitStatus?.exitCode != null && exitStatus.exitCode !== 0);
  assert.equal(killed, true);
  host.shutdownAll();
});

test('shutdownAll empties the internal terminal map', async () => {
  const host = createTerminalHost({ getCwd: () => makeScope() });
  await host.create({ command: 'echo a' });
  await host.create({ command: 'echo b' });
  assert.equal(host._terminals.size, 2);
  host.shutdownAll();
  assert.equal(host._terminals.size, 0);
});
