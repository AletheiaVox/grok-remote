import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scanOutputForUrl,
  parsePortFromCommand,
  looksLikeDevServer,
  inferDevServerUrl,
} from '../lib/dev-url.js';

test('scanOutputForUrl returns null for empty or non-string input', () => {
  assert.equal(scanOutputForUrl(null), null);
  assert.equal(scanOutputForUrl(undefined), null);
  assert.equal(scanOutputForUrl(''), null);
  assert.equal(scanOutputForUrl(42), null);
});

test('scanOutputForUrl extracts vite-style banner URLs', () => {
  const out = '\n  vite v5.4.0  ready in 234 ms\n\n  ➜  Local:   http://localhost:5173/\n';
  assert.equal(scanOutputForUrl(out), 'http://localhost:5173/');
});

test('scanOutputForUrl strips ANSI escape sequences before matching', () => {
  const ansi = '\x1b[36m  ➜\x1b[0m  Local: \x1b[1mhttp://localhost:5173/\x1b[0m';
  assert.equal(scanOutputForUrl(ansi), 'http://localhost:5173/');
});

test('scanOutputForUrl rewrites 0.0.0.0 to localhost', () => {
  assert.equal(
    scanOutputForUrl('Listening on http://0.0.0.0:8080/'),
    'http://localhost:8080/',
  );
});

test('parsePortFromCommand reads --port', () => {
  assert.equal(parsePortFromCommand('vite --port 4001'), 4001);
  assert.equal(parsePortFromCommand('next dev --port=4002'), 4002);
});

test('parsePortFromCommand reads -p shorthand', () => {
  assert.equal(parsePortFromCommand('serve -p 4003'), 4003);
});

test('parsePortFromCommand picks up host:port bind strings', () => {
  assert.equal(parsePortFromCommand('python -m http.server localhost:9999'), 9999);
});

test('parsePortFromCommand uses framework defaults when no explicit port', () => {
  assert.equal(parsePortFromCommand('next dev'), 3000);
  assert.equal(parsePortFromCommand('vite'), 5173);
  assert.equal(parsePortFromCommand('streamlit run app.py'), 8501);
  assert.equal(parsePortFromCommand('flask run'), 5000);
  assert.equal(parsePortFromCommand('jekyll serve'), 4000);
});

test('parsePortFromCommand returns null for unknown commands', () => {
  assert.equal(parsePortFromCommand('cargo build'), null);
  assert.equal(parsePortFromCommand(null), null);
  assert.equal(parsePortFromCommand(123), null);
});

test('looksLikeDevServer detects known dev-server commands', () => {
  assert.equal(looksLikeDevServer('vite'), true);
  assert.equal(looksLikeDevServer('npm run dev'), true);
  assert.equal(looksLikeDevServer('pnpm dev'), true);
  assert.equal(looksLikeDevServer('cargo build'), false);
  assert.equal(looksLikeDevServer(null), false);
});

test('inferDevServerUrl prefers a matched output URL over a command guess', () => {
  assert.equal(
    inferDevServerUrl('vite --port 9999', 'Local: http://localhost:5173/'),
    'http://localhost:5173/',
  );
});

test('inferDevServerUrl falls back to command parsing when output has no URL', () => {
  assert.equal(inferDevServerUrl('next dev', ''), 'http://localhost:3000/');
  assert.equal(inferDevServerUrl('vite', null), 'http://localhost:5173/');
});

test('inferDevServerUrl returns null for non-dev-server commands', () => {
  assert.equal(inferDevServerUrl('cargo build', 'compiling...'), null);
});
