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

/** Per-node-type closed and (worst-case) open pixel heights. Mirrored from
 * style.css so dagre never under-reserves space when laying out. */
export interface NodeDim { closed: number; open: number }

export const NODE_HEIGHTS: Record<string, NodeDim> = {
  agent:      { closed: 135, open: 135 },
  tool:       { closed: 42,  open: 280 },
  group:      { closed: 56,  open: 56 },
  subAgent:   { closed: 138, open: 340 },
  bgTask:     { closed: 78,  open: 78 },
  milestone:  { closed: 50,  open: 50 },
};

export const NODE_WIDTHS: Record<string, NodeDim> = {
  agent:      { closed: 220, open: 220 },
  tool:       { closed: 180, open: 340 },
  group:      { closed: 180, open: 180 },
  subAgent:   { closed: 180, open: 280 },
  bgTask:     { closed: 220, open: 220 },
  milestone:  { closed: 200, open: 200 },
};

/** Look up the rendered height for a node type. Unknown types fall back to
 * the tool dimensions so dagre always gets a sane number. */
export function nodeKind(typeName: string, isOpen: boolean): number {
  const h = NODE_HEIGHTS[typeName] || NODE_HEIGHTS.tool!;
  return isOpen ? h.open : h.closed;
}

/** Look up the rendered width for a node type. Same fallback as nodeKind. */
export function nodeWidth(typeName: string, isOpen: boolean): number {
  const w = NODE_WIDTHS[typeName] || NODE_WIDTHS.tool!;
  return isOpen ? w.open : w.closed;
}

// Sub-agent id extraction.
//
// Pluck the sub-agent's session id from a sub record. Two sources:
//   1. SubagentCompleted rawOutput.subagent_id — set when the sub-agent
//      completed inline and emitted its final payload.
//   2. The spawn-ack content text "subagent_id: <uuid>" — used by
//      run_in_background=true spawns (they don't get a SubagentCompleted).
// Caller is expected to cache the result on the sub record.
export const SUBAGENT_ID_RE = /subagent_id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

interface SubRecord {
  rawOutput?: unknown;
  response?: unknown;
}

export function extractSubagentId(sub: unknown): string | null {
  if (!sub || typeof sub !== 'object') return null;
  const s = sub as SubRecord;
  const ro = s.rawOutput;
  if (ro && typeof ro === 'object') {
    const r = ro as { subagent_id?: unknown; text?: unknown };
    if (typeof r.subagent_id === 'string' && r.subagent_id) return r.subagent_id;
    if (typeof r.text === 'string') {
      const m = r.text.match(SUBAGENT_ID_RE);
      if (m && m[1]) return m[1];
    }
  }
  if (Array.isArray(s.response)) {
    for (const block of s.response) {
      const t = block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '';
      const m = t.match(SUBAGENT_ID_RE);
      if (m && m[1]) return m[1];
    }
  }
  return null;
}

// Tool-call grouping for the flow canvas.
//
// Same-kind tool calls that started within GROUP_GAP_MS of the previous
// call's end collapse into a single group node when the run length is at
// or above `threshold`. Anything below threshold stays as individual call
// entries. Output is the layout pass's input list: each entry is either
// `{ type: 'group', ...stats }` or `{ type: 'call', call }`.

export const GROUP_GAP_MS = 3000;

export interface GroupableCall {
  kind?: string;
  startedAt?: number;
  endedAt?: number | null;
  status?: string;
  [k: string]: unknown;
}

export type GroupedEntry =
  | { type: 'call'; call: GroupableCall }
  | {
      type: 'group';
      kind: string;
      count: number;
      startedAt: number;
      endedAt: number | null;
      totalMs: number;
      failedCount: number;
      items: GroupableCall[];
    };

export function groupToolCalls(
  sortedCalls: GroupableCall[],
  threshold = 3,
): GroupedEntry[] {
  const minRun = Number.isFinite(threshold) && threshold >= 2 ? threshold : Infinity;
  const out: GroupedEntry[] = [];
  let i = 0;
  while (i < sortedCalls.length) {
    const start = sortedCalls[i];
    if (!start) { i++; continue; }
    const kind = start.kind || 'tool';
    let j = i + 1;
    while (j < sortedCalls.length) {
      const prev = sortedCalls[j - 1];
      const next = sortedCalls[j];
      if (!prev || !next) break;
      if ((next.kind || 'tool') !== kind) break;
      const prevEnd = prev.endedAt || prev.startedAt || 0;
      const nextStart = next.startedAt || 0;
      if (nextStart - prevEnd > GROUP_GAP_MS) break;
      j++;
    }
    const runLen = j - i;
    if (runLen >= minRun) {
      const items = sortedCalls.slice(i, j);
      const totalMs = items.reduce((acc, c) => {
        const e = c.endedAt || (c.startedAt ? Date.now() : 0);
        const s = c.startedAt || 0;
        return acc + Math.max(0, e - s);
      }, 0);
      const failedCount = items.filter((c) =>
        String(c.status || '').toLowerCase() === 'failed',
      ).length;
      const first = items[0];
      const last = items[items.length - 1];
      out.push({
        type: 'group',
        kind,
        count: runLen,
        startedAt: (first && first.startedAt) || 0,
        endedAt: (last && last.endedAt) || null,
        totalMs,
        failedCount,
        items,
      });
    } else {
      for (let k = i; k < j; k++) {
        const c = sortedCalls[k];
        if (c) out.push({ type: 'call', call: c });
      }
    }
    i = j;
  }
  return out;
}
