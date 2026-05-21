// Dispatcher for /api/system/* routes.

import type { IncomingMessage, ServerResponse } from 'node:http';

import * as mcpRoutes        from './system/mcp.js';
import * as leadersRoutes    from './system/leaders.js';
import * as worktreesRoutes  from './system/worktrees.js';
import * as memoryRoutes     from './system/memory.js';
import * as modelsRoutes     from './system/models.js';
import * as healthRoutes     from './system/health.js';
import * as sessionsRoutes   from './system/sessions.js';
import * as importRoutes     from './system/import.js';
import * as setupRoutes      from './system/setup.js';
import * as skillsRoutes     from './system/skills.js';
import * as agentsRoutes     from './system/agents.js';

export type RouteParams = Record<string, string>;
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  urlObj: URL,
  params?: RouteParams,
) => Promise<void> | void;

export type RouteRegistrar = (method: string, path: string, handler: RouteHandler) => void;

interface RouteModule {
  register?: (add: RouteRegistrar) => void;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const ROUTES = new Map<string, RouteHandler>();
function add(method: string, path: string, handler: RouteHandler): void {
  ROUTES.set(`${method} ${path}`, handler);
}

const REGISTRARS: RouteModule[] = [
  mcpRoutes as RouteModule,
  leadersRoutes as RouteModule,
  worktreesRoutes as RouteModule,
  memoryRoutes as RouteModule,
  modelsRoutes as RouteModule,
  healthRoutes as RouteModule,
  sessionsRoutes as RouteModule,
  importRoutes as RouteModule,
  setupRoutes as RouteModule,
  skillsRoutes as RouteModule,
  agentsRoutes as RouteModule,
];
for (const mod of REGISTRARS) {
  if (mod && typeof mod.register === 'function') mod.register(add);
}

export async function handleSystem(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
  const method = req.method || 'GET';
  const exact = ROUTES.get(`${method} ${url}`);
  if (exact) {
    try {
      const urlObj = new URL(req.url || '/', 'http://x');
      await exact(req, res, urlObj);
    } catch (err) {
      if (!res.headersSent) {
        const msg = err instanceof Error ? err.message : String(err);
        send(res, 500, { ok: false, error: msg });
      }
    }
    return true;
  }

  for (const [key, handler] of ROUTES) {
    const [m, pattern] = splitKey(key);
    if (m !== method) continue;
    const params = matchPattern(pattern, url);
    if (params) {
      try {
        const urlObj = new URL(req.url || '/', 'http://x');
        void urlObj.searchParams;
        await handler(req, res, urlObj, params);
      } catch (err) {
        if (!res.headersSent) {
          const msg = err instanceof Error ? err.message : String(err);
          send(res, 500, { ok: false, error: msg });
        }
      }
      return true;
    }
  }

  send(res, 404, { ok: false, error: `unknown system route: ${method} ${url}` });
  return true;
}

function splitKey(k: string): [string, string] {
  const i = k.indexOf(' ');
  return [k.slice(0, i), k.slice(i + 1)];
}

function matchPattern(pattern: string, url: string): RouteParams | null {
  if (!pattern.includes(':')) return null;
  const p = pattern.split('/');
  const u = url.split('/');
  if (p.length !== u.length) return null;
  const params: RouteParams = {};
  for (let i = 0; i < p.length; i++) {
    const piece = p[i];
    const upiece = u[i];
    if (piece === undefined || upiece === undefined) return null;
    if (piece.startsWith(':')) {
      params[piece.slice(1)] = decodeURIComponent(upiece);
    } else if (piece !== upiece) {
      return null;
    }
  }
  return params;
}
