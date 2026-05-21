import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUB_AGENT_KIND_RE,
  isSubAgentCall,
  pickSubAgentLabel,
  pickToolLabel,
  extractToolContent,
  mergeToolContent,
  countActive,
  normaliseStatus,
  buildSparkPath,
  safeStringify,
  formatTokens,
  fmtDuration,
  truncCmd,
} from '../src/views/system/flow-helpers.js';

test('SUB_AGENT_KIND_RE matches "Agent" and "Agent(...)" variants', () => {
  assert.ok(SUB_AGENT_KIND_RE.test('Agent'));
  assert.ok(SUB_AGENT_KIND_RE.test('agent'));
  assert.ok(SUB_AGENT_KIND_RE.test('Agent(explore)'));
  assert.ok(SUB_AGENT_KIND_RE.test('AGENT(planner)'));
  assert.equal(SUB_AGENT_KIND_RE.test('AgentBuilder'), false);
  assert.equal(SUB_AGENT_KIND_RE.test('Read'), false);
});

test('isSubAgentCall detects rawInput.variant === "Task"', () => {
  assert.equal(isSubAgentCall({ kind: 'Read', rawInput: { variant: 'Task' } }), true);
});

test('isSubAgentCall detects non-empty rawInput.subagent_type', () => {
  assert.equal(isSubAgentCall({ kind: 'Read', rawInput: { subagent_type: 'general-purpose' } }), true);
  assert.equal(isSubAgentCall({ kind: 'Read', rawInput: { subagent_type: '' } }), false);
});

test('isSubAgentCall detects legacy kind matching Agent regex', () => {
  assert.equal(isSubAgentCall({ kind: 'Agent' }), true);
  assert.equal(isSubAgentCall({ kind: 'agent(explore)' }), true);
});

test('isSubAgentCall returns false for ordinary tool calls', () => {
  assert.equal(isSubAgentCall({ kind: 'Read', rawInput: { path: '/etc/hosts' } }), false);
  assert.equal(isSubAgentCall({ kind: 'Bash', rawInput: { command: 'ls' } }), false);
});

test('isSubAgentCall is null-safe', () => {
  assert.equal(isSubAgentCall(null), false);
  assert.equal(isSubAgentCall(undefined), false);
  assert.equal(isSubAgentCall(42), false);
  assert.equal(isSubAgentCall({}), false);
});

test('pickSubAgentLabel prefers rawInput.description', () => {
  assert.equal(
    pickSubAgentLabel({ title: 't', rawInput: { description: 'find foo', prompt: 'long...' } }),
    'find foo',
  );
});

test('pickSubAgentLabel falls back to title when no description', () => {
  assert.equal(
    pickSubAgentLabel({ title: 'planner', rawInput: { prompt: 'long...' } }),
    'planner',
  );
});

test('pickSubAgentLabel uses first line of prompt, capped at 80 chars', () => {
  const longPrompt = 'first short line\nsecond line\nthird line';
  assert.equal(pickSubAgentLabel({ rawInput: { prompt: longPrompt } }), 'first short line');

  const veryLong = 'a'.repeat(120);
  assert.equal(pickSubAgentLabel({ rawInput: { prompt: veryLong } }).length, 80);
});

test('pickSubAgentLabel returns "sub-agent" fallback for empty input', () => {
  assert.equal(pickSubAgentLabel({}), 'sub-agent');
  assert.equal(pickSubAgentLabel(null), 'sub-agent');
  assert.equal(pickSubAgentLabel({ title: '   ' }), 'sub-agent');
});

test('pickToolLabel prefers payload.title when present', () => {
  assert.equal(pickToolLabel({ title: 'Read /etc/hosts', kind: 'Read' }), 'Read /etc/hosts');
});

test('pickToolLabel uses rawInput.command then .cmd before falling back', () => {
  assert.equal(pickToolLabel({ kind: 'Bash', rawInput: { command: 'ls -la' } }), 'ls -la');
  assert.equal(pickToolLabel({ kind: 'Bash', rawInput: { cmd: 'pwd' } }), 'pwd');
});

test('pickToolLabel composes "<kind>: <path>" for read-like calls', () => {
  assert.equal(
    pickToolLabel({ kind: 'Read', rawInput: { path: '/etc/hosts' } }),
    'Read: /etc/hosts',
  );
  assert.equal(
    pickToolLabel({ kind: 'Edit', rawInput: { file_path: 'src/app.ts' } }),
    'Edit: src/app.ts',
  );
});

test('pickToolLabel uses url then kind then default fallback', () => {
  assert.equal(pickToolLabel({ kind: 'Fetch', rawInput: { url: 'https://x.ai' } }), 'https://x.ai');
  assert.equal(pickToolLabel({ kind: 'CustomKind' }), 'CustomKind');
  assert.equal(pickToolLabel({}), 'tool');
  assert.equal(pickToolLabel(null), 'tool');
});

test('extractToolContent returns empty array for nullish/non-string-non-array input', () => {
  assert.deepEqual(extractToolContent(null), []);
  assert.deepEqual(extractToolContent(undefined), []);
  assert.deepEqual(extractToolContent(42), []);
  assert.deepEqual(extractToolContent({ not: 'an array' }), []);
});

test('extractToolContent wraps a bare string in a single text block', () => {
  assert.deepEqual(extractToolContent('inline'), [{ kind: 'text', text: 'inline' }]);
});

test('extractToolContent handles ACP type:text/content blocks via content.text', () => {
  assert.deepEqual(
    extractToolContent([{ type: 'text', content: { text: 'wrapped' } }]),
    [{ kind: 'text', text: 'wrapped' }],
  );
});

test('extractToolContent falls back through .text and .content fields', () => {
  assert.deepEqual(
    extractToolContent([{ text: 'a' }, { content: 'b' }]),
    [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }],
  );
});

test('extractToolContent stringifies unknown block shapes as JSON', () => {
  const blocks = extractToolContent([{ type: 'image', url: 'x' }]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.kind, 'image');
  assert.match(blocks[0]!.text, /"url":"x"/);
});

test('mergeToolContent returns next when prev is empty', () => {
  assert.deepEqual(mergeToolContent([], [{ kind: 'text', text: 'a' }]),
    [{ kind: 'text', text: 'a' }]);
});

test('mergeToolContent returns prev when next is empty', () => {
  assert.deepEqual(mergeToolContent([{ kind: 'text', text: 'a' }], []),
    [{ kind: 'text', text: 'a' }]);
});

test('mergeToolContent deduplicates a matching prev-tail / next-head pair', () => {
  // Repeated full-snapshot updates after a delta would otherwise double up.
  const merged = mergeToolContent(
    [{ kind: 'text', text: 'hello' }],
    [{ kind: 'text', text: 'hello' }, { kind: 'text', text: 'world' }],
  );
  assert.deepEqual(merged, [
    { kind: 'text', text: 'hello' },
    { kind: 'text', text: 'world' },
  ]);
});

test('mergeToolContent concatenates when tail/head differ', () => {
  const merged = mergeToolContent(
    [{ kind: 'text', text: 'a' }],
    [{ kind: 'text', text: 'b' }],
  );
  assert.deepEqual(merged, [
    { kind: 'text', text: 'a' },
    { kind: 'text', text: 'b' },
  ]);
});

test('mergeToolContent handles null/undefined inputs gracefully', () => {
  assert.deepEqual(mergeToolContent(null, null), []);
  assert.deepEqual(mergeToolContent(null, [{ kind: 'text', text: 'x' }]),
    [{ kind: 'text', text: 'x' }]);
  assert.deepEqual(mergeToolContent([{ kind: 'text', text: 'x' }], null),
    [{ kind: 'text', text: 'x' }]);
});

test('countActive counts calls with no endedAt', () => {
  assert.equal(countActive({
    a: { endedAt: null },
    b: { endedAt: 12345 },
    c: { endedAt: 0 },        // 0 means falsy in this reducer
    d: {},
  }), 3);
});

test('countActive returns 0 for an empty map', () => {
  assert.equal(countActive({}), 0);
});

test('normaliseStatus passes through running/idle/errored unchanged', () => {
  assert.equal(normaliseStatus('running'),  'running');
  assert.equal(normaliseStatus('idle'),     'idle');
  assert.equal(normaliseStatus('errored'),  'errored');
});

test('normaliseStatus collapses exited and killed to disconnected', () => {
  // The UI shows both as "disconnected" so we fold them ahead of rendering.
  assert.equal(normaliseStatus('exited'), 'disconnected');
  assert.equal(normaliseStatus('killed'), 'disconnected');
});

test('normaliseStatus returns "unknown" for nullish/empty input', () => {
  assert.equal(normaliseStatus(null),      'unknown');
  assert.equal(normaliseStatus(undefined), 'unknown');
  assert.equal(normaliseStatus(''),        'unknown');
});

test('buildSparkPath emits an M-then-L sequence for multiple points', () => {
  const out = buildSparkPath(
    [{ v: 10 }, { v: 30 }, { v: 20 }],
    100, 20,
  );
  // First command is M (move-to), rest are L (line-to).
  assert.match(out.line, /^M /);
  const lCount = (out.line.match(/L /g) || []).length;
  assert.equal(lCount, 2);
});

test('buildSparkPath area path closes back to the baseline', () => {
  const out = buildSparkPath([{ v: 5 }, { v: 15 }], 50, 10);
  // The area should end with " L W H L 0 H Z" so the fill spans below the line.
  assert.match(out.area, /L 50 10 L 0 10 Z$/);
});

test('buildSparkPath handles a single-point history without divide-by-zero', () => {
  const out = buildSparkPath([{ v: 42 }], 100, 20);
  // n === 1 hard-codes x=0 so the lone point lands at the left edge.
  assert.match(out.line, /^M 0\.00/);
});

test('buildSparkPath tolerates a flat history (max === min)', () => {
  // range = max(1, 0) = 1 — no NaN.
  const out = buildSparkPath([{ v: 7 }, { v: 7 }, { v: 7 }], 100, 20);
  assert.equal(out.line.includes('NaN'), false);
});

test('safeStringify returns the empty string for null and undefined', () => {
  assert.equal(safeStringify(null), '');
  assert.equal(safeStringify(undefined), '');
});

test('safeStringify returns plain strings as-is', () => {
  assert.equal(safeStringify('hello'), 'hello');
  assert.equal(safeStringify(''), '');
});

test('safeStringify pretty-prints objects with 2-space indent', () => {
  assert.equal(safeStringify({ a: 1 }), '{\n  "a": 1\n}');
});

test('safeStringify falls back to String() when JSON.stringify throws', () => {
  // Build a cyclic reference so JSON.stringify throws.
  const a: Record<string, unknown> = {};
  a.self = a;
  // Should not throw — falls through to String(v).
  const out = safeStringify(a);
  assert.match(out, /\[object Object\]/);
});

test('formatTokens uses the flow-specific thresholds (under 1k passes through)', () => {
  assert.equal(formatTokens(0),    '0');
  assert.equal(formatTokens(999),  '999');
  assert.equal(formatTokens(1000), '1.0k');
  assert.equal(formatTokens(2500), '2.5k');
});

test('formatTokens switches to M with two decimals above 1M', () => {
  assert.equal(formatTokens(1_000_000),  '1.00M');
  assert.equal(formatTokens(2_345_000),  '2.35M');
  assert.equal(formatTokens(12_000_000), '12.00M');
});

test('formatTokens handles non-finite input gracefully', () => {
  assert.equal(formatTokens(NaN),       '0');
  assert.equal(formatTokens(Infinity),  '0');
});

test('fmtDuration formats sub-second, second, and minute ranges', () => {
  assert.equal(fmtDuration(50),     '50ms');
  assert.equal(fmtDuration(999),    '999ms');
  assert.equal(fmtDuration(1500),   '1.5s');
  assert.equal(fmtDuration(9999),   '10.0s');
  assert.equal(fmtDuration(10001),  '10s');
  assert.equal(fmtDuration(60_000), '1m');
  assert.equal(fmtDuration(65_000), '1m 5s');
});

test('fmtDuration returns empty string for non-finite or negative ms', () => {
  assert.equal(fmtDuration(NaN),       '');
  assert.equal(fmtDuration(-5),        '');
  assert.equal(fmtDuration(Infinity),  '');
});

test('truncCmd collapses whitespace and trims', () => {
  assert.equal(truncCmd('  hello   world  '), 'hello world');
  assert.equal(truncCmd('tab\there'),          'tab here');
});

test('truncCmd caps at 40 characters with an ellipsis suffix', () => {
  // 50 chars in → 37 chars + "..." = 40
  const out = truncCmd('a'.repeat(50));
  assert.equal(out.length, 40);
  assert.match(out, /\.\.\.$/);
});

test('truncCmd returns "(no command)" for empty input', () => {
  assert.equal(truncCmd(''),        '(no command)');
  assert.equal(truncCmd('   '),     '(no command)');
  assert.equal(truncCmd(null),      '(no command)');
  assert.equal(truncCmd(undefined), '(no command)');
});
