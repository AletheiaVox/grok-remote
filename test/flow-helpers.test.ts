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
