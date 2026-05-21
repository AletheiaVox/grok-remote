import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { send, readJsonBody } from '../lib/routes/helpers.js';

// Minimal stand-in for ServerResponse with the surface that send() touches.
interface FakeRes {
  status: number | null;
  headers: Record<string, string> | null;
  body: string | null;
  headersSent: boolean;
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string): void;
}

function makeRes(): FakeRes {
  return {
    status: null,
    headers: null,
    body: null,
    headersSent: false,
    writeHead(status, headers): void {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body): void {
      this.body = body;
    },
  };
}

test('send writes status, JSON content type, and a stringified body', () => {
  const res = makeRes();
  send(res as unknown as ServerResponse, 200, { ok: true, n: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.headers && res.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(res.body, JSON.stringify({ ok: true, n: 1 }));
});

test('send is a no-op once headers have already gone out', () => {
  // Servers sometimes hit an error path after streaming has already begun.
  // The helper guards against double-write so we don't trip ERR_HTTP_HEADERS_SENT.
  const res = makeRes();
  res.headersSent = true;
  send(res as unknown as ServerResponse, 500, { error: 'late' });
  assert.equal(res.status, null);
  assert.equal(res.body, null);
});

test('send accepts arbitrary serializable shapes', () => {
  const res = makeRes();
  send(res as unknown as ServerResponse, 201, ['a', 'b', 'c']);
  assert.equal(res.status, 201);
  assert.equal(res.body, '["a","b","c"]');
});

// Build a fake IncomingMessage by extending EventEmitter and emitting the
// data/end events readJsonBody listens for. destroy() needs to fire 'error'.
class FakeReq extends EventEmitter {
  destroy(err?: Error): void {
    if (err) this.emit('error', err);
  }
}

function feed(req: FakeReq, chunks: (string | Buffer)[], { errorAfter }: { errorAfter?: number } = {}): void {
  process.nextTick(() => {
    let i = 0;
    for (const c of chunks) {
      req.emit('data', typeof c === 'string' ? Buffer.from(c, 'utf8') : c);
      i++;
      if (errorAfter !== undefined && i === errorAfter) {
        req.emit('error', new Error('boom'));
        return;
      }
    }
    req.emit('end');
  });
}

test('readJsonBody parses a single-chunk JSON body', async () => {
  const req = new FakeReq();
  const p = readJsonBody(req as unknown as IncomingMessage);
  feed(req, [JSON.stringify({ hello: 'world' })]);
  assert.deepEqual(await p, { hello: 'world' });
});

test('readJsonBody concatenates multiple chunks before parsing', async () => {
  const req = new FakeReq();
  const p = readJsonBody(req as unknown as IncomingMessage);
  feed(req, ['{"a":', '1,', '"b":', '"two"}']);
  assert.deepEqual(await p, { a: 1, b: 'two' });
});

test('readJsonBody returns an empty object when the body has zero bytes', async () => {
  const req = new FakeReq();
  const p = readJsonBody(req as unknown as IncomingMessage);
  feed(req, []);
  assert.deepEqual(await p, {});
});

test('readJsonBody rejects with a descriptive error when JSON is malformed', async () => {
  const req = new FakeReq();
  const p = readJsonBody(req as unknown as IncomingMessage);
  feed(req, ['this is not json']);
  await assert.rejects(p, /invalid json body/);
});

test('readJsonBody enforces the byte-limit guard rather than accumulating forever', async () => {
  const req = new FakeReq();
  // 32-byte limit, 64-byte payload split into 4x16 chunks. We expect destroy()
  // to be called on the second chunk (cumulative 32), which fires an error.
  const p = readJsonBody(req as unknown as IncomingMessage, 32);
  const sixteen = 'x'.repeat(16);
  feed(req, [sixteen, sixteen, sixteen, sixteen]);
  await assert.rejects(p, /body too large/);
});

test('readJsonBody propagates a stream error', async () => {
  const req = new FakeReq();
  const p = readJsonBody(req as unknown as IncomingMessage);
  process.nextTick(() => req.emit('error', new Error('socket closed')));
  await assert.rejects(p, /socket closed/);
});
