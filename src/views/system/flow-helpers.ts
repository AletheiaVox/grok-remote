// Pure helpers extracted from flow.tsx so they can be unit-tested without a
// React Flow / DOM environment. The originals lived inside a `@ts-nocheck`
// region; the typed versions here are the canonical home.

interface MaybeTool {
  kind?: unknown;
  title?: unknown;
  rawInput?: unknown;
}

interface MaybeRawInput {
  variant?: unknown;
  subagent_type?: unknown;
  description?: unknown;
  prompt?: unknown;
  command?: unknown;
  cmd?: unknown;
  path?: unknown;
  file_path?: unknown;
  url?: unknown;
}

interface ToolContentBlock {
  kind: string;
  text: string;
}

interface ContentBlockInput {
  type?: unknown;
  text?: unknown;
  content?: unknown;
}

// A tool_call whose kind matches this regex (or whose rawInput shape signals
// a Task / subagent_type) is rendered as a sub-agent node instead of a
// regular tool pill.
export const SUB_AGENT_KIND_RE = /^agent(?:\(.*\))?$/i;

/**
 * True when an ACP `tool_call`/`tool_call_update` payload should be rendered
 * as a sub-agent rather than a regular tool. Three signals (any one suffices):
 *   1. rawInput.variant === "Task"               (canonical grok subagent shape)
 *   2. rawInput.subagent_type is a non-empty string
 *   3. payload.kind matches SUB_AGENT_KIND_RE     (legacy / ACP-style)
 */
export function isSubAgentCall(u: unknown): boolean {
  if (!u || typeof u !== 'object') return false;
  const t = u as MaybeTool;
  if (SUB_AGENT_KIND_RE.test(String(t.kind || ''))) return true;
  const ri = t.rawInput;
  if (ri && typeof ri === 'object') {
    const r = ri as MaybeRawInput;
    if (r.variant === 'Task') return true;
    if (typeof r.subagent_type === 'string' && r.subagent_type) return true;
  }
  return false;
}

/**
 * Best-effort label for a sub-agent node. Priority: rawInput.description >
 * title > first line of rawInput.prompt (capped at 80 chars) > "sub-agent".
 */
export function pickSubAgentLabel(u: unknown): string {
  if (!u || typeof u !== 'object') return 'sub-agent';
  const t = u as MaybeTool;
  const ri = (t.rawInput && typeof t.rawInput === 'object' ? t.rawInput : {}) as MaybeRawInput;
  if (typeof ri.description === 'string' && ri.description.trim()) {
    return ri.description.trim();
  }
  if (typeof t.title === 'string' && t.title.trim()) {
    return t.title.trim();
  }
  if (typeof ri.prompt === 'string' && ri.prompt.trim()) {
    return ri.prompt.trim().split('\n')[0]!.slice(0, 80);
  }
  return 'sub-agent';
}

/**
 * Short label for a tool pill. Priority: ACP-provided title > rawInput.command
 * / cmd > "<kind>: <path>" for read-like tools > url > kind > "tool".
 */
export function pickToolLabel(u: unknown): string {
  if (!u || typeof u !== 'object') return 'tool';
  const t = u as MaybeTool;
  if (typeof t.title === 'string' && t.title.trim()) return t.title.trim();
  const ri = t.rawInput;
  if (ri && typeof ri === 'object') {
    const r = ri as MaybeRawInput;
    if (typeof r.command === 'string' && r.command.trim()) return r.command.trim();
    if (typeof r.cmd === 'string' && r.cmd.trim()) return r.cmd.trim();
    if (typeof r.path === 'string' && r.path.trim()) return `${t.kind || 'tool'}: ${r.path.trim()}`;
    if (typeof r.file_path === 'string' && r.file_path.trim()) return `${t.kind || 'tool'}: ${r.file_path.trim()}`;
    if (typeof r.url === 'string' && r.url.trim()) return r.url.trim();
  }
  if (typeof t.kind === 'string' && t.kind.trim()) return t.kind.trim();
  return 'tool';
}

/**
 * Normalize tool content blocks (varied ACP shapes) into a stable
 * `[{ kind, text }]` list the renderer can iterate.
 */
export function extractToolContent(content: unknown): ToolContentBlock[] {
  if (!content) return [];
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const out: ToolContentBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as ContentBlockInput;
    if (b.type === 'content' || b.type === 'text') {
      let inner: unknown = '';
      if (b.content && typeof b.content === 'object' && b.content !== null) {
        inner = (b.content as { text?: unknown }).text;
      }
      if (inner === undefined || inner === null || inner === '') inner = b.text;
      if (inner === undefined || inner === null || inner === '') inner = b.content;
      if (inner === undefined || inner === null) inner = '';
      out.push({ kind: 'text', text: typeof inner === 'string' ? inner : JSON.stringify(inner) });
      continue;
    }
    if (b.text) { out.push({ kind: 'text', text: String(b.text) }); continue; }
    if (b.content && typeof b.content === 'string') {
      out.push({ kind: 'text', text: b.content });
      continue;
    }
    out.push({ kind: typeof b.type === 'string' ? b.type : 'block', text: JSON.stringify(raw) });
  }
  return out;
}

/**
 * Concatenate two streams of content blocks, deduplicating the last/first
 * pair when they match exactly. Defends against repeated full snapshots
 * arriving via tool_call_update after a tool_call_delta_chunk.
 */
export function mergeToolContent(
  prev: ToolContentBlock[] | undefined | null,
  next: ToolContentBlock[] | undefined | null,
): ToolContentBlock[] {
  if (!Array.isArray(prev) || !prev.length) return Array.isArray(next) ? next : [];
  if (!Array.isArray(next) || !next.length) return prev;
  const last = prev[prev.length - 1];
  const first = next[0];
  if (last && first && last.kind === first.kind && last.text === first.text) {
    return prev.concat(next.slice(1));
  }
  return prev.concat(next);
}

/**
 * Count tool calls that have not finished. Used by FlowInner to size the
 * "in-flight" pill on each agent node.
 */
export function countActive(calls: Record<string, { endedAt?: number | null }>): number {
  let n = 0;
  for (const c of Object.values(calls)) {
    if (!c.endedAt) n++;
  }
  return n;
}

/**
 * Map AcpClient lifecycle states to the canonical set the renderer cares
 * about: idle | running | errored | disconnected | unknown. `exited`/`killed`
 * both collapse to `disconnected` since the UI shows them identically.
 */
export function normaliseStatus(s: unknown): string {
  if (!s) return 'unknown';
  if (s === 'exited' || s === 'killed') return 'disconnected';
  return String(s);
}

/**
 * Build an SVG path pair (line + filled area) for a sparkline of token usage
 * over time. Each point is `{ t, v }`; we plot `v` across width `W`, height
 * `H`. Returns `{ line, area }` strings ready to drop into <path d="...">.
 */
export interface SparkPoint { t?: number; v: number }
export interface SparkPath { line: string; area: string }

export function buildSparkPath(history: SparkPoint[], W: number, H: number): SparkPath {
  const n = history.length;
  const values = history.map((p) => p.v);
  const vMin = Math.min(...values);
  const vMax = Math.max(...values);
  const range = Math.max(1, vMax - vMin);
  const xs = (i: number): number => (n === 1 ? 0 : (i / (n - 1)) * W);
  const ys = (v: number): number => H - 1 - ((v - vMin) / range) * (H - 2);
  let d = '';
  for (let i = 0; i < n; i++) {
    const point = history[i];
    if (!point) continue;
    const x = xs(i).toFixed(2);
    const y = ys(point.v).toFixed(2);
    d += (i === 0 ? 'M' : 'L') + ' ' + x + ' ' + y + ' ';
  }
  const area = d + ` L ${W} ${H} L 0 ${H} Z`;
  return { line: d.trim(), area };
}

/** Stringify any value safely for display. Returns '' for null/undefined,
 * the string itself for strings, JSON.stringify(_, null, 2) for objects, and
 * String(v) as a last resort if JSON.stringify throws (cyclic refs, etc.). */
export function safeStringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/**
 * Compact token counter used in flow node labels: passes through under 1k,
 * uses `Nk` with one decimal under 1M, `NM` with two decimals above.
 * Distinct from `src/lib/format.fmtTokens` (which uses different thresholds
 * for the chat-status pill).
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Human-readable duration for the "running for Xs / Xm Xs" labels on tool
 * pills and bg-task cards. Empty string for non-finite or negative inputs.
 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s ? ` ${s}s` : ''}`;
}

/** Collapse whitespace, trim, cap at 40 chars with an ellipsis. Returns
 * "(no command)" when the input is empty. Used by bg-task cards. */
export function truncCmd(s: unknown): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= 40) return t || '(no command)';
  return t.slice(0, 37) + '...';
}
