import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

import { agentDir, historyPath } from '../lib/history.js';

const EXPECTED_ROOT = path.join(os.homedir(), '.grok-remote', 'agents');

test('agentDir returns ~/.grok-remote/agents/<id>', () => {
  assert.equal(agentDir('abc-123'), path.join(EXPECTED_ROOT, 'abc-123'));
});

test('historyPath returns the agent dir + history.jsonl', () => {
  assert.equal(historyPath('abc-123'), path.join(EXPECTED_ROOT, 'abc-123', 'history.jsonl'));
});

test('agentDir keeps the input id verbatim (no normalization)', () => {
  // Path traversal is the caller's responsibility — this helper does not
  // sanitize, but it should also not silently strip or rewrite. Document the
  // pass-through contract so future refactors don't quietly add normalization.
  assert.equal(agentDir(' weird-id '), path.join(EXPECTED_ROOT, ' weird-id '));
});

test('historyPath consistently composes from agentDir', () => {
  const id = 'roundtrip-test';
  assert.equal(historyPath(id), path.join(agentDir(id), 'history.jsonl'));
});
