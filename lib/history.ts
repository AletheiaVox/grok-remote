// Per-agent append-only JSONL history at ~/.grok-remote/agents/<id>/history.jsonl.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.homedir(), '.grok-remote', 'agents');

export function agentDir(agentId: string): string {
  return path.join(ROOT, agentId);
}

export function historyPath(agentId: string): string {
  return path.join(agentDir(agentId), 'history.jsonl');
}

export function ensureAgentDirs(agentId: string): string {
  const dir = agentDir(agentId);
  fs.mkdirSync(path.join(dir, 'cwd'), { recursive: true });
  return dir;
}

export function append(agentId: string, event: unknown): void {
  try {
    ensureAgentDirs(agentId);
    fs.appendFileSync(historyPath(agentId), JSON.stringify(event) + '\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[history] append failed for ${agentId}: ${msg}\n`);
  }
}

export function readAll(agentId: string): string {
  try {
    return fs.readFileSync(historyPath(agentId), 'utf8');
  } catch {
    return '';
  }
}
