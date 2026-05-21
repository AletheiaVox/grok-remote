// Tiny shared helpers for the system routes.

import type { IncomingMessage, ServerResponse } from 'node:http';

export function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function readJsonBody(req: IncomingMessage, limitBytes: number = 1_048_576): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (b: Buffer) => {
      total += b.length;
      if (total > limitBytes) {
        req.destroy(new Error('body too large'));
        return;
      }
      chunks.push(b);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.length) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reject(new Error(`invalid json body: ${msg}`));
      }
    });
    req.on('error', reject);
  });
}
