import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  sanitizeFilename,
  uniqueUploadName,
  humanSize,
  attachmentLine,
} from '../lib/agent-manager.js';

test('sanitizeFilename keeps safe characters as-is', () => {
  assert.equal(sanitizeFilename('image.png'),     'image.png');
  assert.equal(sanitizeFilename('my-file_01.jpg'), 'my-file_01.jpg');
});

test('sanitizeFilename strips path separators to prevent traversal', () => {
  // `..` becomes `..`, then `/` becomes `_`, then the leading-dots rewrite
  // collapses the `..` to a single `_`, leaving `__etc_passwd`. The contract
  // we care about is that no path-separator survives; the exact form is
  // implementation-defined but documented here so changes get caught.
  assert.equal(sanitizeFilename('../etc/passwd'),  '__etc_passwd');
  assert.equal(sanitizeFilename('foo\\bar.png'),    'foo_bar.png');
});

test('sanitizeFilename replaces non-portable characters with underscores', () => {
  assert.equal(sanitizeFilename('file with spaces.png'), 'file_with_spaces.png');
  assert.equal(sanitizeFilename('drop*table?.png'),       'drop_table_.png');
});

test('sanitizeFilename rewrites leading dots so the result is never hidden', () => {
  // A leading dot on macOS / linux makes the file hidden in directory
  // listings and `tar -czf ...` archives. Coerce to underscore.
  assert.equal(sanitizeFilename('.hidden'),    '_hidden');
  assert.equal(sanitizeFilename('...rc'),      '_rc');
});

test('sanitizeFilename caps length at 100 characters', () => {
  const big = 'a'.repeat(200) + '.png';
  const out = sanitizeFilename(big);
  assert.equal(out.length, 100);
});

test('sanitizeFilename returns an empty string for nullish input', () => {
  assert.equal(sanitizeFilename(null),      '');
  assert.equal(sanitizeFilename(undefined), '');
  assert.equal(sanitizeFilename(''),        '');
});

test('uniqueUploadName returns the sanitized name when the slot is free', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-uploadname-'));
  assert.equal(uniqueUploadName(dir, 'pic.png', 'image/png'), 'pic.png');
});

test('uniqueUploadName appends a numeric suffix on collision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-uploadname-'));
  fs.writeFileSync(path.join(dir, 'pic.png'), 'first');
  assert.equal(uniqueUploadName(dir, 'pic.png', 'image/png'), 'pic-1.png');
  fs.writeFileSync(path.join(dir, 'pic-1.png'), 'second');
  assert.equal(uniqueUploadName(dir, 'pic.png', 'image/png'), 'pic-2.png');
});

test('uniqueUploadName falls back to a timestamped name when sanitized is empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-uploadname-'));
  const out = uniqueUploadName(dir, '', 'image/png');
  // image-<digits>.png pattern. The extension comes from MIME_EXT lookup.
  assert.match(out, /^image-\d+\.png$/);
});

test('uniqueUploadName fallback handles unknown mime by leaving out the extension', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-uploadname-'));
  const out = uniqueUploadName(dir, undefined, 'application/x-grok-binary');
  assert.match(out, /^image-\d+$/);
});

test('humanSize formats bytes / kB / MB at each boundary', () => {
  assert.equal(humanSize(0),                  '0 bytes');
  assert.equal(humanSize(1023),               '1023 bytes');
  assert.equal(humanSize(1024),               '1.0 kB');
  assert.equal(humanSize(1024 * 1024 - 1),    '1024.0 kB');
  assert.equal(humanSize(1024 * 1024),        '1.0 MB');
  assert.equal(humanSize(5 * 1024 * 1024),    '5.0 MB');
});

test('humanSize returns a sentinel for non-finite input', () => {
  assert.equal(humanSize(NaN),       '? bytes');
  assert.equal(humanSize(Infinity),  '? bytes');
  assert.equal(humanSize(-Infinity), '? bytes');
});

test('attachmentLine composes the prompt line with abs path, mime, and human size', () => {
  assert.equal(
    attachmentLine({
      rel: 'uploads/a.png',
      abs: '/tmp/work/uploads/a.png',
      mimeType: 'image/png',
      size: 2048,
    }),
    '- /tmp/work/uploads/a.png (image/png, 2.0 kB)',
  );
});

test('attachmentLine falls back to application/octet-stream when mime is missing', () => {
  assert.equal(
    attachmentLine({
      rel: 'uploads/blob',
      abs: '/tmp/work/uploads/blob',
      mimeType: null,
      size: 42,
    }),
    '- /tmp/work/uploads/blob (application/octet-stream, 42 bytes)',
  );
});
