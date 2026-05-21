// Run `grok trace <sessionId> --local` for an agent, unpack the resulting
// tar.gz, parse each of the 8 archive members, and return a single JSON
// payload the dashboard can render directly. Server-side extraction avoids
// pulling a tar/gzip library into the browser.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const GROK_BIN = process.env['GROK_BIN'] || 'grok';

interface CmdResult { stdout: string; stderr: string; }

function runCmd(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<CmdResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    child.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { err += b.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${cmd} exited ${code}: ${err || out}`));
    });
  });
}

function readJsonSafe(p: string): unknown {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function readJsonlSafe(p: string): unknown[] {
  try {
    const out: unknown[] = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return out;
  } catch { return []; }
}

function readTextSafe(p: string): string {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function fileSizeSafe(p: string): number | null {
  try { return fs.statSync(p).size; } catch { return null; }
}

export interface TraceAgentRecord {
  sessionId?: string | null;
  lastSessionId?: string | null;
  cwd?: string | null;
}

export interface TraceData {
  sessionId: string;
  generatedAt: string;
  archiveBytes: number | null;
  exportStatus: unknown;
  summary: unknown;
  chatHistory: unknown[];
  events: unknown[];
  updates: unknown[];
  systemPrompt: string;
  promptContext: unknown;
  traceConfig: unknown;
  exportMetadata: unknown;
  memberSizes: Record<string, number | null>;
}

// Build the trace for a single agent record (the public shape returned by
// AgentManager.get / list, which carries .sessionId and .lastSessionId).
export async function buildTrace(record: TraceAgentRecord): Promise<TraceData> {
  const sessionId = record.sessionId || record.lastSessionId;
  if (!sessionId) {
    throw new Error('no sessionId yet (agent has not completed a handshake)');
  }
  return buildTraceForSessionId(sessionId, record.cwd ?? undefined);
}

// Build a trace for any raw session id (not just an AgentManager-tracked
// agent).
export async function buildTraceForSessionId(sessionId: string, cwd?: string | null): Promise<TraceData> {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId required');
  }
  void cwd;
  const stamp = Date.now().toString(36) + '-' + randomUUID().slice(0, 8);
  const tmpRoot = path.join(os.tmpdir(), `grok-trace-${stamp}`);
  const archivePath = path.join(tmpRoot, 'trace.tar.gz');
  const extractDir  = path.join(tmpRoot, 'unpacked');
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    const exportOut = await runCmd(GROK_BIN, [
      'trace', sessionId, '--local', '--json', '-o', archivePath,
    ]);
    let exportStatus: unknown = null;
    try {
      const lastLine = exportOut.stdout.trim().split('\n').pop();
      if (lastLine) exportStatus = JSON.parse(lastLine);
    } catch { /* ignore */ }

    await runCmd('tar', ['-xzf', archivePath, '-C', extractDir]);

    const inner = fs.readdirSync(extractDir).map((n) => path.join(extractDir, n))
      .find((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    if (!inner) throw new Error('trace archive contained no session directory');

    const members = {
      summary:        path.join(inner, 'summary.json'),
      chatHistory:    path.join(inner, 'chat_history.jsonl'),
      events:         path.join(inner, 'events.jsonl'),
      updates:        path.join(inner, 'updates.jsonl'),
      systemPrompt:   path.join(inner, 'system_prompt.txt'),
      promptContext:  path.join(inner, 'prompt_context.json'),
      traceConfig:    path.join(inner, 'trace_config.json'),
      exportMetadata: path.join(inner, 'export_metadata.json'),
    } as const;

    const data: TraceData = {
      sessionId,
      generatedAt:    new Date().toISOString(),
      archiveBytes:   fileSizeSafe(archivePath),
      exportStatus,
      summary:        readJsonSafe(members.summary),
      chatHistory:    readJsonlSafe(members.chatHistory),
      events:         readJsonlSafe(members.events),
      updates:        readJsonlSafe(members.updates),
      systemPrompt:   readTextSafe(members.systemPrompt),
      promptContext:  readJsonSafe(members.promptContext),
      traceConfig:    readJsonSafe(members.traceConfig),
      exportMetadata: readJsonSafe(members.exportMetadata),
      memberSizes: Object.fromEntries(
        Object.entries(members).map(([k, p]) => [k, fileSizeSafe(p)]),
      ),
    };

    return data;
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
