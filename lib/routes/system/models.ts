// Models routes.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { send } from '../helpers.js';
import { runGrokText, errorToResponse } from '../../grok-cli.js';
import type { RouteRegistrar } from '../system.js';

interface ModelItem { id: string; name: string }

export function register(add: RouteRegistrar): void {
  add('GET', '/api/system/models', getHandler);
}

function parseModels(raw: unknown): ModelItem[] {
  const items: ModelItem[] = [];
  if (typeof raw !== 'string' || !raw.trim()) return items;

  const lines = raw.split('\n').map((l) => l.replace(/\s+$/, ''));

  for (const line of lines) {
    const m = line.match(/^\s*[*\-]\s+(\S+)(.*)$/);
    if (!m) continue;
    const id = m[1];
    let name = (m[2] || '').trim();
    name = name.replace(/^\(default\)\s*/i, '').trim();
    if (!id) continue;
    items.push({ id, name });
  }
  if (items.length) return items;

  let inTable = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (!inTable) {
      const upper = line.toUpperCase();
      if (upper.includes('ID') && (upper.includes('NAME') || upper.includes('MODEL'))) {
        inTable = true;
      }
      continue;
    }
    const m = line.match(/^\s*(\S+)\s*(.*)$/);
    if (!m) continue;
    const id = m[1];
    const name = (m[2] || '').trim();
    if (!id) continue;
    items.push({ id, name });
  }

  return items;
}

async function getHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const raw = await runGrokText(['models']);
    const items = parseModels(raw);
    send(res, 200, { ok: true, raw, items });
  } catch (err) {
    send(res, 500, errorToResponse(err));
  }
}
