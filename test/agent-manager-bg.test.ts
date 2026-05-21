import test from 'node:test';
import assert from 'node:assert/strict';

import { countRunningBg, type BgTask } from '../lib/agent-manager.js';

// `countRunningBg` counts non-completed BgTasks on an agent record. The full
// AgentRecord type is private (extends AgentMeta + carries AcpClient/SseRing),
// but the function only reads `bgTasks`, so we cast a minimal stub through
// `unknown` rather than building the full record.

interface FakeRecord {
  bgTasks?: Map<string, BgTask>;
}

function fakeBg(id: string, completed: boolean): BgTask {
  return {
    id,
    tool_call_id: null,
    command: 'echo bg',
    cwd: '/tmp',
    output_file: `/tmp/${id}.log`,
    startedAt: 0,
    completed,
    exit_code: completed ? 0 : null,
    signal: null,
    kind: 'grok-bg',
  };
}

function rec(...tasks: BgTask[]): FakeRecord {
  const m = new Map<string, BgTask>();
  for (const t of tasks) m.set(t.id, t);
  return { bgTasks: m };
}

test('countRunningBg returns 0 for a null or undefined record', () => {
  // Defensive: AgentManager handlers occasionally hand us a record we never
  // tracked; counting `null` should not throw and must report zero.
  assert.equal(countRunningBg(null as unknown as Parameters<typeof countRunningBg>[0]), 0);
  assert.equal(countRunningBg(undefined as unknown as Parameters<typeof countRunningBg>[0]), 0);
});

test('countRunningBg returns 0 when the record has no bgTasks map', () => {
  assert.equal(countRunningBg({} as unknown as Parameters<typeof countRunningBg>[0]), 0);
});

test('countRunningBg returns 0 when every task is completed', () => {
  const r = rec(fakeBg('a', true), fakeBg('b', true));
  assert.equal(countRunningBg(r as unknown as Parameters<typeof countRunningBg>[0]), 0);
});

test('countRunningBg counts only non-completed tasks', () => {
  const r = rec(
    fakeBg('a', false),
    fakeBg('b', true),
    fakeBg('c', false),
    fakeBg('d', true),
  );
  assert.equal(countRunningBg(r as unknown as Parameters<typeof countRunningBg>[0]), 2);
});

test('countRunningBg over an empty bgTasks map is 0', () => {
  const r: FakeRecord = { bgTasks: new Map() };
  assert.equal(countRunningBg(r as unknown as Parameters<typeof countRunningBg>[0]), 0);
});
