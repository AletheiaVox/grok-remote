// sessions routes.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { send } from '../helpers.js';
import { runGrokText, errorToResponse } from '../../grok-cli.js';
import type { RouteRegistrar } from '../system.js';

interface SessionItem {
  sessionId: string;
  created: string;
  updated: string;
  status:  string;
  summary: string;
}

export function register(add: RouteRegistrar): void {
  add('GET', '/api/system/sessions', listHandler);
}

function clampLimit(raw: string | null): number {
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n) || n <= 0) return 20;
  if (n > 200) return 200;
  return n;
}

function parseSessions(raw: unknown): SessionItem[] {
  const items: SessionItem[] = [];
  if (!raw || typeof raw !== 'string') return items;
  const lines = raw.split('\n');
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^SESSION\s+ID/i.test(lines[i] || '')) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return items;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = line.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    if (!cols.length) continue;
    const sessionId = cols[0];
    if (!sessionId || !/^[0-9a-f-]{8,}$/i.test(sessionId)) continue;
    items.push({
      sessionId,
      created: cols[1] || '',
      updated: cols[2] || '',
      status:  cols[3] || '',
      summary: cols.slice(4).join(' ') || '',
    });
  }
  return items;
}

async function listHandler(_req: IncomingMessage, res: ServerResponse, urlObj: URL): Promise<void> {
  const q     = (urlObj.searchParams.get('q') || '').trim();
  const limit = clampLimit(urlObj.searchParams.get('limit'));

  const args = q
    ? ['sessions', 'search', '-n', String(limit), q]
    : ['sessions', 'list',   '-n', String(limit)];

  try {
    const raw = await runGrokText(args);
    const items = parseSessions(raw);
    send(res, 200, { ok: true, raw, items });
  } catch (err) {
    send(res, 500, errorToResponse(err));
  }
}
