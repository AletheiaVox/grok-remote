// Periodic cleanup of stale agent directories under ~/.grok-remote/agents/.
//
// Triggered by settings.retentionDays (0 disables). Honors starred + archived
// flags (never auto-prune a starred agent). Skips agents currently connected.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const AGENTS_ROOT = path.join(os.homedir(), '.grok-remote', 'agents');

export interface AgentMeta {
  starred?: boolean;
  lastSeen?: string;
  updatedAt?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface AgentLiveRecord {
  id: string;
  status?: string;
  [key: string]: unknown;
}

export interface AgentManagerLike {
  list(): AgentLiveRecord[];
  kill(id: string): Promise<unknown> | unknown;
}

export interface SweepInputs {
  days?: number;
  manager?: AgentManagerLike | null;
  now?: number;
}

export interface SweepResult {
  scanned: number;
  removed: number;
  skipped: number;
}

export interface RetentionTimerInputs {
  getSettings?: () => { retentionDays?: number } | null | undefined;
  manager?: AgentManagerLike | null;
  intervalMs?: number;
}

export interface RetentionTimer {
  stop(): void;
  tick(): void;
}

function readMeta(id: string): AgentMeta | null {
  try {
    const raw = fs.readFileSync(path.join(AGENTS_ROOT, id, 'meta.json'), 'utf8');
    return JSON.parse(raw) as AgentMeta;
  } catch { return null; }
}

function dirMtimeMs(id: string): number {
  try { return fs.statSync(path.join(AGENTS_ROOT, id)).mtimeMs; }
  catch { return 0; }
}

export function sweepOnce(
  { days, manager, now = Date.now() }: SweepInputs = {},
): SweepResult {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return { scanned: 0, removed: 0, skipped: 0 };
  const cutoffMs = now - n * 24 * 60 * 60 * 1000;

  let entries: string[];
  try { entries = fs.readdirSync(AGENTS_ROOT); }
  catch { return { scanned: 0, removed: 0, skipped: 0 }; }

  let scanned = 0, removed = 0, skipped = 0;
  const active = manager
    ? new Map<string, AgentLiveRecord>(manager.list().map((r) => [r.id, r]))
    : new Map<string, AgentLiveRecord>();

  for (const id of entries) {
    const metaPath = path.join(AGENTS_ROOT, id, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    scanned++;
    const meta = readMeta(id) || {};
    if (meta.starred) { skipped++; continue; }
    const live = active.get(id);
    if (live && live.status && live.status !== 'disconnected') { skipped++; continue; }
    const t = Date.parse(meta.lastSeen || meta.updatedAt || meta.createdAt || '');
    const lastMs = Number.isFinite(t) ? t : dirMtimeMs(id);
    if (lastMs >= cutoffMs) { skipped++; continue; }

    try {
      if (manager) {
        Promise.resolve(manager.kill(id)).catch(() => { /* ignore */ });
      } else {
        const dir = path.join(AGENTS_ROOT, id);
        if (dir.startsWith(AGENTS_ROOT + path.sep)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
      removed++;
    } catch {
      skipped++;
    }
  }
  return { scanned, removed, skipped };
}

// Start a daily sweep timer. Returns a stop() handle.
export function startRetentionTimer(
  { getSettings, manager, intervalMs = 24 * 60 * 60 * 1000 }: RetentionTimerInputs = {},
): RetentionTimer {
  const tick = (): void => {
    try {
      const s = typeof getSettings === 'function' ? getSettings() : null;
      const days = Number(s && s.retentionDays);
      if (Number.isFinite(days) && days > 0) {
        const r = sweepOnce({ days, manager });
        if (r.removed > 0) {
          process.stderr.write(`[retention] swept: removed=${r.removed} scanned=${r.scanned} skipped=${r.skipped}\n`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[retention] sweep failed: ${msg}\n`);
    }
  };
  const initial = setTimeout(tick, 30_000);
  const handle = setInterval(tick, intervalMs);
  return {
    stop(): void { clearTimeout(initial); clearInterval(handle); },
    tick,
  };
}
