import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, isTodoWriteToolCall } from '../src/lib/render.js';

test('escapeHtml escapes the four HTML-significant characters', () => {
  assert.equal(escapeHtml('&'), '&amp;');
  assert.equal(escapeHtml('<'), '&lt;');
  assert.equal(escapeHtml('>'), '&gt;');
  assert.equal(escapeHtml('"'), '&quot;');
});

test('escapeHtml passes through ordinary text unchanged', () => {
  assert.equal(escapeHtml('hello world'), 'hello world');
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml('1 + 1 = 2'), '1 + 1 = 2');
});

test('escapeHtml escapes a realistic injection payload', () => {
  assert.equal(
    escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
  );
});

test('escapeHtml replaces & before < and > so re-escaping does not double up', () => {
  // If we processed `<` first we would produce `&lt;` and then re-escape the
  // `&` to `&amp;lt;`. Verify the implementation orders & first.
  assert.equal(escapeHtml('<a>'), '&lt;a&gt;');
  assert.equal(escapeHtml('a & b > c'), 'a &amp; b &gt; c');
});

test('escapeHtml stringifies non-string input', () => {
  assert.equal(escapeHtml(42 as unknown as string), '42');
  assert.equal(escapeHtml(null as unknown as string), 'null');
  assert.equal(escapeHtml(undefined as unknown as string), 'undefined');
});

test('isTodoWriteToolCall identifies grok TodoWrite calls by rawInput.variant', () => {
  assert.equal(isTodoWriteToolCall({ rawInput: { variant: 'TodoWrite' } }), true);
  assert.equal(isTodoWriteToolCall({ rawInput: { variant: 'TodoWrite', todos: [] } }), true);
});

test('isTodoWriteToolCall returns false for other tool kinds', () => {
  assert.equal(isTodoWriteToolCall({ rawInput: { variant: 'Read' } }), false);
  assert.equal(isTodoWriteToolCall({ rawInput: { command: 'ls' } }), false);
  assert.equal(isTodoWriteToolCall({ kind: 'TodoWrite' }), false); // kind alone is not enough
});

test('isTodoWriteToolCall returns false for missing or malformed input', () => {
  // The strict signature is `ToolPayload | null | undefined`, but the function
  // also guards against `rawInput: null` at runtime. Cast through unknown for
  // the null case so the runtime guard is exercised under tsc strict.
  assert.equal(isTodoWriteToolCall(null), false);
  assert.equal(isTodoWriteToolCall(undefined), false);
  assert.equal(isTodoWriteToolCall({}), false);
  assert.equal(isTodoWriteToolCall({ rawInput: null } as unknown as Parameters<typeof isTodoWriteToolCall>[0]), false);
  assert.equal(isTodoWriteToolCall({ rawInput: undefined }), false);
});
