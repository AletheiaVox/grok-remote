#!/usr/bin/env node
// grok-remote server
//
// Serves the built Vite dashboard plus the /api surface. Designed to sit on
// your tailnet so you can reach it from any device you own. The
// remote-agent endpoints live below.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

import { AgentManager } from './lib/agent-manager.js';
import { load as loadSettings, save as saveSettings } from './lib/settings.js';
import * as folders from './lib/folders.js';
import { startRetentionTimer } from './lib/retention.js';
import { inferDevServerUrl } from './lib/dev-url.js';
import { readAll as readHistory } from './lib/history.js';
import { writeHeaders as sseHeaders, writeEvent as sseWrite, writePing as ssePing } from './lib/sse.js';
import { buildTrace, buildTraceForSessionId } from './lib/trace-host.js';
import { handleSystem } from './lib/routes/system.js';
import { runGrokText, errorToResponse } from './lib/grok-cli.js';
import {
  readCurrentVersion,
  readLatestVersion,
  readDiff as readVersionDiff,
  runUpdate as runVersionUpdate,
  isUpdateInProgress,
  readReleases,
} from './lib/version-update.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const PORT = parseInt(process.env.PORT || '7910', 10);
const HOST = process.env.HOST || '0.0.0.0';

const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch { return '0.0.0'; }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

const manager = new AgentManager();

function safeJoin(base, rel) {
  const target = path.resolve(base, '.' + rel);
  if (!target.startsWith(base)) return null;
  return target;
}

function tailscaleIdentity() {
  const r = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const self = j.Self || {};
    return {
      backend: j.BackendState,
      dns: (self.DNSName || '').replace(/\.$/, ''),
      ip:  (self.TailscaleIPs && self.TailscaleIPs[0]) || '',
      hostname: self.HostName || os.hostname(),
    };
  } catch { return null; }
}

function serveStatic(req, res) {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let rel = url === '/' ? '/index.html' : url;
  let target = safeJoin(DIST, rel);
  if (!target || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = path.join(DIST, 'index.html');
  }
  if (!fs.existsSync(target)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('grok-remote: dist/ not built yet. Run `npm run build` (or `npm run install:setup`).\n');
    return;
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > limitBytes) {
        req.destroy();
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.length) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(new Error(`invalid json: ${err.message}`)); }
    });
    req.on('error', reject);
  });
}

function matchAgentRoute(url) {
  // Returns { id, suffix } or null
  const m = url.match(/^\/api\/agents\/([^\/]+)(\/[^?]*)?$/);
  if (!m) return null;
  return { id: m[1], suffix: m[2] || '' };
}

async function handleApi(req, res, url, method) {
  if (url === '/api/hello' && method === 'GET') {
    const ts = tailscaleIdentity();
    return sendJson(res, 200, {
      ok: true,
      app: 'grok-remote',
      version: APP_VERSION,
      message: 'remote up. agent endpoints land here soon.',
      now: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      node: process.version,
      platform: process.platform,
      hostname: os.hostname(),
      tailscale: ts,
    });
  }

  if (url === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, version: APP_VERSION, uptime_seconds: Math.floor(process.uptime()) });
  }

  // ── self-update endpoints ────────────────────────────────────────────
  if (url === '/api/version/current' && method === 'GET') {
    try {
      const data = await readCurrentVersion();
      return sendJson(res, 200, data);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }
  if (url === '/api/version/latest' && method === 'GET') {
    try {
      const data = await readLatestVersion();
      return sendJson(res, 200, data);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }
  if (url === '/api/version/diff' && method === 'GET') {
    try {
      const data = await readVersionDiff();
      return sendJson(res, 200, data);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }
  if ((url === '/api/version/releases' || url.startsWith('/api/version/releases?'))
      && method === 'GET') {
    try {
      const force = /\bforce=1\b/.test(url);
      const data = await readReleases({ force });
      return sendJson(res, 200, data);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }
  if (url === '/api/version/update' && method === 'POST') {
    if (isUpdateInProgress()) {
      return sendJson(res, 409, { ok: false, error: 'update already in progress' });
    }
    return handleVersionUpdateStream(req, res);
  }

  if (url === '/api/settings' && method === 'GET') {
    return sendJson(res, 200, loadSettings());
  }

  if (url === '/api/settings' && method === 'PATCH') {
    try {
      const body = await readJsonBody(req);
      const merged = saveSettings(body || {});
      return sendJson(res, 200, merged);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (url === '/api/agents' && method === 'GET') {
    return sendJson(res, 200, manager.list());
  }

  if (url === '/api/agents/stream' && method === 'GET') {
    return handleAgentsStream(req, res);
  }

  if (url === '/api/bg-terminals' && method === 'GET') {
    return handleGlobalBgTerminals(req, res);
  }

  // ── folders ───────────────────────────────────────────────────────────
  if (url === '/api/folders' && method === 'GET') {
    return sendJson(res, 200, { folders: folders.list() });
  }
  if (url === '/api/folders' && method === 'POST') {
    try {
      const body = await readJsonBody(req) || {};
      const folder = folders.create({ name: body.name });
      return sendJson(res, 201, folder);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }
  {
    const fm = url.match(/^\/api\/folders\/([^\/?]+)$/);
    if (fm && method === 'PATCH') {
      try {
        const body = await readJsonBody(req) || {};
        const folder = folders.update(fm[1], body);
        return sendJson(res, 200, folder);
      } catch (err) {
        const status = err.message === 'folder not found' ? 404 : 400;
        return sendJson(res, status, { ok: false, error: err.message });
      }
    }
    if (fm && method === 'DELETE') {
      const ok = folders.remove(fm[1]);
      return sendJson(res, ok ? 200 : 404, { ok });
    }
  }
  // Convenience endpoint for drag-and-drop. Body: { folderId: string|null }.
  // null/missing folderId removes the agent from all folders.
  {
    const fm = url.match(/^\/api\/agents\/([^\/?]+)\/folder$/);
    if (fm && method === 'PUT') {
      try {
        const body = await readJsonBody(req) || {};
        const folderId = typeof body.folderId === 'string' && body.folderId ? body.folderId : null;
        const next = folders.assignAgent(fm[1], folderId);
        return sendJson(res, 200, { folders: next });
      } catch (err) {
        const status = err.message === 'folder not found' ? 404 : 400;
        return sendJson(res, status, { ok: false, error: err.message });
      }
    }
  }

  // GET /api/subagents/:sessionId/trace
  //
  // The Flow view needs to fetch a sub-agent's own trace (its updates.jsonl
  // is where the child tool_call rows live). Sub-agents run in their own
  // grok sessions; we know the sessionId from the parent's tool_call output
  // but there's no AgentManager record for them. This endpoint accepts a
  // raw sessionId and reuses the same buildTrace machinery as the agent
  // endpoint, gated by a UUID-shape check so we never shell out with
  // arbitrary input.
  {
    const sm = url.match(/^\/api\/subagents\/([^\/]+)\/trace$/);
    if (sm && method === 'GET') {
      const sid = sm[1];
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(sid)) {
        return sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
      }
      try {
        const data = await buildTraceForSessionId(sid);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(data));
        return;
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }
  }

  // GET /api/subagents/:sessionId/updates?cwd=<absolute-cwd>
  //
  // Fast path for sub-agent child events. Skips `grok trace` (which builds a
  // tar.gz, extracts it, and is rate-limited by the CLI startup) and reads
  // ~/.grok/sessions/<url-encoded cwd>/<sessionId>/updates.jsonl directly.
  // Works while the session is still being written, which the trace
  // endpoint does not. Returns the same shape extractChildCallsFromTrace
  // consumes: { sessionId, updates: [...] }.
  //
  // When cwd is omitted we fall back to a one-level scan of every
  // ~/.grok/sessions/<cwd>/ subdir for one named <sessionId>. The frontend
  // always passes cwd so the scan is only a safety net.
  {
    const sm = url.match(/^\/api\/subagents\/([^\/]+)\/updates(?:\?.*)?$/);
    if (sm && method === 'GET') {
      const sid = sm[1];
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(sid)) {
        return sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
      }
      const qs   = new URL(req.url, 'http://x').searchParams;
      const cwd  = qs.get('cwd') || '';
      const root = path.join(os.homedir(), '.grok', 'sessions');

      function tryReadUpdates(sessionDir) {
        const p = path.join(sessionDir, 'updates.jsonl');
        if (!fs.existsSync(p)) return null;
        let raw;
        try { raw = fs.readFileSync(p, 'utf8'); }
        catch { return null; }
        const out = [];
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          try { out.push(JSON.parse(t)); } catch { /* skip malformed */ }
        }
        return out;
      }

      let updates = null;
      let sourceDir = null;

      if (cwd) {
        // Direct lookup using the encoded cwd path grok itself uses.
        const dir = path.join(root, encodeURIComponent(cwd), sid);
        updates = tryReadUpdates(dir);
        if (updates) sourceDir = dir;
      }
      if (!updates) {
        // Fallback scan. Only one level deep so this stays cheap.
        try {
          const cwds = fs.readdirSync(root);
          for (const enc of cwds) {
            const dir = path.join(root, enc, sid);
            const got = tryReadUpdates(dir);
            if (got) { updates = got; sourceDir = dir; break; }
          }
        } catch { /* root may not exist yet */ }
      }

      if (!updates) {
        return sendJson(res, 404, {
          ok: false, error: 'session dir not flushed yet', sessionId: sid,
        });
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({
        ok: true,
        sessionId: sid,
        source: 'direct',
        sourceDir,
        updates,
      }));
      return;
    }
  }

  if (url === '/api/agents' && method === 'POST') {
    try {
      const body = await readJsonBody(req) || {};
      const defaults = loadSettings();
      // Apply global defaults only when the caller didn't specify them.
      const settings = { ...(body.settings || {}) };
      if (!body.model && !settings.model && defaults.defaultModel) {
        settings.model = defaults.defaultModel;
      }
      if (typeof settings.alwaysApprove !== 'boolean' && typeof defaults.autoApprove === 'boolean') {
        settings.alwaysApprove = defaults.autoApprove;
      }
      const merged = {
        ...body,
        settings,
        ...(!body.cwd && defaults.defaultCwd ? { cwd: defaults.defaultCwd } : {}),
      };
      const rec = await manager.spawn(merged);
      return sendJson(res, 201, rec);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  const route = matchAgentRoute(url);
  if (route) {
    const { id, suffix } = route;
    const rec = manager.get(id);
    if (!rec) return sendJson(res, 404, { ok: false, error: 'agent not found' });

    if (suffix === '' && method === 'GET') {
      return sendJson(res, 200, rec);
    }
    if (suffix === '' && method === 'PATCH') {
      try {
        const body = await readJsonBody(req);
        const out = await manager.update(id, body || {});
        return sendJson(res, 200, out);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }
    if (suffix === '' && method === 'DELETE') {
      const ok = await manager.kill(id);
      return sendJson(res, ok ? 200 : 404, { ok });
    }
    if (suffix === '/prompt' && method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const text = body?.text;
        const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
        const hasText = typeof text === 'string' && text.length > 0;
        if (!hasText && !attachments.length) {
          return sendJson(res, 400, { ok: false, error: 'text or attachments required' });
        }
        // Validate attachment shape up front.
        for (const att of attachments) {
          if (!att || typeof att !== 'object') {
            return sendJson(res, 400, { ok: false, error: 'invalid attachment' });
          }
          if (att.kind !== 'image') {
            return sendJson(res, 400, { ok: false, error: `unsupported attachment kind: ${att.kind}` });
          }
          if (typeof att.mimeType !== 'string' || !att.mimeType.startsWith('image/')) {
            return sendJson(res, 400, { ok: false, error: 'attachment.mimeType must be image/*' });
          }
          if (typeof att.dataBase64 !== 'string' || !att.dataBase64.length) {
            return sendJson(res, 400, { ok: false, error: 'attachment.dataBase64 required' });
          }
        }
        const result = await manager.prompt(id, { text: hasText ? text : '', attachments });
        // Echo back what the server actually composed (final text after the
        // attachment block was appended, list of saved files, sessionId, etc.)
        // so the UI inspector can show the full server-side view.
        return sendJson(res, 202, { ok: true, accepted: true, debug: result?.debug || null });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }
    if (suffix === '/cancel' && method === 'POST') {
      await manager.cancel(id);
      return sendJson(res, 202, { ok: true, accepted: true });
    }
    if (suffix === '/disconnect' && method === 'POST') {
      try {
        const out = await manager.disconnect(id);
        return sendJson(res, 200, out);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }
    if (suffix === '/connect' && method === 'POST') {
      try {
        const out = await manager.connect(id);
        return sendJson(res, 202, out);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }
    if (suffix === '/history' && method === 'GET') {
      const urlObj = new URL(req.url, 'http://x');
      const all = urlObj.searchParams.get('all') === '1';
      const turnsParam = parseInt(urlObj.searchParams.get('turns') || '50', 10);
      const turns = Number.isFinite(turnsParam) && turnsParam > 0 ? turnsParam : 50;
      const sliced = sliceHistoryByTurns(readHistory(id) || '', { all, turns });
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'X-Total-Turns': String(sliced.totalTurns),
        'X-Returned-Turns': String(sliced.returnedTurns),
      });
      res.end(sliced.text);
      return;
    }
    if (suffix === '/files' && method === 'GET') {
      return handleFilesList(req, res, rec);
    }
    if (suffix === '/trace' && method === 'GET') {
      try {
        const data = await buildTrace(rec);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(data));
        return;
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }
    if (suffix === '/files/raw' && (method === 'GET' || method === 'HEAD')) {
      return handleFilesRaw(req, res, rec, method);
    }
    if (suffix === '/stream' && method === 'GET') {
      return handleStream(req, res, id);
    }
    if (suffix === '/terminals' && method === 'GET') {
      return handleTerminalList(req, res, rec);
    }
    {
      const tmatch = suffix.match(/^\/terminals\/([^/]+)(\/kill)?$/);
      if (tmatch) {
        const tid = tmatch[1];
        const kill = !!tmatch[2];
        if (kill && method === 'POST')  return handleTerminalKill(req, res, rec, tid);
        if (!kill && method === 'GET')  return handleTerminalRead(req, res, rec, tid);
      }
    }
    {
      const bgmatch = suffix.match(/^\/bg-tasks\/([^/]+)$/);
      if (bgmatch && method === 'GET') {
        return handleBgTaskRead(req, res, rec, bgmatch[1]);
      }
    }
    if (suffix === '/publish' && method === 'POST') {
      // Wraps `grok share <sessionId>`. The agent must have a sessionId,
      // either live (currently connected) or persisted from a prior run.
      const sessionId = rec.sessionId || rec.lastSessionId;
      if (!sessionId) {
        return sendJson(res, 400, {
          ok: false,
          error: 'agent has no sessionId yet; complete at least one turn before publishing',
        });
      }
      try {
        // `grok share` uploads the session to xAI and prints the share URL on
        // stdout. We give it a generous timeout because the upload size scales
        // with conversation length.
        const stdout = await runGrokText(['share', sessionId], {
          timeoutMs: 60_000,
          maxBytes: 256 * 1024,
        });
        // Pluck the first https:// URL out of stdout. We accept any host so
        // future CLI versions that move to a different domain still work.
        const m = stdout.match(/https?:\/\/\S+/);
        const url = m ? m[0].replace(/[)\].,;]+$/, '') : null;
        if (!url) {
          return sendJson(res, 500, {
            ok: false,
            error: 'grok share did not print a URL',
            stdout: stdout.slice(-2000),
          });
        }
        return sendJson(res, 200, { ok: true, url, sessionId, stdout });
      } catch (err) {
        return sendJson(res, 500, errorToResponse(err));
      }
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
}

// Return the last `turns` turns from a JSONL history string. A "turn" starts
// at each user_message event. If `all` is true the full history is returned.
function sliceHistoryByTurns(raw, { all, turns }) {
  if (!raw) return { text: '', totalTurns: 0, returnedTurns: 0 };
  const lines = raw.split('\n').filter(Boolean);
  const userMessageIndices = [];
  for (let i = 0; i < lines.length; i++) {
    // Cheap pre-check before JSON.parse on long lines.
    if (lines[i].indexOf('"user_message"') === -1) continue;
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && obj.event === 'user_message') userMessageIndices.push(i);
    } catch { /* skip malformed */ }
  }
  const totalTurns = userMessageIndices.length;
  if (all || totalTurns <= turns) {
    return { text: lines.join('\n') + (lines.length ? '\n' : ''), totalTurns, returnedTurns: totalTurns };
  }
  const cutoffLineIdx = userMessageIndices[totalTurns - turns];
  const sliced = lines.slice(cutoffLineIdx);
  return { text: sliced.join('\n') + '\n', totalTurns, returnedTurns: turns };
}

const FILE_MAX_BYTES = 256_000;

function withinAgentScope(scopeDir, target) {
  // Mirrors lib/fs-host.js: allow exact scope match or descendant.
  const scope = path.resolve(scopeDir);
  const resolved = path.resolve(target);
  return resolved === scope || resolved.startsWith(scope + path.sep);
}

async function handleFilesList(req, res, rec) {
  const cwd = rec && rec.cwd;
  if (!cwd) return sendJson(res, 404, { ok: false, error: 'agent cwd missing' });

  const urlObj = new URL(req.url, 'http://x');
  const rel = urlObj.searchParams.get('path') || '';
  const cleanRel = String(rel).replace(/^\/+/, '');

  let target;
  try {
    target = path.resolve(cwd, cleanRel);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid path' });
  }
  if (!withinAgentScope(cwd, target)) {
    return sendJson(res, 400, { ok: false, error: 'path escapes agent scope' });
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return sendJson(res, 404, { ok: false, error: 'path not found' });
    }
    return sendJson(res, 500, { ok: false, error: err.message });
  }

  if (stat.isDirectory()) {
    let names;
    try {
      names = fs.readdirSync(target);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
    const dirs = [];
    const files = [];
    for (const name of names) {
      const full = path.join(target, name);
      let s;
      try { s = fs.lstatSync(full); }
      catch { continue; }
      const isHidden = name.startsWith('.');
      if (s.isDirectory()) {
        dirs.push({ name, type: 'directory', entries: null, isHidden });
      } else if (s.isFile()) {
        files.push({
          name,
          type: 'file',
          size: s.size,
          mtime: s.mtime.toISOString(),
          isHidden,
        });
      } else {
        // symlinks/other: report as file-ish
        files.push({
          name,
          type: 'file',
          size: s.size,
          mtime: s.mtime.toISOString(),
          isHidden,
        });
      }
    }
    const cmp = (a, b) => {
      if (a.isHidden !== b.isHidden) return a.isHidden ? 1 : -1;
      return a.name.localeCompare(b.name);
    };
    dirs.sort(cmp);
    files.sort(cmp);
    return sendJson(res, 200, {
      type: 'directory',
      path: cleanRel,
      entries: [...dirs, ...files],
    });
  }

  if (stat.isFile()) {
    if (stat.size > FILE_MAX_BYTES) {
      return sendJson(res, 200, {
        type: 'file',
        path: cleanRel,
        size: stat.size,
        truncated: true,
        content: null,
        reason: 'too_large',
      });
    }
    let buf;
    try {
      buf = fs.readFileSync(target);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
    const sniff = buf.subarray(0, Math.min(512, buf.length));
    let binary = false;
    for (let i = 0; i < sniff.length; i++) {
      if (sniff[i] === 0) { binary = true; break; }
    }
    if (binary) {
      return sendJson(res, 200, {
        type: 'file',
        path: cleanRel,
        size: stat.size,
        binary: true,
        content: null,
      });
    }
    return sendJson(res, 200, {
      type: 'file',
      path: cleanRel,
      size: stat.size,
      binary: false,
      mtime: stat.mtime.toISOString(),
      content: buf.toString('utf8'),
    });
  }

  return sendJson(res, 400, { ok: false, error: 'unsupported file type' });
}

const RAW_MAX_BYTES = 200 * 1024 * 1024; // 200 MB

const RAW_MIME = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.bmp':  'image/bmp',
  '.ico':  'image/x-icon',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mov':  'video/quicktime',
  '.ogv':  'video/ogg',
  '.m4v':  'video/x-m4v',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.m4a':  'audio/mp4',
  '.flac': 'audio/flac',
  '.pdf':  'application/pdf',
  '.txt':  'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function parseRange(headerVal, size) {
  // Returns { start, end } (inclusive) or null if absent;
  // returns { unsatisfiable: true } if malformed/out-of-range.
  if (!headerVal || typeof headerVal !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(headerVal.trim());
  if (!m) return { unsatisfiable: true };
  const startStr = m[1];
  const endStr = m[2];
  let start;
  let end;
  if (startStr === '' && endStr === '') return { unsatisfiable: true };
  if (startStr === '') {
    // suffix: last N bytes
    const n = parseInt(endStr, 10);
    if (!Number.isFinite(n) || n <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? size - 1 : parseInt(endStr, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { unsatisfiable: true };
  }
  if (start > end || start < 0 || end >= size) return { unsatisfiable: true };
  return { start, end };
}

function handleFilesRaw(req, res, rec, method) {
  const cwd = rec && rec.cwd;
  if (!cwd) return sendJson(res, 404, { ok: false, error: 'agent cwd missing' });

  const urlObj = new URL(req.url, 'http://x');
  const rel = urlObj.searchParams.get('path') || '';
  const cleanRel = String(rel).replace(/^\/+/, '');

  let target;
  try {
    target = path.resolve(cwd, cleanRel);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid path' });
  }
  if (!withinAgentScope(cwd, target)) {
    return sendJson(res, 400, { ok: false, error: 'path escapes agent scope' });
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return sendJson(res, 404, { ok: false, error: 'path not found' });
    }
    return sendJson(res, 500, { ok: false, error: err.message });
  }

  if (stat.isDirectory()) {
    return sendJson(res, 400, { ok: false, error: 'path is a directory' });
  }
  if (!stat.isFile()) {
    return sendJson(res, 400, { ok: false, error: 'unsupported file type' });
  }
  if (stat.size > RAW_MAX_BYTES) {
    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'file too large' }));
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const contentType = RAW_MIME[ext] || 'application/octet-stream';
  const lastModified = stat.mtime.toUTCString();

  const rangeHeader = req.headers['range'];
  const parsed = parseRange(rangeHeader, stat.size);
  if (parsed && parsed.unsatisfiable) {
    res.writeHead(416, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Range': `bytes */${stat.size}`,
    });
    res.end(JSON.stringify({ ok: false, error: 'range not satisfiable' }));
    return;
  }

  if (parsed) {
    const { start, end } = parsed;
    const chunkLen = end - start + 1;
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Length': String(chunkLen),
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Last-Modified': lastModified,
    });
    if (method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(target, { start, end });
    stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
    stream.pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': String(stat.size),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Last-Modified': lastModified,
  });
  if (method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(target);
  stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
  stream.pipe(res);
}

function handleGlobalBgTerminals(req, res) {
  // Aggregate every live bg shell across every agent so the topbar pill +
  // global viewer can show long-running processes (e.g. `npm run dev`)
  // without the user having to remember which conversation owns them.
  //
  // Two sources, merged:
  //   1. acp-client.terminalHost._terminals (ACP terminal/create RPC path)
  //   2. agent record.bgTasks (grok-specific _x.ai/task_backgrounded path)
  const out = [];
  let runningTotal = 0;
  for (const rec of manager.list()) {
    const a = manager.getRaw(rec.id);
    const merged = mergeBgSources(a);
    for (const t of merged) if (!t.exited) runningTotal++;
    if (merged.length) {
      out.push({ agentId: rec.id, agentName: rec.name || rec.id, terminals: merged });
    }
  }
  return sendJson(res, 200, { ok: true, runningCount: runningTotal, agents: out });
}

// Merge ACP terminal host entries with grok bgTasks for a single agent.
// The agent uses both paths for the same physical process (it calls our
// ACP terminal/create which assigns the id, then emits task_backgrounded
// with the same id). Dedup by id and merge fields so each shell shows up
// once per agent. Sort newest-first by start time.
function mergeBgSources(a) {
  const byId = new Map();
  const host = a && a.client && a.client.terminalHost;
  if (host && host._terminals) {
    for (const t of host._terminals.values()) {
      byId.set(t.id, {
        id: t.id,
        source: 'acp',
        command: t.command,
        cwd: t.cwd,
        exited: !!t.exited,
        exitStatus: t.exitStatus || null,
        bytes: t.buffer ? t.buffer.length : 0,
        truncated: !!t.truncated,
        outputFile: null,
        startedAt: null,
        endedAt: null,
      });
    }
  }
  if (a && a.bgTasks && a.bgTasks.size) {
    for (const t of a.bgTasks.values()) {
      const grokStatus = (t.exit_code != null || t.signal)
        ? { exitCode: t.exit_code, signal: t.signal }
        : null;
      const existing = byId.get(t.id);
      if (existing) {
        // Same physical process. Prefer the agent's unwrapped command for
        // readability ("npm run dev" vs "/bin/bash -lc 'npm run dev'").
        existing.source = 'merged';
        existing.command = t.command || existing.command;
        existing.cwd = t.cwd || existing.cwd;
        existing.outputFile = t.output_file || existing.outputFile;
        existing.startedAt = t.startedAt || existing.startedAt;
        existing.endedAt = t.endedAt || existing.endedAt;
        // If either source says exited, treat as exited. Prefer ACP exit
        // status when present since it has real OS exitCode/signal data.
        if (t.completed && !existing.exited) existing.exited = true;
        if (!existing.exitStatus && grokStatus) existing.exitStatus = grokStatus;
      } else {
        byId.set(t.id, {
          id: t.id,
          source: 'grok',
          command: t.command,
          cwd: t.cwd,
          outputFile: t.output_file || null,
          exited: !!t.completed,
          exitStatus: grokStatus,
          startedAt: t.startedAt,
          endedAt: t.endedAt || null,
        });
      }
    }
  }
  // Annotate with a detected local URL when the command looks like a dev
  // server (and either the captured output or the cmdline gives us a port).
  // ACP terminals carry their buffer in-memory; grok bg tasks have an
  // output_file on disk we can tail.
  for (const t of byId.values()) {
    if (!t.url) {
      let output = '';
      if (t.source === 'acp' || t.source === 'merged') {
        const acpT = host && host._terminals && host._terminals.get(t.id);
        if (acpT && acpT.buffer) {
          output = acpT.buffer.toString('utf8', 0, Math.min(acpT.buffer.length, 16 * 1024));
        }
      }
      if (!output && t.outputFile) {
        try {
          const buf = readFileTail(t.outputFile, 16 * 1024);
          if (buf) output = buf.toString('utf8');
        } catch { /* ignore */ }
      }
      // Grok occasionally cleans up the on-disk log between turns; fall back
      // to the cached TaskOutput snapshot the manager grabbed off the stream.
      if (!output && (t.source === 'grok' || t.source === 'merged')) {
        const bg = a && a.bgTasks && a.bgTasks.get(t.id);
        if (bg && typeof bg.cached_output === 'string' && bg.cached_output.length) {
          output = bg.cached_output;
        }
      }
      const url = inferDevServerUrl(t.command, output);
      if (url) t.url = url;
    }
  }
  return [...byId.values()].sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0));
}

function readFileTail(filePath, n) {
  try {
    const st = fs.statSync(filePath);
    const size = st.size;
    if (size <= n) return fs.readFileSync(filePath);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    fs.closeSync(fd);
    return buf;
  } catch { return null; }
}

function handleTerminalList(req, res, rec) {
  const a = manager.getRaw(rec.id);
  return sendJson(res, 200, { ok: true, terminals: mergeBgSources(a) });
}

function handleTerminalRead(req, res, rec, tid) {
  const a = manager.getRaw(rec.id);
  const host = a && a.client && a.client.terminalHost;
  const t = host && host._terminals && host._terminals.get(tid);
  if (t) {
    const output = t.buffer ? t.buffer.toString('utf8') : '';
    return sendJson(res, 200, {
      ok: true,
      id: t.id,
      source: 'acp',
      command: t.command,
      cwd: t.cwd,
      exited: !!t.exited,
      exitStatus: t.exitStatus || null,
      truncated: !!t.truncated,
      output,
      url: inferDevServerUrl(t.command, output),
    });
  }
  // Fall through to grok bg tasks (they have an output_file we tail).
  return handleBgTaskRead(req, res, rec, tid);
}

function handleBgTaskRead(req, res, rec, tid) {
  // Read a grok-backgrounded task: status + tail of its log file. The agent
  // emits the log path in the original `_x.ai/task_backgrounded` event so
  // we can read it directly.
  const a = manager.getRaw(rec.id);
  const t = a && a.bgTasks && a.bgTasks.get(tid);
  if (!t) return sendJson(res, 404, { ok: false, error: 'bg task not found' });
  const TAIL_BYTES = 64 * 1024;
  let output = '';
  let truncated = false;
  if (t.output_file) {
    try {
      const st = fs.statSync(t.output_file);
      const size = st.size;
      if (size > TAIL_BYTES) {
        const fd = fs.openSync(t.output_file, 'r');
        const buf = Buffer.alloc(TAIL_BYTES);
        fs.readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
        fs.closeSync(fd);
        output = buf.toString('utf8');
        truncated = true;
      } else {
        output = fs.readFileSync(t.output_file, 'utf8');
      }
    } catch (err) {
      // Grok may have rotated or deleted the log; fall back to the snapshot
      // the manager cached off the in-stream TaskOutput notifications.
      if (typeof t.cached_output === 'string' && t.cached_output.length) {
        output = t.cached_output;
      } else {
        output = `[grok-remote] failed to read log: ${err.message}`;
      }
    }
  } else if (typeof t.cached_output === 'string' && t.cached_output.length) {
    output = t.cached_output;
  }
  return sendJson(res, 200, {
    ok: true,
    id: t.id,
    source: 'grok',
    command: t.command,
    cwd: t.cwd,
    outputFile: t.output_file || null,
    startedAt: t.startedAt,
    endedAt: t.endedAt || null,
    exited: !!t.completed,
    exitStatus: (t.exit_code != null || t.signal) ? { exitCode: t.exit_code, signal: t.signal } : null,
    truncated,
    output,
    url: inferDevServerUrl(t.command, output),
  });
}

function handleTerminalKill(req, res, rec, tid) {
  const a = manager.getRaw(rec.id);
  // First try the ACP terminal host (our own spawn).
  const host = a && a.client && a.client.terminalHost;
  const t = host && host._terminals && host._terminals.get(tid);
  if (t) {
    try {
      if (t.proc && !t.exited) t.proc.kill('SIGTERM');
    } catch { /* ignore */ }
    return sendJson(res, 200, { ok: true });
  }
  // Otherwise: grok-owned bg task. We don't have the PID directly, so we
  // pkill -f over the task's cwd substring (matches both the npm wrapper
  // and any spawned child like vite). Mark the record completed so the UI
  // reflects the kill on the next poll even before the task_completed
  // notification arrives from the agent.
  const bg = a && a.bgTasks && a.bgTasks.get(tid);
  if (!bg) return sendJson(res, 404, { ok: false, error: 'terminal not found' });
  if (bg.completed) return sendJson(res, 200, { ok: true, alreadyExited: true });
  const cwd = bg.cwd || '';
  if (!cwd) return sendJson(res, 500, { ok: false, error: 'task has no cwd; cannot derive kill pattern' });
  try {
    spawnSync('/usr/bin/pkill', ['-TERM', '-f', cwd], { timeout: 4000 });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: `pkill failed: ${err.message}` });
  }
  // Optimistically mark the task completed; if the agent later emits
  // task_completed it'll update the exit_code/signal fields.
  bg.completed = true;
  bg.signal    = bg.signal || 'killed-by-user';
  bg.endedAt   = Date.now();
  try { manager.emit('list_changed', { event: 'bg_tasks', id: rec.id, count: 0 }); } catch { /* ignore */ }
  return sendJson(res, 200, { ok: true, source: 'grok', killed: true });
}

function handleVersionUpdateStream(req, res) {
  // POST /api/version/update returns an SSE stream of { step, status, detail }
  // events. The final restart step triggers pm2 to SIGTERM us; the connection
  // dies mid-flight and the frontend polls /api/health to detect recovery.
  sseHeaders(res);
  let counter = 0;
  const send = (data) => {
    sseWrite(res, {
      id: `vupd-${Date.now()}-${++counter}`,
      event: 'update',
      data,
    });
  };
  // Initial hello so the client sees the channel is live before the first
  // step lands (preflight can take a moment if git is slow).
  send({ step: 'open', status: 'ok', detail: 'connected' });

  const heartbeat = setInterval(() => ssePing(res), 5000);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (!res.writableEnded) try { res.end(); } catch { /* ignore */ }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);

  runVersionUpdate({
    emit: (ev) => { if (!closed) send(ev); },
  }).then(() => {
    if (!closed) {
      send({ step: 'done', status: 'ok', detail: 'all steps completed' });
      cleanup();
    }
  }).catch((err) => {
    if (!closed) {
      send({ step: 'done', status: 'fail', detail: err && err.message || String(err) });
      cleanup();
    }
  });
}

function handleAgentsStream(req, res) {
  sseHeaders(res);
  let counter = 0;
  // Initial snapshot so the consumer doesn't need a separate GET first.
  sseWrite(res, {
    id: `agents-${Date.now()}-${++counter}`,
    event: 'agents_snapshot',
    data: { agents: manager.list() },
  });
  const onChange = (payload) => {
    sseWrite(res, {
      id: `agents-${Date.now()}-${++counter}`,
      event: payload.event || 'agents_changed',
      data: payload,
    });
  };
  manager.on('list_changed', onChange);
  const heartbeat = setInterval(() => ssePing(res), 15000);
  const cleanup = () => {
    clearInterval(heartbeat);
    try { manager.off('list_changed', onChange); } catch { /* ignore */ }
    if (!res.writableEnded) try { res.end(); } catch { /* ignore */ }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

function handleStream(req, res, id) {
  const ring = manager.ring(id);
  if (!ring) return sendJson(res, 404, { ok: false, error: 'agent not found' });

  sseHeaders(res);
  const lastId = req.headers['last-event-id'];
  for (const ev of ring.since(lastId)) {
    sseWrite(res, ev);
  }

  const unsub = manager.subscribe(id, (ev) => sseWrite(res, ev));
  const heartbeat = setInterval(() => ssePing(res), 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    try { unsub(); } catch { /* ignore */ }
    if (!res.writableEnded) try { res.end(); } catch { /* ignore */ }
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  if (url.startsWith('/api/system/')) {
    try {
      await handleSystem(req, res, url);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }
  if (url.startsWith('/api/')) {
    try {
      await handleApi(req, res, url, req.method || 'GET');
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }
  serveStatic(req, res);
});

const retention = startRetentionTimer({ getSettings: loadSettings, manager });

server.listen(PORT, HOST, () => {
  const ts = tailscaleIdentity();
  const where = ts?.dns ? `http://${ts.dns}:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`[grok-remote] listening on ${HOST}:${PORT}`);
  console.log(`[grok-remote] tailnet url: ${where}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { retention.stop(); } catch { /* ignore */ }
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[grok-remote] shutdown on ${signal}`);
  try { await manager.shutdownAll(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
