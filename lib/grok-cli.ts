// Thin wrapper around the `grok` CLI for the system-pages routes.

import { spawn } from 'node:child_process';

const GROK_BIN = process.env['GROK_BIN'] || 'grok';

export interface GrokCliErrorInit {
  code?: number | null;
  stdout?: string;
  stderr?: string;
  args?: readonly string[] | null;
}

export class GrokCliError extends Error {
  code: number | null;
  stdout: string;
  stderr: string;
  args: readonly string[] | null;

  constructor(message: string, init: GrokCliErrorInit = {}) {
    super(message);
    this.name = 'GrokCliError';
    this.code = init.code ?? null;
    this.stdout = init.stdout || '';
    this.stderr = init.stderr || '';
    this.args = init.args || null;
  }
}

export interface RunGrokOptions {
  timeoutMs?: number;
  maxBytes?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  json?: boolean;
  stdin?: string | null;
}

export interface RunGrokResult {
  stdout: string;
  stderr: string;
  code: number | null;
  json?: unknown;
}

export function runGrok(args: string[], opts: RunGrokOptions = {}): Promise<RunGrokResult> {
  const {
    timeoutMs = 20_000,
    maxBytes  = 1_048_576,
    cwd       = undefined,
    env       = process.env,
    json      = false,
    stdin     = null,
  } = opts;

  return new Promise<RunGrokResult>((resolve, reject) => {
    const child = spawn(GROK_BIN, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let outBytes = 0;
    let errBytes = 0;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 1500);
    }, timeoutMs);

    child.stdout?.on('data', (buf: Buffer) => {
      outBytes += buf.length;
      if (outBytes > maxBytes) {
        killed = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        return;
      }
      stdout += buf.toString('utf8');
    });
    child.stderr?.on('data', (buf: Buffer) => {
      errBytes += buf.length;
      if (errBytes > maxBytes) return;
      stderr += buf.toString('utf8');
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(new GrokCliError(err.message, { args, stdout, stderr }));
    });

    child.on('exit', (code: number | null) => {
      clearTimeout(timer);
      if (killed) {
        return reject(new GrokCliError('grok call timed out or exceeded output limit', {
          code, stdout, stderr, args,
        }));
      }
      if (code !== 0) {
        return reject(new GrokCliError(`grok exited with code ${code}`, {
          code, stdout, stderr, args,
        }));
      }
      if (!json) return resolve({ stdout, stderr, code });
      const trimmed = stdout.trim();
      if (!trimmed) return resolve({ json: null, stdout, stderr, code });
      try {
        return resolve({ json: JSON.parse(trimmed), stdout, stderr, code });
      } catch { /* fall through to NDJSON */ }
      const rows: unknown[] = [];
      for (const line of trimmed.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { rows.push(JSON.parse(t)); } catch { /* skip malformed */ }
      }
      if (rows.length) return resolve({ json: rows, stdout, stderr, code });
      return reject(new GrokCliError('failed to parse grok output as JSON', { code, stdout, stderr, args }));
    });

    if (stdin && child.stdin) {
      try { child.stdin.write(stdin); } catch { /* ignore */ }
    }
    try { child.stdin?.end(); } catch { /* ignore */ }
  });
}

export async function runGrokText(args: string[], opts: RunGrokOptions = {}): Promise<string> {
  const r = await runGrok(args, { ...opts, json: false });
  return r.stdout;
}

export async function runGrokJson(args: string[], opts: RunGrokOptions = {}): Promise<unknown> {
  const r = await runGrok(args, { ...opts, json: true });
  return r.json;
}

export interface ErrorResponse {
  ok: false;
  error: string;
  code?: number | null;
  stderr?: string;
  stdout?: string;
  args?: readonly string[] | null;
}

export function errorToResponse(err: unknown): ErrorResponse {
  if (err instanceof GrokCliError) {
    return {
      ok: false,
      error: err.message,
      code: err.code,
      stderr: (err.stderr || '').slice(-2000),
      stdout: (err.stdout || '').slice(-2000),
      args: err.args,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { ok: false, error: msg };
}
