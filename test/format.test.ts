import test from 'node:test';
import assert from 'node:assert/strict';

import { fmtTokens } from '../src/lib/format.js';

test('fmtTokens returns empty string for non-positive values', () => {
  assert.equal(fmtTokens(0), '');
  assert.equal(fmtTokens(-5), '');
  assert.equal(fmtTokens(NaN), '');
  assert.equal(fmtTokens(Infinity), '');
});

test('fmtTokens passes through values under 1000', () => {
  assert.equal(fmtTokens(1), '1');
  assert.equal(fmtTokens(42), '42');
  assert.equal(fmtTokens(999), '999');
});

test('fmtTokens uses k for 1k-9.9k with one decimal, stripping trailing .0', () => {
  assert.equal(fmtTokens(1000), '1k');
  assert.equal(fmtTokens(1500), '1.5k');
  assert.equal(fmtTokens(2300), '2.3k');
  assert.equal(fmtTokens(9999), '10k');
});

test('fmtTokens uses k with no decimal for 10k-999k', () => {
  assert.equal(fmtTokens(10000), '10k');
  assert.equal(fmtTokens(50000), '50k');
  assert.equal(fmtTokens(999999), '1000k');
});

test('fmtTokens uses M for 1M and above, stripping trailing .0', () => {
  assert.equal(fmtTokens(1_000_000), '1M');
  assert.equal(fmtTokens(2_500_000), '2.5M');
  assert.equal(fmtTokens(10_000_000), '10M');
});
