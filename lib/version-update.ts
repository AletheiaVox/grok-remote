// Self-update orchestration for grok-remote.
//
// Backs the /api/version/* endpoints in server.js:
//   - readCurrentVersion(): snapshot of the running build.
//   - readLatestVersion(): fetches origin/main and reports ahead/behind.
//   - runUpdate(): SSE-friendly state machine that pulls, optionally
//     installs deps, builds, then asks pm2 to restart this very process.

import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let updateInProgress = false;

export function isUpdateInProgress(): boolean {
  return updateInProgress;
}

interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface CaptureOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

function runCapture(cmd: string, args: string[], opts: CaptureOptions = {}): Promise<CaptureResult> {
  const { cwd = ROOT, timeoutMs = 30_000, env } = opts;
  return new Promise<CaptureResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => outChunks.push(b));
    child.stderr?.on('data', (b: Buffer) => errChunks.push(b));
    child.on('error', (err: Error) => {
      clearTimeout(t);
      resolve({ code: -1, stdout: '', stderr: String(err && err.message || err) });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8') + (timedOut ? '\n[timeout]\n' : ''),
      });
    });
  });
}

function readPkgVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch { return '0.0.0'; }
}

function readDistBuiltAt(): string | null {
  try {
    const st = fs.statSync(path.join(ROOT, 'dist'));
    return st.mtime.toISOString();
  } catch { return null; }
}

export interface CurrentVersion {
  ok: true;
  version: string;
  pkgVersion: string;
  gitTag: string | null;
  gitSha: string | null;
  gitShaShort: string | null;
  gitBranch: string | null;
  gitDirty: boolean | null;
  builtAt: string | null;
}

export async function readCurrentVersion(): Promise<CurrentVersion> {
  const pkgVersion = readPkgVersion();
  const builtAt = readDistBuiltAt();

  const sha    = await runCapture('git', ['rev-parse', 'HEAD'], { timeoutMs: 5000 });
  const branch = await runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 });
  const dirty  = await runCapture('git', ['status', '--porcelain'], { timeoutMs: 5000 });
  const tag = await runCapture('git', ['describe', '--tags', '--abbrev=0'], { timeoutMs: 5000 });
  const tagStr = tag.code === 0 ? tag.stdout.trim() : '';
  const version = tagStr ? tagStr.replace(/^v/, '') : pkgVersion;

  return {
    ok: true,
    version,
    pkgVersion,
    gitTag: tagStr || null,
    gitSha: sha.code === 0 ? sha.stdout.trim() : null,
    gitShaShort: sha.code === 0 ? sha.stdout.trim().slice(0, 7) : null,
    gitBranch: branch.code === 0 ? branch.stdout.trim() : null,
    gitDirty: dirty.code === 0 ? dirty.stdout.trim().length > 0 : null,
    builtAt,
  };
}

export type LatestVersion =
  | { ok: false; error: string; detail?: string }
  | {
      ok: true;
      ahead: number;
      behind: number;
      latestSha: string | null;
      latestShaShort: string | null;
      latestVersion: string | null;
      fetchedAt: string;
    };

export async function readLatestVersion(): Promise<LatestVersion> {
  const fetched = await runCapture('git', ['fetch', 'origin', 'main', '--quiet'], { timeoutMs: 20_000 });
  if (fetched.code !== 0) {
    return {
      ok: false,
      error: 'git fetch failed',
      detail: (fetched.stderr || fetched.stdout || '').trim().slice(0, 1000),
    };
  }

  const counts = await runCapture(
    'git', ['rev-list', '--left-right', '--count', 'HEAD...origin/main'],
    { timeoutMs: 5000 },
  );
  let ahead = 0, behind = 0;
  if (counts.code === 0) {
    const m = counts.stdout.trim().split(/\s+/);
    ahead  = parseInt(m[0] || '0', 10) || 0;
    behind = parseInt(m[1] || '0', 10) || 0;
  }

  const remoteSha = await runCapture('git', ['rev-parse', 'origin/main'], { timeoutMs: 5000 });
  const remotePkg = await runCapture('git', ['show', 'origin/main:package.json'], { timeoutMs: 5000 });
  let latestVersion: string | null = null;
  if (remotePkg.code === 0) {
    try {
      const parsed = JSON.parse(remotePkg.stdout) as { version?: string };
      if (parsed && typeof parsed.version === 'string') latestVersion = parsed.version;
    } catch { /* ignore */ }
  }

  return {
    ok: true,
    ahead,
    behind,
    latestSha: remoteSha.code === 0 ? remoteSha.stdout.trim() : null,
    latestShaShort: remoteSha.code === 0 ? remoteSha.stdout.trim().slice(0, 7) : null,
    latestVersion,
    fetchedAt: new Date().toISOString(),
  };
}

const RELEASES_TTL_MS = 5 * 60 * 1000;

export interface ReleaseSummary {
  tag: string;
  name: string;
  url: string;
  body: string;
  publishedAt: string;
  draft: boolean;
  prerelease: boolean;
}

export type ReleasesResult =
  | { ok: false; error: string; detail?: string; repo?: string }
  | { ok: true; repo: string; releases: ReleaseSummary[]; fetchedAt: string };

interface ReleasesCache {
  at: number;
  data: ReleasesResult | null;
  error: string | null;
}

let releasesCache: ReleasesCache = { at: 0, data: null, error: null };

function repoSlugFromOriginUrl(originUrl: string | null | undefined): string {
  if (!originUrl) return '';
  const m = originUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/i);
  return m ? `${m[1]}/${m[2]}` : '';
}

async function detectRepoSlug(): Promise<string> {
  const env = process.env['GROK_REMOTE_REPO'];
  if (env && env.includes('/')) return env;
  const r = await runCapture('git', ['remote', 'get-url', 'origin'], { timeoutMs: 5000 });
  if (r.code !== 0) return '';
  return repoSlugFromOriginUrl(r.stdout.trim());
}

export async function readReleases({ force = false }: { force?: boolean } = {}): Promise<ReleasesResult> {
  const now = Date.now();
  if (!force && releasesCache.data && (now - releasesCache.at) < RELEASES_TTL_MS) {
    return releasesCache.data;
  }
  const repo = await detectRepoSlug();
  if (!repo) {
    const out: ReleasesResult = { ok: false, error: 'no_repo', detail: 'could not detect GitHub repo from origin url' };
    releasesCache = { at: now, data: out, error: out.error };
    return out;
  }
  try {
    const url = `https://api.github.com/repos/${repo}/releases?per_page=20`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'grok-remote',
        'Accept': 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const out: ReleasesResult = {
        ok: false,
        error: `github_${res.status}`,
        detail: text.slice(0, 500),
        repo,
      };
      releasesCache = { at: now, data: out, error: out.error };
      return out;
    }
    const raw = await res.json() as Array<Record<string, unknown>>;
    const releases: ReleaseSummary[] = (Array.isArray(raw) ? raw : []).map((r) => ({
      tag: String(r['tag_name'] || ''),
      name: String(r['name'] || r['tag_name'] || ''),
      url: String(r['html_url'] || ''),
      body: String(r['body'] || ''),
      publishedAt: String(r['published_at'] || ''),
      draft: !!r['draft'],
      prerelease: !!r['prerelease'],
    }));
    const out: ReleasesResult = {
      ok: true,
      repo,
      releases,
      fetchedAt: new Date().toISOString(),
    };
    releasesCache = { at: now, data: out, error: null };
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const out: ReleasesResult = { ok: false, error: 'fetch_failed', detail: msg };
    releasesCache = { at: now, data: out, error: out.error };
    return out;
  }
}

export interface DiffResult {
  ok: boolean;
  stat: string;
  diff: string;
  truncated: boolean;
}

export async function readDiff(): Promise<DiffResult> {
  const r = await runCapture('git', ['diff', '--stat', 'HEAD'], { timeoutMs: 10_000 });
  const full = await runCapture('git', ['diff', 'HEAD'], { timeoutMs: 10_000, env: { ...process.env, GIT_PAGER: 'cat' } });
  return {
    ok: r.code === 0,
    stat: r.stdout || '',
    diff: (full.stdout || '').slice(0, 200_000),
    truncated: (full.stdout || '').length > 200_000,
  };
}

export interface UpdateStepEvent {
  step: string;
  status: 'start' | 'log' | 'ok' | 'fail' | 'skip';
  detail: string;
}

export interface RunUpdateOptions {
  emit?: (event: UpdateStepEvent) => void;
  restart?: boolean;
}

export async function runUpdate({ emit, restart = true }: RunUpdateOptions = {}): Promise<void> {
  if (updateInProgress) {
    const err = new Error('update already in progress') as Error & { code?: string };
    err.code = 'IN_PROGRESS';
    throw err;
  }
  updateInProgress = true;

  function step(name: string, status: UpdateStepEvent['status'], detail: string): void {
    try { emit?.({ step: name, status, detail }); } catch { /* socket may be gone */ }
  }

  function streamStep(name: string, cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<number> {
    return new Promise<number>((resolve) => {
      step(name, 'start', `$ ${cmd} ${args.join(' ')}`);
      const spawnOpts: SpawnOptions = {
        cwd: opts.cwd || ROOT,
        env: opts.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      };
      const child = spawn(cmd, args, spawnOpts);
      let timer: NodeJS.Timeout | null = null;
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          step(name, 'log', '[grok-remote] step timeout; killing.');
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
        }, opts.timeoutMs);
      }
      child.stdout?.on('data', (b: Buffer) => step(name, 'log', b.toString('utf8')));
      child.stderr?.on('data', (b: Buffer) => step(name, 'log', b.toString('utf8')));
      child.on('error', (err: Error) => {
        if (timer) clearTimeout(timer);
        step(name, 'fail', String(err && err.message || err));
        resolve(-1);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if ((code ?? -1) === 0) step(name, 'ok', `exit 0`);
        else step(name, 'fail', `exit ${code}`);
        resolve(code ?? -1);
      });
    });
  }

  try {
    step('preflight', 'start', 'checking repo state');

    const branch = await runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 });
    if (branch.code !== 0) {
      step('preflight', 'fail', `git branch lookup failed: ${branch.stderr.trim()}`);
      return;
    }
    if (branch.stdout.trim() !== 'main') {
      step('preflight', 'fail', `refusing to self-update from branch "${branch.stdout.trim()}". switch to main first.`);
      return;
    }

    const dirty = await runCapture('git', ['status', '--porcelain'], { timeoutMs: 5000 });
    if (dirty.code !== 0) {
      step('preflight', 'fail', `git status failed: ${dirty.stderr.trim()}`);
      return;
    }
    if (dirty.stdout.trim().length > 0) {
      step('preflight', 'fail', 'working tree is dirty. commit or stash your changes, then retry.');
      step('preflight', 'log', dirty.stdout);
      return;
    }
    step('preflight', 'ok', 'clean working tree on main');

    const fetchCode = await streamStep('fetch', 'git', ['fetch', 'origin', 'main', '--quiet'], { timeoutMs: 60_000 });
    if (fetchCode !== 0) return;

    const counts = await runCapture('git', ['rev-list', '--left-right', '--count', 'HEAD...origin/main'], { timeoutMs: 5000 });
    const behind = counts.code === 0 ? (parseInt(counts.stdout.trim().split(/\s+/)[1] || '0', 10) || 0) : 0;
    if (behind === 0) {
      step('fetch', 'log', 'already up to date.');
      step('preflight', 'log', 'no commits to pull. exiting without restart.');
      step('done', 'ok', 'no update needed');
      return;
    }

    const preSha = await runCapture('git', ['rev-parse', 'HEAD'], { timeoutMs: 5000 });
    const preHead = preSha.code === 0 ? preSha.stdout.trim() : null;

    const pullCode = await streamStep('pull', 'git', ['pull', '--ff-only', 'origin', 'main'], { timeoutMs: 60_000 });
    if (pullCode !== 0) {
      step('pull', 'log', 'fast-forward refused. the local branch likely diverged. resolve manually then retry.');
      return;
    }

    let depsChanged = false;
    if (preHead) {
      const diff = await runCapture('git', ['diff', '--name-only', `${preHead}..HEAD`], { timeoutMs: 5000 });
      if (diff.code === 0) {
        depsChanged = /(^|\n)(package\.json|package-lock\.json)\b/.test(diff.stdout);
      }
    }
    if (depsChanged) {
      const installCode = await streamStep('install', 'npm', ['install', '--no-audit', '--no-fund'], { timeoutMs: 5 * 60_000 });
      if (installCode !== 0) return;
    } else {
      step('install', 'skip', 'package.json and package-lock.json unchanged; skipping npm install.');
    }

    const buildCode = await streamStep('build', 'npm', ['run', 'build'], { timeoutMs: 5 * 60_000 });
    if (buildCode !== 0) return;

    step('restart', 'start', 'asking pm2 to restart grok-remote');
    if (!restart) {
      step('restart', 'skip', 'restart=false; not restarting.');
      step('done', 'ok', 'update applied; restart was skipped.');
      return;
    }

    const restartChild = spawn('pm2', ['restart', 'grok-remote', '--update-env'], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    restartChild.stdout?.on('data', (b: Buffer) => step('restart', 'log', b.toString('utf8')));
    restartChild.stderr?.on('data', (b: Buffer) => step('restart', 'log', b.toString('utf8')));
    restartChild.on('error', (err: Error) => {
      step('restart', 'fail', `pm2 spawn failed: ${err.message}`);
    });
    restartChild.unref();
  } finally {
    updateInProgress = false;
  }
}
