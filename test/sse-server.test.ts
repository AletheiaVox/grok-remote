import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';

import { writeHeaders, writeEvent, writePing } from '../lib/sse.js';

// Minimal ServerResponse stand-in. Records writeHead/write/end calls so the
// tests can assert on the SSE wire format.
interface FakeRes {
  writableEnded: boolean;
  destroyed: boolean;
  socket: { setNoDelay(v: boolean): void } | null;
  status: number | null;
  headers: Record<string, string> | null;
  chunks: string[];
  flushed: boolean;
  writeHead(status: number, headers: Record<string, string>): void;
  flushHeaders?(): void;
  write(s: string): boolean;
}

function makeRes(overrides: Partial<FakeRes> = {}): FakeRes {
  return {
    writableEnded: false,
    destroyed: false,
    socket: { setNoDelay: () => { /* recorded via Object.defineProperty below */ } },
    status: null,
    headers: null,
    chunks: [],
    flushed: false,
    writeHead(status, headers): void {
      this.status = status;
      this.headers = headers;
    },
    flushHeaders(): void { this.flushed = true; },
    write(s: string): boolean {
      this.chunks.push(s);
      return true;
    },
    ...overrides,
  };
}

test('writeHeaders sets the SSE content type and pushes the retry hint', () => {
  const res = makeRes();
  writeHeaders(res as unknown as ServerResponse);
  assert.equal(res.status, 200);
  assert.equal(res.headers && res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers && res.headers['Cache-Control'], 'no-cache, no-transform');
  assert.equal(res.headers && res.headers['Connection'], 'keep-alive');
  assert.equal(res.headers && res.headers['X-Accel-Buffering'], 'no');
  assert.equal(res.chunks.join(''), 'retry: 5000\n\n');
  assert.equal(res.flushed, true);
});

test('writeHeaders disables Nagle on the underlying socket', () => {
  // Disabling Nagle is the difference between events shipping immediately and
  // sitting in the 200ms TCP coalescing window. Verify the socket call lands.
  let nodelay = false;
  const res = makeRes({ socket: { setNoDelay(v) { nodelay = v; } } });
  writeHeaders(res as unknown as ServerResponse);
  assert.equal(nodelay, true);
});

test('writeHeaders is robust against missing socket or flushHeaders', () => {
  const res = makeRes({ socket: null });
  delete (res as { flushHeaders?: () => void }).flushHeaders;
  // Should not throw even when the optional hooks aren't present.
  writeHeaders(res as unknown as ServerResponse);
  assert.equal(res.status, 200);
});

test('writeEvent emits id, event, and data lines with the SSE delimiter', () => {
  const res = makeRes();
  const ok = writeEvent(res as unknown as ServerResponse, { id: 42, event: 'agent.update', data: { hello: 'world' } });
  assert.equal(ok, true);
  assert.equal(res.chunks.join(''),
    'id: 42\nevent: agent.update\ndata: {"hello":"world"}\n\n',
  );
});

test('writeEvent stringifies non-string data and serializes objects via JSON', () => {
  const res = makeRes();
  writeEvent(res as unknown as ServerResponse, { data: [1, 2, 3] });
  assert.equal(res.chunks.join(''), 'data: [1,2,3]\n\n');
});

test('writeEvent writes raw string data without re-serializing', () => {
  // Avoid double-quoting: when the caller already controls the payload
  // string, the helper should treat it as opaque.
  const res = makeRes();
  writeEvent(res as unknown as ServerResponse, { data: 'plain-string-payload' });
  assert.equal(res.chunks.join(''), 'data: plain-string-payload\n\n');
});

test('writeEvent splits multi-line data into one "data:" line per source line (SSE spec)', () => {
  const res = makeRes();
  writeEvent(res as unknown as ServerResponse, { event: 'log', data: 'line one\nline two\nline three' });
  assert.equal(res.chunks.join(''),
    'event: log\ndata: line one\ndata: line two\ndata: line three\n\n',
  );
});

test('writeEvent omits the id: prefix when id is null or undefined', () => {
  const res = makeRes();
  writeEvent(res as unknown as ServerResponse, { id: null, event: 'tick', data: 'x' });
  assert.equal(res.chunks.join(''), 'event: tick\ndata: x\n\n');
});

test('writeEvent returns false and writes nothing when the response is already closed', () => {
  const ended = makeRes({ writableEnded: true });
  assert.equal(writeEvent(ended as unknown as ServerResponse, { data: 'x' }), false);
  assert.deepEqual(ended.chunks, []);

  const destroyed = makeRes({ destroyed: true });
  assert.equal(writeEvent(destroyed as unknown as ServerResponse, { data: 'x' }), false);
  assert.deepEqual(destroyed.chunks, []);
});

test('writePing emits the SSE comment heartbeat', () => {
  const res = makeRes();
  writePing(res as unknown as ServerResponse);
  assert.equal(res.chunks.join(''), ': ping\n\n');
});

test('writePing is a no-op when the response is closed or destroyed', () => {
  const ended = makeRes({ writableEnded: true });
  writePing(ended as unknown as ServerResponse);
  assert.deepEqual(ended.chunks, []);

  const destroyed = makeRes({ destroyed: true });
  writePing(destroyed as unknown as ServerResponse);
  assert.deepEqual(destroyed.chunks, []);
});
