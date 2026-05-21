// Best-effort detection of the local URL a background process is serving.
// Looks at the captured output first (most reliable: dev servers print
// "Local: http://localhost:PORT/" on startup) and falls back to parsing
// the command line for a port flag plus framework-default ports.

const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}(?:\/[^\s,)\]]*)?)/i;

// Vite (and most dev servers) colorize their startup banner with ANSI escape
// codes. Strip CSI sequences first so the URL is contiguous before matching.
function stripAnsi(s: string | null | undefined): string {
  if (!s) return '';
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
}

export function scanOutputForUrl(output: unknown): string | null {
  if (!output || typeof output !== 'string') return null;
  const cleaned = stripAnsi(output);
  const m = cleaned.match(URL_RE);
  if (!m || !m[1]) return null;
  // 0.0.0.0 isn't browsable; rewrite to localhost.
  return m[1].replace('://0.0.0.0', '://localhost');
}

export function parsePortFromCommand(cmd: unknown): number | null {
  if (!cmd || typeof cmd !== 'string') return null;

  // Explicit port flags first, most specific to least.
  let m = cmd.match(/--port[=\s]+(\d{2,5})/);
  if (m && m[1]) return Number(m[1]);
  m = cmd.match(/(?:^|\s)-p[=\s]+(\d{2,5})\b/);
  if (m && m[1]) return Number(m[1]);
  // Bind-style like "host:5173" — only when the prefix looks like a host.
  m = cmd.match(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/);
  if (m && m[1]) return Number(m[1]);

  // Framework defaults.
  if (/\bnext\s+(?:dev|start)\b/.test(cmd))                return 3000;
  if (/\b(?:vite|astro\s+dev|nuxt\s+dev|svelte-kit\s+dev|remix\s+dev)\b/.test(cmd)) return 5173;
  if (/\bgatsby\s+develop\b/.test(cmd))                    return 8000;
  if (/\bnpm\s+(?:run\s+)?(?:dev|start)\b/.test(cmd))      return 5173;
  if (/\b(?:pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start)\b/.test(cmd)) return 5173;
  if (/\bstreamlit\s+run\b/.test(cmd))                     return 8501;
  if (/\bflask\s+run\b/.test(cmd))                         return 5000;
  if (/\bmanage\.py\s+runserver\b/.test(cmd))              return 8000;
  if (/\buvicorn\b/.test(cmd))                             return 8000;
  if (/\bpython\s+-m\s+http\.server\b/.test(cmd))          return 8000;
  if (/\brails\s+(?:s|server)\b/.test(cmd))                return 3000;
  if (/\bphx\.server\b/.test(cmd))                         return 4000;
  if (/\bjekyll\s+serve\b/.test(cmd))                      return 4000;
  if (/\bphp\s+artisan\s+serve\b/.test(cmd))               return 8000;
  if (/\bphp\s+-S\b/.test(cmd)) {
    const hm = cmd.match(/php\s+-S\s+[^:\s]+:(\d{2,5})/);
    if (hm && hm[1]) return Number(hm[1]);
  }
  if (/\bcaddy\s+(?:run|start)\b/.test(cmd))               return 2015;
  if (/\bhttp-server\b/.test(cmd))                         return 8080;
  if (/\bserve\b/.test(cmd))                               return 3000;
  return null;
}

const DEV_HINTS = /\b(?:vite|next\s+(?:dev|start)|nuxt\s+dev|astro\s+dev|svelte-kit\s+dev|remix\s+dev|gatsby\s+develop|npm\s+(?:run\s+)?(?:dev|start|serve)|(?:pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)|streamlit\s+run|flask\s+run|manage\.py\s+runserver|uvicorn|gunicorn|python\s+-m\s+http\.server|rails\s+(?:s|server)|phx\.server|jekyll\s+serve|php\s+artisan\s+serve|php\s+-S|caddy\s+(?:run|start)|http-server|\bserve\b)/;

export function looksLikeDevServer(cmd: unknown): boolean {
  if (!cmd || typeof cmd !== 'string') return false;
  return DEV_HINTS.test(cmd);
}

// Combined accessor. Tries output first, falls back to command parsing.
export function inferDevServerUrl(command: unknown, output?: unknown): string | null {
  const fromOutput = scanOutputForUrl(output);
  if (fromOutput) return fromOutput;
  if (!looksLikeDevServer(command)) return null;
  const port = parsePortFromCommand(command);
  return port ? `http://localhost:${port}/` : null;
}
