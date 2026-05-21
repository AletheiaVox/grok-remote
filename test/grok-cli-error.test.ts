import test from 'node:test';
import assert from 'node:assert/strict';

import { GrokCliError, errorToResponse } from '../lib/grok-cli.js';

test('GrokCliError extends Error with the expected name and message', () => {
  const err = new GrokCliError('grok crashed');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'GrokCliError');
  assert.equal(err.message, 'grok crashed');
});

test('GrokCliError defaults code/stdout/stderr/args when init is empty', () => {
  const err = new GrokCliError('bare');
  assert.equal(err.code, null);
  assert.equal(err.stdout, '');
  assert.equal(err.stderr, '');
  assert.equal(err.args, null);
});

test('GrokCliError captures subprocess context from init', () => {
  const err = new GrokCliError('exit non-zero', {
    code: 2,
    stdout: 'partial output',
    stderr: 'something broke',
    args: ['inspect', '--json'],
  });
  assert.equal(err.code, 2);
  assert.equal(err.stdout, 'partial output');
  assert.equal(err.stderr, 'something broke');
  assert.deepEqual(err.args, ['inspect', '--json']);
});

test('errorToResponse formats a GrokCliError with all subprocess context', () => {
  const err = new GrokCliError('non-zero exit', {
    code: 7,
    stdout: 'tail-stdout',
    stderr: 'tail-stderr',
    args: ['agents', 'list'],
  });
  assert.deepEqual(errorToResponse(err), {
    ok: false,
    error: 'non-zero exit',
    code: 7,
    stderr: 'tail-stderr',
    stdout: 'tail-stdout',
    args: ['agents', 'list'],
  });
});

test('errorToResponse truncates very long stdout/stderr to the last 2000 chars', () => {
  // Surfacing 50KB of subprocess noise in a JSON response wedges UIs. The
  // helper keeps the trailing 2000 chars where the actual failure usually
  // is.
  const big = 'x'.repeat(5000);
  const err = new GrokCliError('overflow', { stdout: big, stderr: big });
  const resp = errorToResponse(err);
  assert.equal(resp.stdout?.length, 2000);
  assert.equal(resp.stderr?.length, 2000);
  assert.equal(resp.stdout?.slice(-3), 'xxx');
});

test('errorToResponse falls back to plain message for non-CLI errors', () => {
  const err = new Error('something else');
  assert.deepEqual(errorToResponse(err), { ok: false, error: 'something else' });
});

test('errorToResponse stringifies non-Error throws', () => {
  assert.deepEqual(errorToResponse('not-an-error'),
    { ok: false, error: 'not-an-error' });
  assert.deepEqual(errorToResponse(42),
    { ok: false, error: '42' });
  assert.deepEqual(errorToResponse(null),
    { ok: false, error: 'null' });
});
