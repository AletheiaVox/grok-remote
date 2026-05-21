// Live agent flow page.
//
// Ported verbatim from flow.jsx. Full strict typing of the React Flow + dagre
// interop is deferred to Phase 10; the build (vite/esbuild) strips types so
// runtime behavior is identical to the .jsx version.
//
// Renders one node per agent on a React Flow canvas. For each agent we open
// an SSE stream and translate the events into:
//   - node status        ("idle" / "running" / "errored" / "disconnected")
//   - token totals       (from event _meta.totalTokens when present)
//   - tool-call satellite nodes (grouped when same-kind in close succession)
//   - background-task nodes (one per live grok bg shell, polled from
//                            /api/agents/:id/terminals)
//   - workflow milestones (turn boundaries, bg start/stop, dev-server URL)
//
// Click an agent node to jump to that agent's conversation. Toolbar exposes
// refresh (re-poll the list now), fit-view, a toggle to include archived
// agents, and a stats panel toggle.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';

import { api } from '../../lib/api';
import { fmtTokens } from '../../lib/format';
import { iconHtml } from '../../lib/icons';
import { FloatingEdge } from './flow-floating-edge';
import {
  SUB_AGENT_KIND_RE,
  isSubAgentCall,
  pickSubAgentLabel,
  pickToolLabel,
  extractToolContent,
  mergeToolContent,
  countActive,
  normaliseStatus,
  buildSparkPath,
  safeStringify,
  formatTokens,
  fmtDuration,
  truncCmd,
  NODE_HEIGHTS,
  NODE_WIDTHS,
  nodeKind,
  nodeWidth,
  SUBAGENT_ID_RE,
  extractSubagentId,
  GROUP_GAP_MS,
  groupToolCalls,
} from './flow-helpers.js';

// How often we re-poll the agent list. SSE keeps individual cards live; this
// is only here to pick up newly-spawned or deleted agents.
const LIST_POLL_MS = 5000;
// How often we re-poll the per-agent bg terminal list. The SSE stream gives
// us start/stop events, but the URL detection + output sniffing lives on
// the REST endpoint, so we poll while the view is open.
const BG_TERMINALS_POLL_MS = 2000;
// Cap milestones we keep around. Older ones rotate out of the strip.
const MILESTONE_CAP = 40;
// GROUP_GAP_MS moved to ./flow-helpers.ts (imported above).
void GROUP_GAP_MS;

// isSubAgentCall, pickSubAgentLabel, and SUB_AGENT_KIND_RE moved to
// ./flow-helpers.ts so they're typed + unit-testable. Imported above.
// Re-exported reference kept here for documentation; remove if unused.
void SUB_AGENT_KIND_RE;

// Pluck the sub-agent's session id from a sub record. Two sources:
//   1. SubagentCompleted rawOutput.subagent_id — set when the sub-agent
//      completed inline and emitted its final payload.
//   2. The spawn-ack content text "subagent_id: <uuid>" — used by
//      run_in_background=true spawns (they don't get a SubagentCompleted).
// The caller is expected to cache the result on the sub record so this
// only runs once per sub.
// SUBAGENT_ID_RE + extractSubagentId moved to ./flow-helpers.ts

// Walk a sub-agent's trace `updates.jsonl` rows and return a flat list of
// child tool-call entries. Mirrors the live applyAgentEventToState reducer
// but lives in a side channel so it doesn't pollute the parent agent's
// state. We only care about tool_call / tool_call_update rows; everything
// else (messages, thoughts, prompt boundaries) is irrelevant for the
// child-tool-node column.
function extractChildCallsFromTrace(traceData) {
  if (!traceData || !Array.isArray(traceData.updates)) return [];
  const byId = new Map(); // toolCallId -> child call record
  for (const row of traceData.updates) {
    if (!row || typeof row !== 'object') continue;
    // updates.jsonl rows from `grok trace` are JSON-RPC envelopes:
    //   { method: "session/update", params: { sessionId, update: {...}, _meta: {...} } }
    // The ACP-style update object lives under params.update; the _meta
    // (with agentTimestampMs + updateParams.status) lives under params._meta.
    // Fall back to the older flat shape just in case.
    const params = (row.params && typeof row.params === 'object') ? row.params : null;
    const u = (params && params.update && typeof params.update === 'object')
      ? params.update
      : ((row.update && typeof row.update === 'object') ? row.update : row);
    const meta = (params && params._meta) || row._meta || {};
    const sessionUpdate = u.sessionUpdate || row.sessionUpdate;
    if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') continue;
    const id = u.toolCallId || u.id;
    if (!id) continue;
    // Skip sub-sub-agent spawns inside the child for now; deep nesting can
    // come later. We don't render them as nodes anyway.
    if (isSubAgentCall(u)) continue;
    const at = Number.isFinite(meta.agentTimestampMs)
      ? meta.agentTimestampMs
      : (Number.isFinite(row.timestamp) ? row.timestamp * 1000 : Date.now());
    const status = (meta.updateParams && meta.updateParams.status) || u.status || 'Pending';
    const done = (status === 'Completed' || status === 'completed'
                  || status === 'Failed' || status === 'failed'
                  || status === 'canceled');
    const prev = byId.get(id) || {
      id,
      kind: u.kind || '',
      label: pickToolLabel(u),
      status: 'Pending',
      rawInput: null,
      rawOutput: null,
      content: [],
      locations: [],
      startedAt: at,
      endedAt: null,
    };
    const nextContent = u.content
      ? mergeToolContent(prev.content, extractToolContent(u.content))
      : prev.content;
    const merged = {
      ...prev,
      kind: u.kind || prev.kind,
      label: pickToolLabel(u) || prev.label,
      status,
      rawInput: (u.rawInput != null) ? u.rawInput : prev.rawInput,
      rawOutput: (u.rawOutput != null) ? u.rawOutput : prev.rawOutput,
      content: nextContent,
      locations: Array.isArray(u.locations) && u.locations.length ? u.locations.slice() : prev.locations,
      endedAt: done ? (prev.endedAt || at) : prev.endedAt,
    };
    byId.set(id, merged);
  }
  return [...byId.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

// (Older hand-rolled layout constants used to live here: column offsets,
// inter-card gaps, agent row pitch. dagre now derives spacing from each
// node's width/height + the `nodesep`/`ranksep` config in the layout pass.)

// Per-node-type closed and (worst-case) open pixel heights. These mirror the
// rendered card geometry in style.css. Open heights are conservative ceilings
// so the dagre layout never under-reserves space.
// NODE_HEIGHTS + NODE_WIDTHS moved to ./flow-helpers.ts
// Per-grouped-tool-child row height when a group is expanded (each child
// stacks below its parent group node).
const GROUP_CHILD_ROW = 42;
// Per-grouped-tool-child row height when the child itself is also expanded.
const GROUP_CHILD_ROW_OPEN = 280;

// Milestone strip layout. Time-axis scaling was replaced by index-based
// placement (see flow layout pass). A milestone card is 200px wide; the
// step must be >= that plus a small gap so adjacent nodes never overlap.
// The 2-row y-stagger gives extra breathing room when many events land
// in a short burst.
const MILESTONE_STEP_X = 220;
const MILESTONE_ROW_DY = 32;

// ── persisted view settings ─────────────────────────────────────────────────
//
// Everything below is configurable from the gear panel in the toolbar. The
// defaults here MUST keep the canvas looking identical to the pre-settings
// behaviour, so a user who never touches the panel sees the original layout.
// The whole object is round-tripped through localStorage on every change.
const FLOW_SETTINGS_KEY = 'grok-remote.flow.settings';
const DEFAULT_FLOW_SETTINGS = Object.freeze({
  // Layout
  direction:         'LR',  // dagre rankdir: LR | TB | RL | BT
  rankSpacing:       80,    // dagre ranksep
  nodeSpacing:       30,    // dagre nodesep
  // Display
  showMilestones:    true,
  showStats:         null,  // tri-state: null means "follow built-in default"
  showBgTasks:       true,
  showSubAgents:     true,
  showToolCalls:     true,
  showGroups:        true,
  groupThreshold:    3,     // runLen at or above which we collapse same-kind tools
  // Interaction
  nodesDraggable:    true,
  panOnDrag:         true,
  zoomOnScroll:      true,
  snapToGrid:        false,
  snapGridSize:      15,
  // Animation
  autoFitOnExpand:   true,
  edgeAnimations:    true,
  animationDuration: 250,
  // Advanced (gear panel, new in this patch)
  autoExpandNewNodes: false,           // auto-open tool/sub-agent/bg nodes that ARRIVE after initial mount
  edgeType:           'floating',      // floating | bezier | smoothstep | step | straight
  backgroundPattern:  'dots',          // dots | lines | cross | none
  backgroundGap:      24,              // <Background gap={N}>
  showControls:       true,            // React Flow zoom-in/out/fit buttons
  showMinimap:        false,           // React Flow MiniMap overlay
  connectionMode:     'loose',         // loose | strict (React Flow connectionMode)
  fitViewPadding:     0.15,            // padding applied to all fitView() calls
  maxZoom:            2,                // ReactFlow maxZoom prop
  minZoom:            0.3,              // ReactFlow minZoom prop
});

function loadFlowSettings() {
  try {
    const raw = localStorage.getItem(FLOW_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_FLOW_SETTINGS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_FLOW_SETTINGS };
    return { ...DEFAULT_FLOW_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_FLOW_SETTINGS };
  }
}

function saveFlowSettings(s) {
  try { localStorage.setItem(FLOW_SETTINGS_KEY, JSON.stringify(s)); } catch { /* quota or disabled */ }
}

function clearFlowSettings() {
  try { localStorage.removeItem(FLOW_SETTINGS_KEY); } catch { /* ignore */ }
}

// Backoff schedule for sub-agent child trace retries. Used when the session
// dir hasn't been flushed to disk yet (brand-new bg sub-agents). The
// fetchSubChildren machinery retries on this schedule up to MAX_RETRIES,
// then ticks every LIVE_RETRY_MS for as long as the sub-agent is still
// running. Once it ends, we do the final retries and give up.
const SUB_CHILD_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 32000];
const SUB_CHILD_LIVE_RETRY_MS   = 5000;

// nodeKind + nodeWidth moved to ./flow-helpers.ts

const STATUS_RANK = {
  running: 0, idle: 1, errored: 2, disconnected: 3, exited: 3, killed: 3, unknown: 4,
};

// normaliseStatus moved to ./flow-helpers.ts

// ── custom node renderers ─────────────────────────────────────────────────

function AgentNode({ data }) {
  const status = normaliseStatus(data.status);
  const hist = Array.isArray(data.tokensHistory) ? data.tokensHistory : [];
  const sparkPath = (hist.length >= 2) ? buildSparkPath(hist, 120, 16) : null;
  return (
    <div className={`flow-agent-node flow-agent-node--${status}`} data-depth={data.depth || 0}>
      <Handle type="source" position={Position.Right} className="flow-handle" />
      <Handle type="target" position={Position.Right} className="flow-handle" />
      <Handle type="source" id="sub" position={Position.Left} className="flow-handle" />
      <Handle type="source" id="bg" position={Position.Bottom} className="flow-handle" />
      <div className="flow-agent-node__row">
        <span className={`flow-agent-node__dot flow-agent-node__dot--${status}`} />
        <span className="flow-agent-node__name" title={data.name}>{data.name}</span>
      </div>
      <div className="flow-agent-node__row flow-agent-node__row--meta">
        <span className="flow-agent-node__model" title={data.model}>{data.model || 'no model'}</span>
        <span className={`flow-agent-node__pill flow-agent-node__pill--${status}`}>{status}</span>
      </div>
      <div className="flow-agent-node__row flow-agent-node__row--meta">
        <span className="flow-agent-node__tokens">
          {data.tokens ? `${formatTokens(data.tokens)} tok` : '0 tok'}
        </span>
        {data.inFlight > 0 ? (
          <span className="flow-agent-node__inflight">{data.inFlight} tool{data.inFlight === 1 ? '' : 's'}</span>
        ) : null}
      </div>
      {sparkPath && (
        <svg
          className="flow-agent-node__spark"
          viewBox="0 0 120 16"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d={sparkPath.area} fill="rgba(94, 234, 212, 0.15)" />
          <path d={sparkPath.line} fill="none" stroke="var(--teal)" strokeWidth="1.2" />
        </svg>
      )}
    </div>
  );
}

// buildSparkPath moved to ./flow-helpers.ts

function ToolNode({ data }) {
  const status = (data.status || 'pending').toLowerCase();
  const open = !!data.isOpen;
  const dur = (data.endedAt && data.startedAt) ? (data.endedAt - data.startedAt) : null;
  const liveDur = (!data.endedAt && data.startedAt) ? (Date.now() - data.startedAt) : null;
  const showDur = dur != null ? fmtDuration(dur) : (liveDur != null ? `${fmtDuration(liveDur)}...` : '');
  const outputText = Array.isArray(data.content) ? data.content.map(c => c.text).join('\n').trim() : '';
  const hasOutput = !!outputText;
  const hasInput  = data.rawInput && Object.keys(data.rawInput).length > 0;

  return (
    <div className={`flow-tool-node flow-tool-node--${status} ${open ? 'flow-tool-node--open' : ''}`}>
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <Handle type="source" position={Position.Left} className="flow-handle" />
      <button
        type="button"
        className="flow-tool-node__head"
        onClick={(e) => { e.stopPropagation(); if (data.onToggle) data.onToggle(); }}
        title={data.label}
      >
        <span className="flow-tool-node__kind">{data.kind || 'tool'}</span>
        <span className="flow-tool-node__label">{data.label || ''}</span>
        <span className="flow-tool-node__meta">
          {showDur && <span className="flow-tool-node__dur">{showDur}</span>}
          <span className={`flow-tool-node__status flow-tool-node__status--${status}`}>{data.status || 'pending'}</span>
        </span>
      </button>
      {open && (
        <div className="flow-tool-node__body">
          {Array.isArray(data.locations) && data.locations.length > 0 && (
            <div className="flow-tool-node__section">
              <div className="flow-tool-node__section-title">locations</div>
              <ul className="flow-tool-node__locs">
                {data.locations.map((l, i) => (
                  <li key={i}>{(l && (l.path || l.uri || l.file)) || JSON.stringify(l)}</li>
                ))}
              </ul>
            </div>
          )}
          {hasInput && (
            <div className="flow-tool-node__section">
              <div className="flow-tool-node__section-title">input</div>
              <pre className="flow-tool-node__pre">{safeStringify(data.rawInput)}</pre>
            </div>
          )}
          {hasOutput && (
            <div className="flow-tool-node__section">
              <div className="flow-tool-node__section-title">output</div>
              <pre className="flow-tool-node__pre">{outputText}</pre>
            </div>
          )}
          {data.rawOutput != null && (
            <div className="flow-tool-node__section">
              <div className="flow-tool-node__section-title">rawOutput</div>
              <pre className="flow-tool-node__pre">{safeStringify(data.rawOutput)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Collapsed N-of-a-kind summary. Clicking toggles expansion; expansion
// itself is owned by the parent FlowInner because nodes need to be added
// and re-laid-out, not just visibility-toggled inside the node.
function GroupNode({ data }) {
  const totalMs = data.totalMs || 0;
  const avgMs   = data.count ? Math.round(totalMs / data.count) : 0;
  const hasFailed = data.failedCount > 0;
  return (
    <div
      className={`flow-group-node${data.expanded ? ' flow-group-node--open' : ''}${hasFailed ? ' flow-group-node--has-fail' : ''}`}
      onClick={() => { if (data.onToggle) data.onToggle(); }}
      title={`${data.count} ${data.kind} calls. click to ${data.expanded ? 'collapse' : 'expand'}`}
    >
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <Handle type="source" position={Position.Left} className="flow-handle" />
      <div className="flow-group-node__head">
        <span className="flow-group-node__kind">{(data.kind || 'tool').toUpperCase()}</span>
        <span className="flow-group-node__times">x {data.count}</span>
        <span className="flow-group-node__chev">{data.expanded ? 'v' : '>'}</span>
      </div>
      <div className="flow-group-node__sub">
        {fmtDuration(totalMs)} total{avgMs ? `, avg ${fmtDuration(avgMs)}` : ''}
        {hasFailed ? ` . ${data.failedCount} failed` : ''}
      </div>
    </div>
  );
}

// Long-running shell launched via grok task_backgrounded. One node per
// active bg task, stacked below the agent node. Pulsing amber dot, command
// preview, optional dev-server URL, and exit status when completed.
function BgTaskNode({ data }) {
  const exited = !!data.exited;
  const elapsed = data.startedAt
    ? (exited && data.endedAt ? data.endedAt - data.startedAt : Date.now() - data.startedAt)
    : 0;
  const cmdShort = (data.command || '').length > 64
    ? (data.command || '').slice(0, 61) + '...'
    : (data.command || '(no command)');
  const code = data.exitStatus && (data.exitStatus.exitCode != null ? data.exitStatus.exitCode : data.exitStatus.signal);
  return (
    <div className={`flow-bg-node${exited ? ' flow-bg-node--exited' : ''}`}>
      <Handle type="target" id="bg" position={Position.Top} className="flow-handle" />
      <div className="flow-bg-node__head">
        <span className={`flow-bg-node__dot${exited ? ' flow-bg-node__dot--exited' : ''}`} />
        <span className="flow-bg-node__kind">{exited ? 'bg done' : 'bg shell'}</span>
        <span className="flow-bg-node__elapsed" title={`started ${new Date(data.startedAt || 0).toLocaleTimeString()}`}>
          {elapsed > 0 ? fmtDuration(elapsed) : ''}
        </span>
      </div>
      <div className="flow-bg-node__cmd" title={data.command || ''}>{cmdShort}</div>
      <div className="flow-bg-node__meta">
        {data.url ? (
          <a
            className="flow-bg-node__url"
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={`open ${data.url}`}
          >open {data.url.replace(/^https?:\/\//, '')}</a>
        ) : (exited ? (
          <span className="flow-bg-node__exit">
            exit {code != null ? code : '?'}
          </span>
        ) : (
          <span className="flow-bg-node__pending">no URL yet</span>
        ))}
      </div>
    </div>
  );
}

// Horizontal milestone strip lives at the top of the canvas. One node per
// significant event (turn boundary, bg start/stop, URL bound). The strip is
// laid out left-to-right by timestamp.
function MilestoneNode({ data }) {
  const ts = data.t ? new Date(data.t).toLocaleTimeString([], { hour12: false }) : '';
  return (
    <div className={`flow-milestone-node flow-milestone-node--${data.kind}`} title={`${data.label}\n${ts}`}>
      <div className="flow-milestone-node__icon">{data.icon || 'o'}</div>
      <div className="flow-milestone-node__label">{data.label}</div>
      <div className="flow-milestone-node__time">{ts}</div>
      <div className="flow-milestone-node__tail" />
    </div>
  );
}

// Smaller card hanging off the LEFT of the main agent. Visualizes a
// sub-agent (grok's built-in Agent tool, e.g. Agent(explore)). Connection:
// edge from parent's left handle to this node's right handle.
function SubAgentNode({ data }) {
  const status = (data.status || 'pending').toLowerCase();
  const open = !!data.isOpen;
  const dur = (data.endedAt && data.startedAt) ? (data.endedAt - data.startedAt) : null;
  const liveDur = (!data.endedAt && data.startedAt) ? (Date.now() - data.startedAt) : null;
  const showDur = dur != null ? fmtDuration(dur) : (liveDur != null ? `${fmtDuration(liveDur)}...` : '');
  const promptText = typeof data.prompt === 'string'
    ? data.prompt
    : (data.prompt ? safeStringify(data.prompt) : '');
  // Prefer the rich SubagentCompleted rawOutput.output as the canonical final
  // response (it's the actual subagent message). Fall back to the streamed
  // content blocks if rawOutput hasn't arrived yet.
  const ro = data.rawOutput;
  const isSubagentFinal = ro && ro.type === 'SubagentCompleted';
  const finalOutput = isSubagentFinal && typeof ro.output === 'string' ? ro.output.trim() : '';
  const streamedText = Array.isArray(data.response)
    ? data.response.map(c => c.text).join('\n').trim()
    : (typeof data.response === 'string' ? data.response : '');
  const responseText = finalOutput || streamedText;
  // Snippet for the closed card: first non-empty line, capped.
  const snippet = (() => {
    const t = responseText || '';
    if (!t) return '';
    const firstLine = t.split('\n').find(l => l.trim()) || '';
    return firstLine.length > 90 ? firstLine.slice(0, 87) + '...' : firstLine;
  })();

  return (
    <div
      className={`flow-subagent-node flow-subagent-node--${status} ${open ? 'flow-subagent-node--open' : ''}`}
      data-depth={data.depth || 1}
    >
      <Handle type="target" position={Position.Right} className="flow-handle" />
      <Handle type="source" position={Position.Right} className="flow-handle" />
      {/* Left handle: source for edges to child tool-call nodes that hang
          off this sub-agent's left side when expanded. */}
      <Handle type="source" id="children" position={Position.Left} className="flow-handle" />
      <div className="flow-subagent-node__crumb" title={`parent: ${data.parentName || ''}`}>
        parent: <span className="flow-subagent-node__crumb-name">{data.parentName || 'agent'}</span>
      </div>
      <button
        type="button"
        className="flow-subagent-node__head"
        onClick={(e) => { e.stopPropagation(); if (data.onToggle) data.onToggle(); }}
        title={data.label}
      >
        <span className="flow-subagent-node__pill">SUB-AGENT</span>
        <span className="flow-subagent-node__label">{data.label || '(unnamed)'}</span>
      </button>
      <div className="flow-subagent-node__row">
        <span className={`flow-subagent-node__status flow-subagent-node__status--${status}`}>
          {data.status || 'pending'}
        </span>
        {showDur && <span className="flow-subagent-node__dur">{showDur}</span>}
        {data.childStatus === 'loading' && (
          <span className="flow-subagent-node__childinfo" title="fetching child trace">
            loading child events...
          </span>
        )}
        {data.childStatus === 'loaded' && typeof data.childCount === 'number' && data.childCount > 0 && (
          <span className="flow-subagent-node__childinfo" title="child tool calls fetched">
            {data.childCount} child call{data.childCount === 1 ? '' : 's'}
          </span>
        )}
        {data.childStatus === 'error' && (
          <span
            className="flow-subagent-node__childinfo flow-subagent-node__childinfo--err"
            title={data.childError || 'failed to load child trace'}
          >
            child trace failed
          </span>
        )}
      </div>
      {snippet && (
        <div className="flow-subagent-node__snippet" title={responseText}>
          {snippet}
        </div>
      )}
      {open && (
        <div className="flow-subagent-node__body">
          {promptText && (
            <div className="flow-subagent-node__section">
              <div className="flow-subagent-node__section-title">prompt</div>
              <pre className="flow-subagent-node__pre">{promptText}</pre>
            </div>
          )}
          {responseText && (
            <div className="flow-subagent-node__section">
              <div className="flow-subagent-node__section-title">{isSubagentFinal ? 'final output' : 'response'}</div>
              <pre className="flow-subagent-node__pre">{responseText}</pre>
            </div>
          )}
          {isSubagentFinal && (
            <div className="flow-subagent-node__section">
              <div className="flow-subagent-node__section-title">stats</div>
              <div className="flow-subagent-node__stats">
                {typeof ro.tool_calls === 'number' && <span>{ro.tool_calls} tool call{ro.tool_calls === 1 ? '' : 's'}</span>}
                {typeof ro.turns === 'number' && <span>{ro.turns} turn{ro.turns === 1 ? '' : 's'}</span>}
                {typeof ro.duration_ms === 'number' && <span>{fmtDuration(ro.duration_ms)}</span>}
                {typeof ro.subagent_type === 'string' && <span>{ro.subagent_type}</span>}
              </div>
              {typeof ro.subagent_id === 'string' && (
                <div className="flow-subagent-node__id" title={ro.subagent_id}>
                  id: {ro.subagent_id.slice(0, 18)}...
                </div>
              )}
            </div>
          )}
          {!promptText && !responseText && (
            <div className="flow-subagent-node__section flow-subagent-node__section--empty">
              no payload yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// safeStringify moved to ./flow-helpers.ts

const NODE_TYPES = {
  agent: AgentNode,
  tool: ToolNode,
  group: GroupNode,
  bgTask: BgTaskNode,
  milestone: MilestoneNode,
  subAgent: SubAgentNode,
};

// Custom edge registry. The 'floating' type is the new default: it anchors
// each edge endpoint to the closest point on each node's bounding rect (see
// flow-floating-edge.js). React Flow's built-in 'bezier', 'smoothstep',
// 'step', 'straight' types are registered automatically by ReactFlow so we
// don't need to list them here; only our custom type lives in this map.
const EDGE_TYPES = {
  floating: FloatingEdge,
};

// ── helpers ───────────────────────────────────────────────────────────────

// formatTokens moved to ./flow-helpers.ts

// Cap how many bg-task cards we draw per agent. Running first, then a few
// most-recent exited. The dagre layout still fans these out as siblings.
const BG_NODES_VISIBLE = 3;

// Build a stub list of agent nodes (positions are filled in by the dagre
// layout pass in FlowInner's useMemo).
function layoutAgents(agents) {
  return agents.map((a) => ({
    id: `agent:${a.id}`,
    type: 'agent',
    // x/y are placeholders; the dagre layout in FlowInner's useMemo
    // overwrites them with the final node positions.
    position: { x: 0, y: 0 },
    draggable: true,
    data: {
      agentId: a.id,
      name:    a.name || a.id.slice(0, 8),
      model:   a.model || '',
      status:  a.status || 'idle',
      // cwd lets the sub-agent direct-updates endpoint look up the child's
      // session dir without scanning. Required for the fast-path retry loop.
      cwd:     a.cwd || '',
      tokens:  0,
      inFlight: 0,
    },
  }));
}

// groupToolCalls moved to ./flow-helpers.ts (imported above).

// ── event dispatcher (pure) ───────────────────────────────────────────────
//
// applyAgentEventToState takes a state slot for one agent + an SSE event
// (name + payload) and returns the new slot. Pure so we can use it for both
// live SSE events (via patchAgent's updater form) and bulk history replay
// (composed in a tight loop, then committed with one setAgentState).
//
// `opts.at` is the event's wall-clock timestamp in ms (Date.parse(ev.at) for
// history, Date.now() for live). `opts.fromHistory` lets the dispatcher
// suppress live-only effects later if we ever need to.
function applyAgentEventToState(cur, name, payload, opts) {
  const at = (opts && Number.isFinite(opts.at)) ? opts.at : Date.now();

  // Token bump shared by every event that may carry _meta.totalTokens.
  const bumpTokensInto = (state, data) => {
    const t = data && data._meta && Number(data._meta.totalTokens);
    if (!Number.isFinite(t) || t <= 0) return state;
    if (t <= (state.tokens || 0)) return state; // monotone; skip duplicates
    const hist = Array.isArray(state.tokensHistory) ? state.tokensHistory.slice() : [];
    hist.push({ t: at, v: t });
    if (hist.length > TOKEN_HISTORY_MAX) hist.splice(0, hist.length - TOKEN_HISTORY_MAX);
    return { ...state, tokens: t, tokensHistory: hist, lastActivityAt: at };
  };

  switch (name) {
    case 'agent_status': {
      if (!payload) return cur;
      const status = normaliseStatus(payload.status || payload.state);
      return { ...cur, status, lastActivityAt: at };
    }

    case 'tool_call': {
      if (!payload) return cur;
      let next = bumpTokensInto(cur, payload);
      const u = (payload.update && typeof payload.update === 'object') ? payload.update : payload;
      const id = u.toolCallId || u.id || `tc-${at}-${Math.random()}`;
      const kind = (payload._meta && payload._meta.updateParams && payload._meta.updateParams.kind)
                || u.kind || '';
      const label = isSubAgentCall(u) ? pickSubAgentLabel(u) : pickToolLabel(u);
      const status = (payload._meta && payload._meta.updateParams && payload._meta.updateParams.status)
                  || u.status || 'Pending';

      if (isSubAgentCall(u)) {
        const prompt = (u.rawInput && (u.rawInput.prompt || u.rawInput.task || u.rawInput.input)) || null;
        const prevSubs = Array.isArray(next.subAgents) ? next.subAgents : [];
        const turn = (next.turn || 0) + (next._turnHasMilestone ? 0 : 1);
        const firstThisTurn = !prevSubs.some(s => s._turnSpawn === turn);
        let subAgents;
        if (prevSubs.some(s => s.id === id)) {
          subAgents = prevSubs;
        } else {
          subAgents = prevSubs.concat([{
            id,
            kind,
            label,
            parentToolCallId: id,
            status,
            prompt,
            response: [],
            toolCalls: [],
            rawInput: u.rawInput || null,
            startedAt: at,
            endedAt: null,
            _turnSpawn: turn,
          }]);
        }
        let ms = (next.milestones || []).slice();
        // Roll up sub-agent spawns into a single per-turn milestone with a
        // running count instead of one-per-child (which floods the strip
        // when an agent fan-outs to 5+ sub-agents in a single turn).
        const spawnIdx = ms.findIndex(m => m.kind === 'sub-agent-spawn' && m._turn === turn);
        if (spawnIdx < 0) {
          ms.push({
            kind: 'sub-agent-spawn',
            icon: 'S',
            label: `turn ${turn}: 1 sub-agent spawned`,
            t: at,
            _turn: turn,
            _count: 1,
          });
        } else {
          const prev = ms[spawnIdx];
          const count = (prev._count || 1) + 1;
          ms[spawnIdx] = {
            ...prev,
            label: `turn ${turn}: ${count} sub-agents spawned`,
            _count: count,
            t: prev.t, // keep the original spawn time for chronological order
          };
        }
        if (ms.length > MILESTONE_CAP) ms = ms.slice(ms.length - MILESTONE_CAP);
        next = { ...next, status: 'running', subAgents, milestones: ms, lastActivityAt: at };
        if (!next._turnHasMilestone) {
          const nTurn = (next.turn || 0) + 1;
          const ms2 = (next.milestones || []).slice();
          ms2.push({ kind: 'turn', icon: 'T', label: `turn ${nTurn}`, t: at });
          if (ms2.length > MILESTONE_CAP) ms2.splice(0, ms2.length - MILESTONE_CAP);
          next = { ...next, turn: nTurn, milestones: ms2, _turnHasMilestone: true };
        }
        return next;
      }

      const calls = { ...next.calls, [id]: {
        id,
        kind,
        label,
        status,
        rawInput: u.rawInput || null,
        rawOutput: u.rawOutput || null,
        content: extractToolContent(u.content),
        locations: Array.isArray(u.locations) ? u.locations.slice() : [],
        startedAt: at,
        endedAt: null,
      } };
      const inflight = countActive(calls);
      const peak = Math.max(next.peakInFlight || 0, inflight);
      next = { ...next, status: 'running', inFlight: inflight, peakInFlight: peak, calls, lastActivityAt: at };
      if (!next._turnHasMilestone) {
        const nTurn = (next.turn || 0) + 1;
        const ms2 = (next.milestones || []).slice();
        ms2.push({ kind: 'turn', icon: 'T', label: `turn ${nTurn}`, t: at });
        if (ms2.length > MILESTONE_CAP) ms2.splice(0, ms2.length - MILESTONE_CAP);
        next = { ...next, turn: nTurn, milestones: ms2, _turnHasMilestone: true };
      }
      return next;
    }

    case 'tool_call_update': {
      if (!payload) return cur;
      let next = bumpTokensInto(cur, payload);
      const u = (payload.update && typeof payload.update === 'object') ? payload.update : payload;
      const id = u.toolCallId || u.id;
      if (!id) return next;
      const status = (payload._meta && payload._meta.updateParams && payload._meta.updateParams.status)
                  || u.status || 'Running';
      const done = (status === 'Completed' || status === 'Failed' || status === 'canceled');

      const subs = Array.isArray(next.subAgents) ? next.subAgents : [];
      const subIdx = subs.findIndex(s => s.id === id);
      const isSubKind = isSubAgentCall(u);
      if (subIdx >= 0 || isSubKind) {
        if (subIdx < 0) {
          const prompt = (u.rawInput && (u.rawInput.prompt || u.rawInput.task || u.rawInput.input)) || null;
          const newSub = {
            id,
            kind: u.kind || '',
            label: pickSubAgentLabel(u),
            parentToolCallId: id,
            status,
            prompt,
            response: u.content ? extractToolContent(u.content) : [],
            rawOutput: u.rawOutput || null,
            toolCalls: [],
            rawInput: u.rawInput || null,
            startedAt: at,
            endedAt: done ? at : null,
            _turnSpawn: next.turn || 1,
          };
          return { ...next, subAgents: subs.concat([newSub]), lastActivityAt: at };
        }
        const prev = subs[subIdx];
        const newContent = u.content
          ? mergeToolContent(prev.response, extractToolContent(u.content))
          : prev.response;
        // Two completion regimes:
        //  - run_in_background=true: spawn_subagent fires-and-forgets, and the
        //    tool's own Completed status means "we've handed the work off."
        //    We treat that as the sub-agent's terminal state (we won't see a
        //    SubagentCompleted for these).
        //  - run_in_background=false (inline): spawn_subagent's Completed
        //    arrives with the SubagentCompleted rawOutput. We must wait for
        //    that payload before flipping to "completed", otherwise the bare
        //    Completed-ack would prematurely close the card while the child
        //    is still running.
        const ro = u.rawOutput || null;
        const isSubagentFinal = ro && ro.type === 'SubagentCompleted';
        const isHardTerminal = (status === 'Failed' || status === 'canceled');
        // Did the user request background mode? Check current rawInput (or
        // fall back to the prior copy if this update omits it).
        const effRawInput = (u.rawInput && typeof u.rawInput === 'object') ? u.rawInput : prev.rawInput;
        const isBg = !!(effRawInput && effRawInput.run_in_background);
        const reallyDone = isSubagentFinal
          || isHardTerminal
          || (status === 'Completed' && isBg);
        const effectiveStatus = (status === 'Completed' && !isSubagentFinal && !isBg && !prev.endedAt)
          ? 'Running' : status;
        let ms = (next.milestones || []).slice();
        if (reallyDone && !prev.endedAt) {
          // Roll up sub-agent completions per-turn (same approach as the
          // spawn rollup above). Failed runs get their own kind so they
          // stand out instead of being lumped with successes.
          const isFail = (status === 'Failed' || status === 'canceled');
          const turn = prev._turnSpawn || (next.turn || 1);
          const kindForRollup = isFail ? 'sub-agent-fail' : 'sub-agent-end';
          const idx = ms.findIndex(m => m.kind === kindForRollup && m._turn === turn);
          if (idx < 0) {
            ms.push({
              kind: kindForRollup,
              icon: 'S',
              label: isFail
                ? `turn ${turn}: 1 sub-agent failed`
                : `turn ${turn}: 1 sub-agent done`,
              t: at,
              _turn: turn,
              _count: 1,
            });
          } else {
            const prevMs = ms[idx];
            const count = (prevMs._count || 1) + 1;
            ms[idx] = {
              ...prevMs,
              label: isFail
                ? `turn ${turn}: ${count} sub-agents failed`
                : `turn ${turn}: ${count} sub-agents done`,
              _count: count,
              t: at,
            };
          }
          if (ms.length > MILESTONE_CAP) ms = ms.slice(ms.length - MILESTONE_CAP);
        }
        const merged = {
          ...prev,
          kind: u.kind || prev.kind,
          label: pickSubAgentLabel(u) || prev.label,
          status: effectiveStatus,
          rawInput: (u.rawInput != null) ? u.rawInput : prev.rawInput,
          rawOutput: ro || prev.rawOutput || null,
          response: newContent,
          endedAt: reallyDone ? (prev.endedAt || at) : prev.endedAt,
        };
        const nextSubs = subs.slice();
        nextSubs[subIdx] = merged;
        return { ...next, subAgents: nextSubs, milestones: ms, lastActivityAt: at };
      }

      const prev = next.calls && next.calls[id] ? next.calls[id] : {
        id,
        kind: u.kind || '',
        label: pickToolLabel(u),
        status: 'Pending',
        rawInput: null,
        rawOutput: null,
        content: [],
        locations: [],
        startedAt: at,
        endedAt: null,
      };
      const nextContent = u.content
        ? mergeToolContent(prev.content, extractToolContent(u.content))
        : prev.content;
      const merged = {
        ...prev,
        kind: u.kind || prev.kind,
        label: pickToolLabel(u) || prev.label,
        status,
        rawInput: (u.rawInput != null) ? u.rawInput : prev.rawInput,
        rawOutput: (u.rawOutput != null) ? u.rawOutput : prev.rawOutput,
        content: nextContent,
        locations: Array.isArray(u.locations) && u.locations.length ? u.locations.slice() : prev.locations,
        endedAt: done ? (prev.endedAt || at) : prev.endedAt,
      };
      const calls = { ...(next.calls || {}), [id]: merged };
      return { ...next, inFlight: countActive(calls), calls, lastActivityAt: at };
    }

    case 'agent_message_chunk': {
      if (!payload) return cur;
      let next = bumpTokensInto(cur, payload);
      next = { ...next, status: next.status === 'errored' ? next.status : 'running', lastActivityAt: at };
      return next;
    }

    case 'agent_thought_chunk': {
      if (!payload) return cur;
      return bumpTokensInto(cur, payload);
    }

    case 'user_message_chunk': {
      if (!payload) return cur;
      return { ...cur, lastUserAt: at, lastActivityAt: at };
    }

    case 'prompt_complete': {
      let next = bumpTokensInto(cur, payload || {});
      const turn = next.turn || 0;
      let ms = (next.milestones || []).slice();
      if (turn > 0) {
        ms.push({ kind: 'turn-end', icon: 'D', label: `turn ${turn} done`, t: at });
        if (ms.length > MILESTONE_CAP) ms = ms.slice(ms.length - MILESTONE_CAP);
      }
      return { ...next, status: 'idle', milestones: ms, _turnHasMilestone: false, lastActivityAt: at };
    }

    case 'task_backgrounded':
    case 'x.ai/task_backgrounded': {
      const u = (payload && payload.update) || (payload && payload.params && payload.params.update) || payload;
      if (!u) return cur;
      const cmd = u.command || u.cmd || '';
      const ms = (cur.milestones || []).slice();
      const last = ms[ms.length - 1];
      const m = { kind: 'bg-start', icon: 'U', label: `started ${truncCmd(cmd)}`, t: at };
      if (last && last.kind === m.kind && last.label === m.label && (m.t - last.t) < 1000) return cur;
      ms.push(m);
      if (ms.length > MILESTONE_CAP) ms.splice(0, ms.length - MILESTONE_CAP);
      return { ...cur, milestones: ms, lastActivityAt: at };
    }

    case 'task_completed':
    case 'x.ai/task_completed': {
      const u = (payload && payload.update) || (payload && payload.params && payload.params.update) || payload;
      if (!u) return cur;
      const snap = u.task_snapshot || {};
      const cmd = snap.command || u.command || '';
      const ms = (cur.milestones || []).slice();
      const last = ms[ms.length - 1];
      const m = { kind: 'bg-end', icon: 'V', label: `finished ${truncCmd(cmd)}`, t: at };
      if (last && last.kind === m.kind && last.label === m.label && (m.t - last.t) < 1000) return cur;
      ms.push(m);
      if (ms.length > MILESTONE_CAP) ms.splice(0, ms.length - MILESTONE_CAP);
      return { ...cur, milestones: ms, lastActivityAt: at };
    }

    default:
      return cur;
  }
}

// Build an empty state slot, hydrating tokensHistory from sessionStorage so
// the sparkline survives reloads even before replay finishes.
function freshAgentState(id) {
  const persisted = loadTokenHistory(id);
  const lastTok = persisted.length ? persisted[persisted.length - 1].v : 0;
  return {
    status: 'idle',
    tokens: lastTok,
    inFlight: 0,
    peakInFlight: 0,
    calls: {},
    tokensHistory: persisted,
    bgTerminals: [],
    milestones: [],
    turn: 0,
    lastActivityAt: 0,
    lastUserAt: 0,
  };
}

// ── main app ──────────────────────────────────────────────────────────────

// `filterIds` (optional) limits the canvas to a fixed set of agent ids.
// When set we also drop the "show archived" toggle and the polling-driven
// list mutation: the canvas is scoped to exactly that conversation.
function FlowInner({ filterIds = null }) {
  const hasFilter = Array.isArray(filterIds) && filterIds.length > 0;
  const [showAll, setShowAll] = useState(false);
  const scoped = hasFilter && !showAll;

  const [agents, setAgents]               = useState([]);
  const [showArchived, setShowArchived]   = useState(false);
  const [agentState, setAgentState]       = useState({}); // id -> { status, tokens, inFlight, calls, bgTerminals, milestones, turn }
  const [expandedGroups, setExpandedGroups] = useState({}); // `${agentId}:${groupKey}` -> bool
  // Lifted "open" state for tool / sub-agent / bg-task cards. Keyed by the
  // node id so the parent useMemo pass can adjust the layout to make room
  // for an expanded body. Bumped via toggleNode(nodeId).
  const [expandedNodes, setExpandedNodes] = useState(() => new Set());
  // Positions overwritten by the user dragging nodes. Cleared by the
  // "reset layout" toolbar button. The useMemo layout pass keeps any node
  // id present in this map at its dragged x/y; auto-layout wins for
  // everything else.
  const [userPositions, setUserPositions] = useState({}); // nodeId -> {x, y}
  // Persisted view settings (gear panel). Loaded once from localStorage on
  // mount; every mutation writes the whole object back. See
  // DEFAULT_FLOW_SETTINGS at the top of the file for the schema + defaults.
  const [settings, setSettings] = useState(() => loadFlowSettings());
  // The settings panel's open/closed state is intentionally NOT persisted:
  // the panel is a transient affordance, like the stats panel.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // statsOpen mirrors settings.showStats when the user has explicitly toggled
  // it via the gear panel, otherwise falls back to the "open in scoped view"
  // default. Updates flow both ways: toolbar button + settings checkbox.
  const initialStatsOpen = (settings.showStats == null) ? hasFilter : !!settings.showStats;
  const [statsOpen, setStatsOpen]         = useState(initialStatsOpen);
  const [tick, setTick]                   = useState(0); // forces re-render of live durations
  // Per-sub-agent child trace state. Keyed by `${agentId}:${subId}`. Value is
  // { status: 'loading'|'loaded'|'error', calls: [...], error?: string,
  //   fetchedAt: number, sessionId: string }. Lazy-populated on first
  // sub-agent expand; cached until the user hits the per-card refresh
  // button (not yet wired) or reloads the page.
  const [subagentChildren, setSubagentChildren] = useState({});
  const { fitView } = useReactFlow();

  // dagre layout cache. Layout is recomputed only when the structural
  // signature (node ids + open flags + edge endpoints) changes. The
  // useMemo below re-runs every second to refresh live durations, but
  // structural changes are rare; this cache keeps the dagre call from
  // dominating the render budget on large graphs.
  //   { sig: string, positions: Map<nodeId, {x,y}>, minY: number,
  //     agentTopY: Map<agentId, number> }
  const layoutCacheRef = useRef(null);

  // Mutable refs that survive re-renders without re-subscribing effects.
  const streamsRef    = useRef(new Map()); // id -> EventSource
  const replayedRef   = useRef(new Set()); // agent ids whose history we already replayed
  const pollTimerRef  = useRef(null);
  const bgPollTimerRef = useRef(null);
  // Stash latest expandedNodes so the post-toggle fitView effect can read
  // the "size change" signal without re-running on every other piece of
  // state. Updated in toggleNode.
  const expandFitTimerRef = useRef(null);
  // Keys of sub-agent child fetches currently in flight. Prevents a second
  // request from being kicked off while the first hasn't resolved (e.g.
  // user rapidly toggling the same sub-agent open/closed/open).
  const subChildInFlightRef = useRef(new Set());
  // Per-key retry state for sub-agent child fetches. We use staged backoff
  // when the session dir hasn't been flushed yet, then once the sub-agent
  // is marked done we do the final retries and stop.
  //   key -> { attempts, sessionId, cwd, timer, stopped }
  const subChildRetryRef = useRef(new Map());
  // Latest agentState mirror so polling retry callbacks can decide whether
  // the sub-agent is still running (keep retrying every 5s) or done (a few
  // final retries then give up).
  const agentStateRef = useRef({});
  useEffect(() => { agentStateRef.current = agentState; }, [agentState]);

  // Mirror the latest settings into a ref so closures (fitView callbacks,
  // event handlers wired through useCallback) can read the current
  // animationDuration without being recreated on every settings change.
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Helper used by every settings control. Patches the settings object and
  // mirrors it to localStorage in one shot. Accepts either a partial object
  // or an updater function.
  const updateSettings = useCallback((patch) => {
    setSettings((cur) => {
      const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
      saveFlowSettings(next);
      return next;
    });
  }, []);

  // Reset every setting to its default + clear the localStorage key so the
  // next mount picks up defaults from scratch.
  const resetSettings = useCallback(() => {
    clearFlowSettings();
    setSettings({ ...DEFAULT_FLOW_SETTINGS });
    // Sync the stats panel back to the built-in default (open in scoped
    // view, closed otherwise).
    setStatsOpen(hasFilter);
  }, [hasFilter]);

  // Keep settings.showStats in sync when the user clicks the toolbar
  // "stats" button. Avoids the panel and the toolbar drifting apart.
  const toggleStats = useCallback(() => {
    setStatsOpen((v) => {
      const next = !v;
      updateSettings({ showStats: next });
      return next;
    });
  }, [updateSettings]);

  // Keep latest values reachable inside polling closures without retriggering.
  const showArchivedRef = useRef(showArchived);
  useEffect(() => { showArchivedRef.current = showArchived; }, [showArchived]);
  const filterIdsRef = useRef(filterIds);
  useEffect(() => { filterIdsRef.current = filterIds; }, [filterIds]);
  const showAllRef = useRef(showAll);
  useEffect(() => { showAllRef.current = showAll; }, [showAll]);
  const agentsRef = useRef(agents);
  useEffect(() => { agentsRef.current = agents; }, [agents]);

  // ── pure helpers that mutate state immutably ───────────────────────────

  const patchAgent = useCallback((id, patch) => {
    setAgentState((prev) => {
      // Hydrate tokensHistory from sessionStorage on first touch so the
      // sparkline survives page reloads + view remounts.
      const cur = prev[id] || freshAgentState(id);
      const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
      // Persist when history grew. Cheap; runs at most ~2/sec per agent.
      if (next.tokensHistory && next.tokensHistory !== cur.tokensHistory) {
        saveTokenHistory(id, next.tokensHistory);
      }
      return { ...prev, [id]: next };
    });
  }, []);

  // ── SSE wiring ─────────────────────────────────────────────────────────

  // Live event dispatcher. Routes one SSE event through the same pure
  // state-mutation helper that history replay uses, so live and replay
  // paths can never diverge.
  const applyAgentEvent = useCallback((agent, name, payload, opts) => {
    patchAgent(agent.id, (cur) => applyAgentEventToState(cur, name, payload, opts || {}));
  }, [patchAgent]);

  // Walks history.jsonl events for an agent, applying each through the same
  // pure dispatcher live events use. Batched into a single setAgentState so
  // React only re-renders once per replay (vs ~thousands of patchAgent calls).
  const replayHistoryFor = useCallback(async (agent) => {
    if (!agent || !agent.id) return;
    if (replayedRef.current.has(agent.id)) return;
    replayedRef.current.add(agent.id);
    let hist;
    try {
      hist = await api.history(agent.id, { all: true });
    } catch {
      // Server error or 404. Allow a future retry by clearing the marker.
      replayedRef.current.delete(agent.id);
      return;
    }
    const events = Array.isArray(hist && hist.events) ? hist.events : [];
    if (!events.length) {
      // Still mark replayed so we don't refetch on every effect tick.
      patchAgent(agent.id, (cur) => ({ ...cur, _replayed: true }));
      return;
    }
    const slice = events.length > HISTORY_REPLAY_MAX
      ? events.slice(events.length - HISTORY_REPLAY_MAX)
      : events;
    setAgentState((prev) => {
      let cur = prev[agent.id] || freshAgentState(agent.id);
      for (const ev of slice) {
        if (!ev || typeof ev !== 'object') continue;
        const at = ev.at ? Date.parse(ev.at) : NaN;
        cur = applyAgentEventToState(cur, ev.event, ev.data, {
          fromHistory: true,
          at: Number.isFinite(at) ? at : Date.now(),
        });
      }
      cur = { ...cur, _replayed: true };
      if (cur.tokensHistory) saveTokenHistory(agent.id, cur.tokensHistory);
      return { ...prev, [agent.id]: cur };
    });
  }, [patchAgent]);

  const openStreamFor = useCallback((agent) => {
    if (streamsRef.current.has(agent.id)) return;
    // Kick off history replay first. Don't await; SSE can open in parallel
    // and any overlap dedups naturally through toolCallId merges + monotone
    // token bumps.
    replayHistoryFor(agent);

    const url = `/api/agents/${encodeURIComponent(agent.id)}/stream`;
    let es;
    try {
      es = new EventSource(url);
    } catch {
      return;
    }
    streamsRef.current.set(agent.id, es);

    const safeParse = (raw) => {
      try { return JSON.parse(raw); } catch { return null; }
    };

    const live = (name) => (ev) => {
      const data = safeParse(ev.data);
      if (data == null && name !== 'prompt_complete') return;
      applyAgentEvent(agent, name, data, {});
    };

    es.addEventListener('agent_status', live('agent_status'));
    es.addEventListener('tool_call', live('tool_call'));
    es.addEventListener('tool_call_update', live('tool_call_update'));
    es.addEventListener('agent_message_chunk', live('agent_message_chunk'));
    es.addEventListener('agent_thought_chunk', live('agent_thought_chunk'));
    es.addEventListener('user_message_chunk', live('user_message_chunk'));
    es.addEventListener('prompt_complete', live('prompt_complete'));
    es.addEventListener('task_backgrounded', live('task_backgrounded'));
    es.addEventListener('x.ai/task_backgrounded', live('x.ai/task_backgrounded'));
    es.addEventListener('task_completed', live('task_completed'));
    es.addEventListener('x.ai/task_completed', live('x.ai/task_completed'));

    es.addEventListener('error', () => {
      // EventSource will reconnect on its own; flag the card meanwhile so
      // the user sees something is off.
      patchAgent(agent.id, (cur) => ({ ...cur, status: cur.status === 'running' ? 'errored' : cur.status }));
    });
  }, [patchAgent, applyAgentEvent, replayHistoryFor]);

  const closeStreamFor = useCallback((id) => {
    const es = streamsRef.current.get(id);
    if (es) {
      try { es.close(); } catch { /* ignore */ }
      streamsRef.current.delete(id);
    }
  }, []);

  // ── bg-terminal polling for the currently-visible agent set ────────────

  useEffect(() => {
    let alive = true;
    const tickOnce = async () => {
      if (document.hidden) return;
      const list = agentsRef.current;
      if (!list || !list.length) return;
      // Poll in parallel; cap concurrency by the visible set anyway.
      await Promise.all(list.map(async (a) => {
        try {
          const res = await api.terminals.list(a.id);
          if (!alive) return;
          const terms = (res && Array.isArray(res.terminals)) ? res.terminals : [];
          // Detect newly-seen URLs and emit a milestone the first time each
          // unique URL appears for the agent.
          patchAgent(a.id, (cur) => {
            const knownUrls = new Set((cur.bgTerminals || []).map(t => t.url).filter(Boolean));
            const ms = (cur.milestones || []).slice();
            for (const t of terms) {
              if (t.url && !knownUrls.has(t.url)) {
                const port = (t.url.match(/:(\d+)/) || [])[1];
                ms.push({
                  kind: 'url',
                  icon: 'W',
                  label: port ? `:${port} bound` : 'URL bound',
                  t: Date.now(),
                });
                knownUrls.add(t.url);
              }
            }
            if (ms.length > MILESTONE_CAP) ms.splice(0, ms.length - MILESTONE_CAP);
            return { ...cur, bgTerminals: terms, milestones: ms };
          });
        } catch { /* keep stale on transient errors */ }
      }));
    };
    tickOnce();
    bgPollTimerRef.current = setInterval(tickOnce, BG_TERMINALS_POLL_MS);
    return () => {
      alive = false;
      if (bgPollTimerRef.current) {
        clearInterval(bgPollTimerRef.current);
        bgPollTimerRef.current = null;
      }
    };
  }, [agents, patchAgent]);

  // Tick once a second so live durations (in-flight tool dur, bg elapsed)
  // refresh without us spamming sessionStorage.
  useEffect(() => {
    const t = setInterval(() => setTick((v) => (v + 1) % 1_000_000), 1000);
    return () => clearInterval(t);
  }, []);

  // ── agent list polling ─────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    try {
      const list = await api.listAgents();
      const arr = Array.isArray(list) ? list : (list && list.agents) || [];
      const fids = filterIdsRef.current;
      const useFilter = Array.isArray(fids) && fids.length > 0 && !showAllRef.current;
      let filtered;
      if (useFilter) {
        const allow = new Set(fids);
        filtered = arr.filter(a => allow.has(a.id));
      } else {
        filtered = showArchivedRef.current ? arr : arr.filter(a => !a.archived);
      }
      setAgents(filtered.sort((a, b) => {
        const sa = STATUS_RANK[normaliseStatus(a.status)] ?? 9;
        const sb = STATUS_RANK[normaliseStatus(b.status)] ?? 9;
        if (sa !== sb) return sa - sb;
        return (a.name || a.id).localeCompare(b.name || b.id);
      }));
    } catch {
      // server might be down briefly; keep the previous view.
    }
  }, []);

  useEffect(() => {
    refresh();
    // SSE push for instant updates. The 5s poll stays as a safety net when
    // the EventSource fails (older server or temporary network loss).
    let sseAlive = false;
    let es;
    try {
      es = new EventSource('/api/agents/stream');
      es.addEventListener('open', () => { sseAlive = true; });
      es.addEventListener('agents_snapshot', () => { refresh(); });
      es.addEventListener('agent_added',   () => { refresh(); });
      es.addEventListener('agent_removed', () => { refresh(); });
      es.addEventListener('agent_updated', () => { refresh(); });
      es.addEventListener('agent_status',  () => { refresh(); });
      es.addEventListener('error', () => { sseAlive = false; });
    } catch { /* fall through to polling */ }
    pollTimerRef.current = setInterval(() => {
      if (document.hidden) return;
      if (sseAlive) return;
      refresh();
    }, LIST_POLL_MS);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
      document.removeEventListener('visibilitychange', onVis);
      if (es) { try { es.close(); } catch { /* ignore */ } }
    };
  }, [refresh]);

  // Re-filter immediately when either toggle changes.
  useEffect(() => { refresh(); }, [showArchived, showAll, refresh]);

  // Open / close streams to mirror the current agent set.
  useEffect(() => {
    const wantIds = new Set(agents.map(a => a.id));
    for (const a of agents) openStreamFor(a);
    for (const existing of Array.from(streamsRef.current.keys())) {
      if (!wantIds.has(existing)) closeStreamFor(existing);
    }
  }, [agents, openStreamFor, closeStreamFor]);

  // Final teardown: close every stream when the component unmounts.
  useEffect(() => {
    const streams = streamsRef.current;
    return () => {
      for (const es of streams.values()) {
        try { es.close(); } catch { /* ignore */ }
      }
      streams.clear();
    };
  }, []);

  // ── group toggle handler (stable across renders) ───────────────────────

  const toggleGroup = useCallback((agentId, groupKey) => {
    setExpandedGroups((prev) => {
      const key = `${agentId}:${groupKey}`;
      const next = { ...prev };
      if (next[key]) delete next[key]; else next[key] = true;
      return next;
    });
    // Defer a small fit so the newly-revealed children stay on screen.
    if (expandFitTimerRef.current) cancelAnimationFrame(expandFitTimerRef.current);
    expandFitTimerRef.current = requestAnimationFrame(() => {
      const s = settingsRef.current || DEFAULT_FLOW_SETTINGS;
      if (!s.autoFitOnExpand) return;
      try { fitView({ padding: (Number.isFinite(s.fitViewPadding) ? s.fitViewPadding : 0.15), duration: s.animationDuration ?? 250 }); } catch { /* ignore */ }
    });
  }, [fitView]);

  // Kick off a child-trace fetch for one sub-agent. Tries the fast direct
  // updates.jsonl endpoint first, falls back to grok-trace, and retries on
  // a staged backoff if both fail (likely cause: session dir hasn't been
  // flushed to disk yet, common for brand-new bg sub-agents).
  //
  // While the sub-agent is still running we keep retrying every
  // SUB_CHILD_LIVE_RETRY_MS ms forever. Once it ends we do up to
  // SUB_CHILD_RETRY_DELAYS_MS.length attempts on backoff, then give up.
  //
  // key: `${agentId}:${subId}` (also matches the layout pass's childKey).
  // sessionId: the sub-agent's grok session id (UUID).
  // cwd: the parent agent's cwd; threaded so the direct endpoint can find
  //      the session dir without scanning.
  const fetchSubChildren = useCallback((key, sessionId, cwd) => {
    if (!sessionId) return;
    if (subChildInFlightRef.current.has(key)) return;

    // Tracks per-key retry state. Created on first call, mutated in place
    // so timers can read live values without re-running the effect.
    let st = subChildRetryRef.current.get(key);
    if (!st) {
      st = { attempts: 0, sessionId, cwd: cwd || '', timer: null, stopped: false };
      subChildRetryRef.current.set(key, st);
    } else {
      st.sessionId = sessionId;
      if (cwd) st.cwd = cwd;
      st.stopped = false;
    }

    setSubagentChildren((prev) => {
      const existing = prev[key];
      if (existing && existing.status === 'loaded' && existing.calls.length > 0) {
        return prev;
      }
      return { ...prev, [key]: { status: 'loading', calls: [], sessionId } };
    });
    subChildInFlightRef.current.add(key);

    // Direct-first fetch. Returns { calls, source } on success or throws.
    const fetchOnce = async () => {
      // 1. Direct read of updates.jsonl. Cheap; works while live.
      try {
        const direct = await api.subagents.updates(sessionId, st.cwd);
        if (direct && Array.isArray(direct.updates)) {
          const calls = extractChildCallsFromTrace({ updates: direct.updates });
          if (calls.length > 0) return { calls, source: 'direct' };
          // Empty: keep going to the trace fallback, then to retries.
        }
      } catch { /* fall through */ }
      // 2. Trace fallback. Slower but is the only path that works once the
      //    session dir has been compacted / cleaned up.
      const data = await api.subagents.trace(sessionId);
      const calls = extractChildCallsFromTrace(data);
      return { calls, source: 'trace' };
    };

    const isStillRunning = () => {
      const [agentId, subId] = key.split(':');
      const slot = agentStateRef.current[agentId];
      if (!slot || !Array.isArray(slot.subAgents)) return false;
      const sub = slot.subAgents.find(s => s.id === subId);
      if (!sub) return false;
      const status = String(sub.status || '').toLowerCase();
      return !sub.endedAt && (status === 'pending' || status === 'running' || status === 'in_progress');
    };

    const scheduleRetry = (errMsg) => {
      st.attempts += 1;
      // While the sub is live, retry forever on the live cadence.
      // Once it ends, retry on staged backoff, then give up.
      const live = isStillRunning();
      let delay;
      if (live) {
        delay = SUB_CHILD_LIVE_RETRY_MS;
      } else if (st.attempts <= SUB_CHILD_RETRY_DELAYS_MS.length) {
        delay = SUB_CHILD_RETRY_DELAYS_MS[st.attempts - 1];
      } else {
        // Gave up. Surface the error.
        setSubagentChildren((prev) => ({
          ...prev,
          [key]: {
            status: 'error',
            calls: (prev[key] && prev[key].calls) || [],
            sessionId,
            error: errMsg || 'fetch failed',
            fetchedAt: Date.now(),
          },
        }));
        st.stopped = true;
        return;
      }
      // Keep the spinner up so the user sees we're still working.
      setSubagentChildren((prev) => ({
        ...prev,
        [key]: {
          status: 'loading',
          calls: (prev[key] && prev[key].calls) || [],
          sessionId,
          retryAttempt: st.attempts,
          retryReason: errMsg || null,
        },
      }));
      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(() => {
        st.timer = null;
        if (st.stopped) return;
        if (subChildInFlightRef.current.has(key)) return;
        subChildInFlightRef.current.add(key);
        run();
      }, delay);
    };

    const run = () => {
      fetchOnce().then(({ calls, source }) => {
        if (calls.length === 0) {
          // Nothing yet. If the sub is still running, retry; otherwise the
          // child genuinely had zero tool calls, which is a valid loaded
          // state.
          if (isStillRunning()) {
            subChildInFlightRef.current.delete(key);
            scheduleRetry('no events yet');
            return;
          }
          setSubagentChildren((prev) => ({
            ...prev,
            [key]: { status: 'loaded', calls: [], sessionId, fetchedAt: Date.now(), source },
          }));
          st.stopped = true;
          subChildInFlightRef.current.delete(key);
          return;
        }
        setSubagentChildren((prev) => ({
          ...prev,
          [key]: { status: 'loaded', calls, sessionId, fetchedAt: Date.now(), source },
        }));
        st.attempts = 0;
        st.stopped = true;
        subChildInFlightRef.current.delete(key);
      }).catch((err) => {
        const msg = (err && err.message) || 'fetch failed';
        subChildInFlightRef.current.delete(key);
        scheduleRetry(msg);
      });
    };

    run();
  }, []);

  // Clean up any pending retry timers on unmount so we don't leak intervals.
  useEffect(() => {
    const map = subChildRetryRef.current;
    return () => {
      for (const st of map.values()) {
        if (st.timer) clearTimeout(st.timer);
        st.stopped = true;
      }
      map.clear();
    };
  }, []);

  // Lifted "open/closed" toggle for the rest of the expandable node types
  // (tool, sub-agent). The parent re-renders, the layout reflows around
  // the newly-tall body, and we fit-view so the user can see it.
  //
  // For sub-agent nodes, opening also kicks off a one-time fetch of the
  // child agent's trace (its own session's tool calls live there).
  const toggleNode = useCallback((nodeId, ctx) => {
    let wasOpen = false;
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) { next.delete(nodeId); wasOpen = true; }
      else next.add(nodeId);
      return next;
    });
    // ctx: { kind: 'subAgent', childKey, sessionId, cwd } -- if present and
    // we just opened the node, lazy-load the child trace.
    if (!wasOpen && ctx && ctx.kind === 'subAgent' && ctx.childKey && ctx.sessionId) {
      fetchSubChildren(ctx.childKey, ctx.sessionId, ctx.cwd || '');
    }
    if (expandFitTimerRef.current) cancelAnimationFrame(expandFitTimerRef.current);
    expandFitTimerRef.current = requestAnimationFrame(() => {
      const s = settingsRef.current || DEFAULT_FLOW_SETTINGS;
      if (!s.autoFitOnExpand) return;
      try { fitView({ padding: (Number.isFinite(s.fitViewPadding) ? s.fitViewPadding : 0.15), duration: s.animationDuration ?? 250 }); } catch { /* ignore */ }
    });
  }, [fitView, fetchSubChildren]);

  // User dragged a node. Remember the new x/y so the next auto-layout pass
  // leaves it where the user dropped it.
  const onNodeDragStop = useCallback((_ev, node) => {
    if (!node || !node.id) return;
    setUserPositions((prev) => ({ ...prev, [node.id]: { x: node.position.x, y: node.position.y } }));
  }, []);

  // Reset every user-overridden position back to the auto-computed layout
  // and re-fit. Used by the "reset layout" toolbar button.
  const resetLayout = useCallback(() => {
    setUserPositions({});
    if (expandFitTimerRef.current) cancelAnimationFrame(expandFitTimerRef.current);
    expandFitTimerRef.current = requestAnimationFrame(() => {
      const s = settingsRef.current || DEFAULT_FLOW_SETTINGS;
      try { fitView({ padding: (Number.isFinite(s.fitViewPadding) ? s.fitViewPadding : 0.2), duration: s.animationDuration ?? 300 }); } catch { /* ignore */ }
    });
  }, [fitView]);

  // ── derive nodes + edges ───────────────────────────────────────────────

  const { nodes, edges } = useMemo(() => {
    // suppress unused-tick lint; the tick is here so the live duration
    // closures recompute every second.
    void tick;
    const focusIds = (hasFilter && showAll) ? new Set(filterIds) : null;
    const agentNodes = layoutAgents(agents).map((n) => {
      const st = agentState[n.data.agentId] || {};
      const isFocus = focusIds ? focusIds.has(n.data.agentId) : false;
      return {
        ...n,
        className: isFocus ? 'flow-node--focus' : undefined,
        data: {
          ...n.data,
          status:   normaliseStatus(st.status || n.data.status),
          tokens:   st.tokens || 0,
          inFlight: st.inFlight || 0,
          tokensHistory: Array.isArray(st.tokensHistory) ? st.tokensHistory : [],
          isFocus,
          depth: 0,
        },
      };
    });

    const auxNodes = [];
    const auxEdges = [];

    // Per-agent buckets of milestone-node ids. Milestones don't go into
    // dagre (they're a chronological strip at the top), but we need to
    // position each agent's strip ABOVE that agent's cluster after dagre
    // tells us where the cluster landed.
    const milestonesByAgent = new Map(); // agentId -> { stripNodes: [{id, m, j}], strip: [...] }

    agentNodes.forEach((agentNode) => {
      const st = agentState[agentNode.data.agentId];
      if (!st) return;

      // --- Sub-agents (hang off the LEFT of the parent) ---
      if (settings.showSubAgents && Array.isArray(st.subAgents) && st.subAgents.length) {
        const subs = st.subAgents
          .slice()
          .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
        subs.forEach((sub) => {
          const subId = `sub:${agentNode.data.agentId}:${sub.id}`;
          const isOpen = expandedNodes.has(subId);
          const status = String(sub.status || 'pending').toLowerCase();
          const running = !sub.endedAt && (status === 'pending' || status === 'running' || status === 'in_progress');
          // Child-trace state lookup. We don't fetch here (that happens
          // in toggleNode on open) -- this is only for the data we pass
          // into the SubAgentNode for its loading badge + the children
          // we render off to the left when expanded.
          const childKey = `${agentNode.data.agentId}:${sub.id}`;
          const childEntry = subagentChildren[childKey];
          const childSessionId = extractSubagentId(sub);
          auxNodes.push({
            id: subId,
            type: 'subAgent',
            position: { x: 0, y: 0 },
            draggable: true,
            selectable: true,
            data: {
              id: sub.id,
              label: sub.label,
              kind: sub.kind,
              status: sub.status,
              prompt: sub.prompt,
              response: sub.response,
              rawOutput: sub.rawOutput || null,
              startedAt: sub.startedAt,
              endedAt: sub.endedAt,
              parentName: agentNode.data.name,
              depth: 1,
              isOpen,
              childStatus: childEntry ? childEntry.status : (childSessionId ? 'idle' : null),
              childCount: childEntry && Array.isArray(childEntry.calls) ? childEntry.calls.length : 0,
              childError: childEntry && childEntry.error ? childEntry.error : null,
              onToggle: () => toggleNode(subId, {
                kind: 'subAgent',
                childKey,
                sessionId: childSessionId,
                cwd: agentNode.data.cwd || '',
              }),
            },
          });
          auxEdges.push({
            id: `edge:${agentNode.id}->${subId}`,
            source: agentNode.id,
            sourceHandle: 'sub',
            target: subId,
            animated: running,
            style: {
              stroke: status === 'failed'
                ? 'var(--red)'
                : (running ? 'var(--blue)' : 'var(--dim)'),
              strokeWidth: 1.4,
              opacity: running ? 1 : 0.7,
              strokeDasharray: running ? '0' : '4 3',
            },
          });

          // --- Child tool calls under an expanded sub-agent ---
          // Skip these when the user toggled off "show tool calls" so the
          // sub-agent card still shows but its tool fan-out vanishes.
          if (settings.showToolCalls && isOpen && childEntry && childEntry.status === 'loaded' && childEntry.calls.length > 0) {
            childEntry.calls.forEach((call) => {
              const childId = `subtool:${agentNode.data.agentId}:${sub.id}:${call.id}`;
              const childOpen = expandedNodes.has(childId);
              const inactive = !!call.endedAt;
              auxNodes.push({
                id: childId,
                type: 'tool',
                position: { x: 0, y: 0 },
                draggable: true,
                selectable: true,
                data: {
                  id: call.id,
                  kind: call.kind,
                  label: call.label,
                  status: call.status,
                  rawInput: call.rawInput,
                  rawOutput: call.rawOutput,
                  content: call.content,
                  locations: call.locations,
                  startedAt: call.startedAt,
                  endedAt: call.endedAt,
                  isOpen: childOpen,
                  onToggle: () => toggleNode(childId),
                  depth: 2,
                },
                style: inactive ? { opacity: 0.85 } : { opacity: 1 },
                className: 'flow-tool-node-wrap flow-tool-node-wrap--subchild',
              });
              auxEdges.push({
                id: `edge:${subId}->${childId}`,
                source: subId,
                sourceHandle: 'children',
                target: childId,
                animated: !call.endedAt,
                style: {
                  stroke: (String(call.status || '').toLowerCase() === 'failed' ? 'var(--red)' : 'var(--blue)'),
                  strokeWidth: 1.1,
                  opacity: call.endedAt ? 0.6 : 1,
                },
              });
            });
          }
        });
      }

      // --- Tool calls + grouping ---
      if (settings.showToolCalls && st.calls && Object.keys(st.calls).length) {
        const sortedCalls = Object.values(st.calls).slice().sort((a, b) => {
          const at = a.startedAt || 0, bt = b.startedAt || 0;
          return at - bt;
        });
        // When showGroups is off, pass Infinity so groupToolCalls keeps
        // every call as an individual entry. Otherwise honour the
        // user-configured threshold (default 3).
        const threshold = settings.showGroups
          ? (Number.isFinite(settings.groupThreshold) && settings.groupThreshold >= 2 ? settings.groupThreshold : 3)
          : Infinity;
        const items = groupToolCalls(sortedCalls, threshold);
        items.forEach((entry) => {
          if (entry.type === 'group') {
            const groupKey = `${entry.kind}@${entry.startedAt}`;
            const expanded = !!expandedGroups[`${agentNode.data.agentId}:${groupKey}`];
            const nodeId = `group:${agentNode.data.agentId}:${groupKey}`;
            auxNodes.push({
              id: nodeId,
              type: 'group',
              position: { x: 0, y: 0 },
              draggable: true,
              selectable: true,
              data: {
                kind: entry.kind,
                count: entry.count,
                totalMs: entry.totalMs,
                failedCount: entry.failedCount,
                expanded,
                onToggle: () => toggleGroup(agentNode.data.agentId, groupKey),
              },
            });
            const groupActive = !entry.endedAt;
            auxEdges.push({
              id: `edge:${agentNode.id}->${nodeId}`,
              source: agentNode.id,
              target: nodeId,
              animated: groupActive,
              style: {
                stroke: entry.failedCount ? 'var(--red)' : (groupActive ? 'var(--teal)' : 'var(--dim)'),
                strokeWidth: 1.4,
                opacity: groupActive ? 1 : 0.7,
              },
            });
            if (expanded) {
              entry.items.forEach((call) => {
                const childId = `tool:${agentNode.data.agentId}:${call.id}`;
                const childOpen = expandedNodes.has(childId);
                const inactive = !!call.endedAt;
                auxNodes.push({
                  id: childId,
                  type: 'tool',
                  position: { x: 0, y: 0 },
                  draggable: true,
                  selectable: true,
                  data: {
                    id: call.id,
                    kind: call.kind,
                    label: call.label,
                    status: call.status,
                    rawInput: call.rawInput,
                    rawOutput: call.rawOutput,
                    content: call.content,
                    locations: call.locations,
                    startedAt: call.startedAt,
                    endedAt: call.endedAt,
                    isOpen: childOpen,
                    onToggle: () => toggleNode(childId),
                  },
                  style: { opacity: inactive ? 0.85 : 1 },
                  className: 'flow-tool-node-wrap flow-tool-node-wrap--grouped',
                });
                auxEdges.push({
                  id: `edge:${nodeId}->${childId}`,
                  source: nodeId,
                  target: childId,
                  animated: !call.endedAt && (call.status === 'Pending' || call.status === 'Running' || call.status === 'in_progress'),
                  style: {
                    stroke: (call.status === 'Failed' ? 'var(--red)' : (call.endedAt ? 'var(--dim)' : 'var(--teal)')),
                    strokeWidth: 1,
                    opacity: call.endedAt ? 0.5 : 0.9,
                  },
                });
              });
            }
          } else {
            const call = entry.call;
            const nodeId = `tool:${agentNode.data.agentId}:${call.id}`;
            const isOpen = expandedNodes.has(nodeId);
            const inactive = !!call.endedAt;
            auxNodes.push({
              id: nodeId,
              type: 'tool',
              position: { x: 0, y: 0 },
              draggable: true,
              selectable: true,
              data: {
                id: call.id,
                kind: call.kind,
                label: call.label,
                status: call.status,
                rawInput: call.rawInput,
                rawOutput: call.rawOutput,
                content: call.content,
                locations: call.locations,
                startedAt: call.startedAt,
                endedAt: call.endedAt,
                isOpen,
                onToggle: () => toggleNode(nodeId),
              },
              style: inactive ? { opacity: 0.85 } : { opacity: 1 },
            });
            auxEdges.push({
              id: `edge:${agentNode.id}->${nodeId}`,
              source: agentNode.id,
              target: nodeId,
              animated: !call.endedAt && (call.status === 'Pending' || call.status === 'Running' || call.status === 'in_progress'),
              style: {
                stroke: (call.status === 'Failed' ? 'var(--red)' : (call.endedAt ? 'var(--dim)' : 'var(--teal)')),
                strokeWidth: 1.2,
                opacity: call.endedAt ? 0.55 : 1,
              },
            });
          }
        });
      }

      // --- Background-task nodes ---
      if (settings.showBgTasks && Array.isArray(st.bgTerminals) && st.bgTerminals.length) {
        // Show running first, then a few most-recent exited.
        const running = st.bgTerminals.filter(t => !t.exited);
        const exited  = st.bgTerminals.filter(t => t.exited);
        const visible = running.concat(exited).slice(0, BG_NODES_VISIBLE);
        visible.forEach((t) => {
          const bgId = `bg:${agentNode.data.agentId}:${t.id}`;
          auxNodes.push({
            id: bgId,
            type: 'bgTask',
            position: { x: 0, y: 0 },
            draggable: true,
            selectable: true,
            data: {
              id: t.id,
              command: t.command || '',
              cwd: t.cwd || '',
              exited: !!t.exited,
              exitStatus: t.exitStatus || null,
              url: t.url || null,
              startedAt: t.startedAt || null,
              endedAt: t.endedAt || null,
            },
          });
          auxEdges.push({
            id: `edge:${agentNode.id}->${bgId}`,
            source: agentNode.id,
            sourceHandle: 'bg',
            target: bgId,
            targetHandle: 'bg',
            animated: !t.exited,
            style: {
              stroke: t.exited ? 'var(--dim)' : 'var(--amber)',
              strokeWidth: 1.2,
              opacity: t.exited ? 0.55 : 0.95,
            },
          });
        });
      }

      // --- Milestone strip (deferred; placed after dagre runs) ---
      if (settings.showMilestones && Array.isArray(st.milestones) && st.milestones.length) {
        const strip = st.milestones
          .slice(-MILESTONE_CAP)
          .slice()
          .sort((a, b) => (a.t || 0) - (b.t || 0));
        milestonesByAgent.set(agentNode.data.agentId, strip);
      }
    });

    // ── dagre auto-layout ───────────────────────────────────────────────
    //
    // We feed every non-milestone node + every edge into a single graph and
    // let dagre arrange them. With rankdir 'LR' the agent ends up at the
    // left of its cluster and tools/sub-agents/bg-tasks fan out to the
    // right. Multiple agents form independent forests (no cross-agent
    // edges) so dagre stacks the clusters automatically.
    //
    // The useMemo above re-runs every second (live-duration tick) but the
    // structural shape of the graph rarely changes. We hash (nodeId, type,
    // open) and edge endpoints into a single string, and reuse the cached
    // layout when nothing structural changed. Dagre is the most expensive
    // step in this render path for graphs with hundreds of nodes.
    const layoutNodes = [...agentNodes, ...auxNodes];
    const sigParts = [];
    for (const n of layoutNodes) {
      const open = !!(n.data && n.data.isOpen) || !!(n.data && n.data.expanded);
      sigParts.push(`${n.id}|${n.type}|${open ? 1 : 0}`);
    }
    for (const e of auxEdges) sigParts.push(`E:${e.source}->${e.target}`);
    // Bust the layout cache whenever a dagre-affecting setting changes.
    sigParts.push(`L:${settings.direction}|${settings.rankSpacing}|${settings.nodeSpacing}`);
    const sig = sigParts.join(',');

    let positions; // Map<nodeId, {x,y}>
    let dagreMinY;
    let agentTopY; // Map<agentId, number>

    const cache = layoutCacheRef.current;
    if (cache && cache.sig === sig) {
      positions  = cache.positions;
      dagreMinY  = cache.minY;
      agentTopY  = cache.agentTopY;
    } else {
      const g = new dagre.graphlib.Graph({ compound: false });
      g.setGraph({
        rankdir: settings.direction || 'LR',
        nodesep: Number.isFinite(settings.nodeSpacing) ? settings.nodeSpacing : 30,
        ranksep: Number.isFinite(settings.rankSpacing) ? settings.rankSpacing : 80,
        marginx: 20,
        marginy: 20,
      });
      g.setDefaultEdgeLabel(() => ({}));

      for (const n of layoutNodes) {
        const open = !!(n.data && n.data.isOpen) || !!(n.data && n.data.expanded);
        const w = nodeWidth(n.type, open);
        const h = nodeKind(n.type, open);
        g.setNode(n.id, { width: w, height: h });
      }
      // Only add edges where both endpoints exist. (Defensive: the build
      // above always pairs nodes + edges, but a future SSE race could leave
      // an orphan; dagre throws on missing endpoints.)
      for (const e of auxEdges) {
        if (g.hasNode(e.source) && g.hasNode(e.target)) {
          g.setEdge(e.source, e.target);
        }
      }
      dagre.layout(g);

      positions = new Map();
      dagreMinY = Infinity;
      agentTopY = new Map();
      for (const n of layoutNodes) {
        const pos = g.node(n.id);
        if (!pos) continue;
        const open = !!(n.data && n.data.isOpen) || !!(n.data && n.data.expanded);
        const w = nodeWidth(n.type, open);
        const h = nodeKind(n.type, open);
        const x = pos.x - w / 2;
        const y = pos.y - h / 2;
        positions.set(n.id, { x, y });
        if (y < dagreMinY) dagreMinY = y;

        // Group nodes by agent id for the milestone-strip placement.
        let aid = null;
        if (n.type === 'agent') aid = n.data && n.data.agentId;
        else {
          // ids look like "sub:<aid>:..", "tool:<aid>:..", "group:<aid>:..",
          // "bg:<aid>:..", "subtool:<aid>:..". Pull the segment between the
          // first and second colon.
          const m = /^[^:]+:([^:]+):/.exec(n.id);
          if (m) aid = m[1];
        }
        if (aid) {
          const prev = agentTopY.get(aid);
          if (prev === undefined || y < prev) agentTopY.set(aid, y);
        }
      }
      if (!Number.isFinite(dagreMinY)) dagreMinY = 0;
      layoutCacheRef.current = { sig, positions, minY: dagreMinY, agentTopY };
    }

    // Apply cached positions to every node (always; the node objects are
    // freshly built on every memo run, but the layout snapshot is reused).
    for (const n of layoutNodes) {
      const p = positions.get(n.id);
      if (p) n.position = { x: p.x, y: p.y };
    }

    // --- Place milestone nodes above the dagre output ---
    // In scoped mode (a single agent) the strip sits at the very top of
    // the canvas. In global mode each agent gets its own strip, anchored
    // above that agent's cluster.
    milestonesByAgent.forEach((strip, agentId) => {
      const stripBaseY = agents.length === 1
        ? (dagreMinY - 80)
        : ((agentTopY.get(agentId) ?? dagreMinY) - 80);
      strip.forEach((m, j) => {
        const x = j * MILESTONE_STEP_X;
        const y = stripBaseY + ((j % 2) * MILESTONE_ROW_DY);
        auxNodes.push({
          id: `ms:${agentId}:${j}:${m.t}:${m.kind}`,
          type: 'milestone',
          position: { x, y },
          draggable: false,
          selectable: false,
          data: m,
        });
      });
    });

    // Apply any user-dragged overrides last. The dagre pass is the source
    // of truth for everything else; user drags only override the single
    // node they dragged.
    const allNodes = [...agentNodes, ...auxNodes];
    for (const n of allNodes) {
      const pos = userPositions[n.id];
      if (pos) n.position = pos;
    }

    // Prune any edges whose endpoints no longer exist (e.g. user toggled
    // off "show bg-task nodes" so the bg-target edge is now orphaned). Also
    // strip the dashed animation when the setting is off, and stamp every
    // edge with the user-selected `type` so the FloatingEdge (or built-in
    // bezier / smoothstep / step / straight) renderer takes over.
    //
    // For the floating renderer we also copy the stroke colour into a
    // `data.color` field so the custom edge component can pick it up
    // without dipping into `style`. The original `style` object is kept
    // intact so the built-in renderers (which respect it directly) still
    // pick up the dim/teal/red/blue colours.
    const nodeIds = new Set(allNodes.map(n => n.id));
    const edgeType = settings.edgeType || 'floating';
    const finalEdges = [];
    for (const e of auxEdges) {
      if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
      const stroke = (e.style && e.style.stroke) || 'var(--teal)';
      const data = {
        ...(e.data || {}),
        color:           stroke,
        strokeWidth:     (e.style && e.style.strokeWidth) || 1.2,
        strokeDasharray: (e.style && e.style.strokeDasharray) || undefined,
      };
      const next = {
        ...e,
        type: edgeType,
        data,
        animated: settings.edgeAnimations ? e.animated : false,
      };
      finalEdges.push(next);
    }

    return { nodes: allNodes, edges: finalEdges };
  }, [agents, agentState, hasFilter, showAll, filterIds, expandedGroups, expandedNodes, userPositions, toggleGroup, toggleNode, tick, subagentChildren, settings]);

  // Auto-expand newly-arrived nodes.
  //
  // When `settings.autoExpandNewNodes` is on, any node id that ARRIVES after
  // the canvas has finished its first render gets added to `expandedNodes`
  // so the user sees it pre-opened. We deliberately skip the initial
  // mount's batch -- otherwise the very first render of a session with
  // hundreds of historical nodes would chaotically pop every one open.
  //
  // Strategy: stash every node id we've ever seen in a ref. On the first
  // useMemo pass we just seed the ref. On every later pass we diff the
  // current node ids against the ref. New ids that look expandable
  // (tool / subAgent / bg / subtool) get folded into expandedNodes via a
  // setExpandedNodes call. The ref then absorbs the new ids so we won't
  // re-expand them if the user manually collapses one later.
  const seenNodeIdsRef = useRef(null);
  useEffect(() => {
    if (!settings.autoExpandNewNodes) {
      // When the toggle flips off, drop the snapshot so re-enabling it
      // later doesn't suddenly auto-expand every historical node.
      seenNodeIdsRef.current = null;
      return;
    }
    const expandable = nodes
      .filter((n) => n.type === 'tool' || n.type === 'subAgent' || n.type === 'bgTask')
      .map((n) => n.id);
    if (seenNodeIdsRef.current === null) {
      // Initial seed -- mark every currently-visible expandable node as
      // already-seen so we don't auto-open the historical batch.
      seenNodeIdsRef.current = new Set(expandable);
      return;
    }
    const seen = seenNodeIdsRef.current;
    const fresh = [];
    for (const id of expandable) {
      if (!seen.has(id)) { fresh.push(id); seen.add(id); }
    }
    if (fresh.length === 0) return;
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      for (const id of fresh) next.add(id);
      return next;
    });
  }, [nodes, settings.autoExpandNewNodes]);

  // ── handlers ───────────────────────────────────────────────────────────

  const onNodeClick = useCallback((_ev, node) => {
    if (node.type === 'agent') {
      const id = node.data && node.data.agentId;
      if (id) window.location.hash = `#/agents/${encodeURIComponent(id)}`;
    }
    // Group toggle is handled inside the node so we don't double-fire on clicks
    // through the GroupNode div.
  }, []);

  const handleFit = useCallback(() => {
    const s = settingsRef.current || DEFAULT_FLOW_SETTINGS;
    try { fitView({ padding: (Number.isFinite(s.fitViewPadding) ? s.fitViewPadding : 0.2), duration: s.animationDuration ?? 250 }); } catch { /* ignore */ }
  }, [fitView]);

  // Auto-fit whenever the visible agent set changes (spawn, archive,
  // disconnect filter, show-all toggle). Skip while the user is mid-
  // interaction by deferring to a microtask after layout.
  const prevAgentIdsRef = useRef('');
  useEffect(() => {
    const sig = agents.map(a => a.id).sort().join(',');
    if (sig === prevAgentIdsRef.current) return;
    prevAgentIdsRef.current = sig;
    if (!agents.length) return;
    const raf = requestAnimationFrame(() => {
      const s = settingsRef.current || DEFAULT_FLOW_SETTINGS;
      try { fitView({ padding: (Number.isFinite(s.fitViewPadding) ? s.fitViewPadding : 0.2), duration: s.animationDuration ?? 250 }); } catch { /* ignore */ }
    });
    return () => cancelAnimationFrame(raf);
  }, [agents, fitView]);

  // ── render ─────────────────────────────────────────────────────────────

  return (
    <section className={`system-page system-page--flow${scoped ? ' system-page--flow-scoped' : ''}`}>
      <div className="flow-toolbar">
        {scoped
          ? <h2 className="system-page-title flow-toolbar__title">Conversation flow</h2>
          : <h2 className="system-page-title flow-toolbar__title">{hasFilter ? 'All conversations' : 'Live agent flow'}</h2>}
        <div className="flow-toolbar__spacer" />
        <button type="button" className="flow-toolbar__btn" onClick={refresh}>refresh</button>
        <button type="button" className="flow-toolbar__btn" onClick={handleFit}>fit view</button>
        <button
          type="button"
          className="flow-toolbar__btn"
          onClick={resetLayout}
          title="snap every node back to the auto-computed position"
          disabled={Object.keys(userPositions).length === 0}
        >reset layout</button>
        <button
          type="button"
          className={`flow-toolbar__btn${statsOpen ? ' flow-toolbar__btn--on' : ''}`}
          onClick={toggleStats}
          title="toggle stats panel"
        >
          stats
        </button>
        <button
          type="button"
          className={`flow-toolbar__gear topbar-icon-btn${settingsOpen ? ' flow-toolbar__gear--on' : ''}`}
          onClick={() => setSettingsOpen(v => !v)}
          title="flow settings"
          aria-label="flow settings"
          aria-pressed={settingsOpen}
          dangerouslySetInnerHTML={{ __html: iconHtml('settings') }}
        />
        {hasFilter && (
          <button
            type="button"
            className={`flow-toolbar__btn${showAll ? ' flow-toolbar__btn--on' : ''}`}
            onClick={() => setShowAll(v => !v)}
            title={showAll ? 'show only this conversation' : 'show every running agent'}
          >
            {showAll ? 'just this' : 'show all'}
          </button>
        )}
        {!scoped && !hasFilter && (
          <label className="flow-toolbar__check">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(ev) => setShowArchived(ev.target.checked)}
            />
            <span>show archived</span>
          </label>
        )}
        <span className="flow-toolbar__count">{agents.length} agent{agents.length === 1 ? '' : 's'}</span>
      </div>
      <div className="flow-canvas">
        {agents.length === 0 ? (
          <div className="flow-empty">no agents yet. spawn one from the conversations view.</div>
        ) : (
          <>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodeClick={onNodeClick}
              onNodeDragStop={onNodeDragStop}
              nodesDraggable={settings.nodesDraggable !== false}
              nodesConnectable={false}
              panOnDrag={settings.panOnDrag !== false}
              zoomOnScroll={settings.zoomOnScroll !== false}
              snapToGrid={!!settings.snapToGrid}
              snapGrid={[
                Number.isFinite(settings.snapGridSize) ? settings.snapGridSize : 15,
                Number.isFinite(settings.snapGridSize) ? settings.snapGridSize : 15,
              ]}
              connectionMode={settings.connectionMode === 'strict' ? 'strict' : 'loose'}
              fitView
              fitViewOptions={{
                padding: Number.isFinite(settings.fitViewPadding) ? settings.fitViewPadding : 0.15,
              }}
              proOptions={{ hideAttribution: true }}
              minZoom={Number.isFinite(settings.minZoom) ? settings.minZoom : 0.3}
              maxZoom={Number.isFinite(settings.maxZoom) ? settings.maxZoom : 2}
            >
              {settings.backgroundPattern !== 'none' && (
                <Background
                  variant={settings.backgroundPattern || 'dots'}
                  gap={Number.isFinite(settings.backgroundGap) ? settings.backgroundGap : 24}
                  size={1}
                  color="var(--border)"
                />
              )}
              {settings.showControls !== false && (
                <Controls showInteractive={false} />
              )}
              {!!settings.showMinimap && (
                <MiniMap pannable zoomable />
              )}
            </ReactFlow>
            <FlowTotalsOverlay agents={agents} agentState={agentState} />
            {statsOpen && (
              <FlowStatsPanel
                agents={agents}
                agentState={agentState}
                subagentChildren={subagentChildren}
                onClose={toggleStats}
                tick={tick}
              />
            )}
            {settingsOpen && (
              <FlowSettingsPanel
                settings={settings}
                statsOpen={statsOpen}
                onChange={updateSettings}
                onClose={() => setSettingsOpen(false)}
                onResetLayout={resetLayout}
                onResetAll={resetSettings}
                onToggleStats={toggleStats}
                canResetLayout={Object.keys(userPositions).length > 0}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}

const TOKEN_HISTORY_KEY = (id) => `grok-remote.flowTokens.${id}`;
// Cap kept generous so the sparkline / stats chart can show a meaningful
// history curve after replaying ~5000 events on page reload.
const TOKEN_HISTORY_MAX = 200;
// Cap on how many history events we replay on first open. Keeps reload
// time low for very long sessions while still covering all realistic cases.
const HISTORY_REPLAY_MAX = 5000;

function loadTokenHistory(id) {
  try {
    const raw = sessionStorage.getItem(TOKEN_HISTORY_KEY(id));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(p => p && typeof p.t === 'number' && typeof p.v === 'number').slice(-TOKEN_HISTORY_MAX);
  } catch { return []; }
}

function saveTokenHistory(id, history) {
  try {
    sessionStorage.setItem(TOKEN_HISTORY_KEY(id), JSON.stringify(history.slice(-TOKEN_HISTORY_MAX)));
  } catch { /* quota or disabled storage: silent */ }
}

// countActive, pickToolLabel, extractToolContent, mergeToolContent moved to
// ./flow-helpers.ts. Imported at the top of the file.

// fmtDuration + truncCmd moved to ./flow-helpers.ts

function FlowTotalsOverlay({ agents, agentState }) {
  let totalTokens = 0;
  let totalInFlight = 0;
  let runningAgents = 0;
  let bgRunning = 0;
  for (const a of agents) {
    const st = agentState[a.id] || {};
    const tok = (typeof st.tokens === 'number' && st.tokens > 0)
      ? st.tokens
      : (typeof a.totalTokens === 'number' ? a.totalTokens : 0);
    totalTokens += tok || 0;
    totalInFlight += (typeof st.inFlight === 'number' ? st.inFlight : 0);
    const status = st.status || a.status;
    if (status === 'running') runningAgents++;
    if (Array.isArray(st.bgTerminals)) {
      for (const t of st.bgTerminals) if (!t.exited) bgRunning++;
    }
  }
  if (!totalTokens && !totalInFlight && !runningAgents && !bgRunning) return null;
  return (
    <div className="flow-totals">
      {runningAgents > 0 && (
        <span className="flow-totals__cell" title={`${runningAgents} agent${runningAgents === 1 ? '' : 's'} running`}>
          <span className="flow-totals__dot flow-totals__dot--running" />
          {runningAgents} running
        </span>
      )}
      {totalInFlight > 0 && (
        <span className="flow-totals__cell" title={`${totalInFlight} tool call${totalInFlight === 1 ? '' : 's'} in flight across all agents`}>
          <span className="flow-totals__dot flow-totals__dot--inflight" />
          {totalInFlight} tool{totalInFlight === 1 ? '' : 's'}
        </span>
      )}
      {bgRunning > 0 && (
        <span className="flow-totals__cell flow-totals__cell--bg" title={`${bgRunning} bg shell${bgRunning === 1 ? '' : 's'} running`}>
          <span className="flow-totals__dot flow-totals__dot--bg" />
          {bgRunning} bg
        </span>
      )}
      {totalTokens > 0 && (
        <span className="flow-totals__cell flow-totals__cell--tokens" title={`${totalTokens.toLocaleString()} tokens across all agents`}>
          {fmtTokens(totalTokens)} tok
        </span>
      )}
    </div>
  );
}

// Right-side collapsible stats overlay. Shows aggregate metrics across the
// currently-visible agents: token chart, tools-per-turn bars, top-N kinds,
// avg duration per kind, plus a strip of counters.
function FlowStatsPanel({ agents, agentState, subagentChildren, onClose, tick }) {
  void tick; // forces "time since last activity" to refresh.

  const stats = useMemo(() => {
    // Merge all agent slices into a single set of stats.
    const allHist = [];
    let totalCalls = 0;
    let totalTurns = 0;
    let totalTokens = 0;
    let peakInFlight = 0;
    let longestMs = 0;
    let lastActivityAt = 0;
    let lastUserAt = 0;
    const perKind = new Map(); // kind -> { count, totalMs }
    const perTurn = new Map(); // turn -> count (approx; we share across agents)
    const subAgentEntries = []; // flat list across all visible agents
    let subAgentTotalMs = 0;
    let subAgentTimed = 0;

    for (const a of agents) {
      const st = agentState[a.id] || {};
      if (Array.isArray(st.subAgents)) {
        for (const sa of st.subAgents) {
          subAgentEntries.push({ ...sa, parentName: a.name || a.id.slice(0, 8) });
          if (sa.startedAt && sa.endedAt) {
            subAgentTotalMs += Math.max(0, sa.endedAt - sa.startedAt);
            subAgentTimed += 1;
          }
        }
      }
      if (Array.isArray(st.tokensHistory)) for (const p of st.tokensHistory) allHist.push(p);
      totalTokens += (typeof st.tokens === 'number' ? st.tokens : 0);
      totalTurns += (st.turn || 0);
      if (typeof st.peakInFlight === 'number' && st.peakInFlight > peakInFlight) peakInFlight = st.peakInFlight;
      if (st.lastActivityAt && st.lastActivityAt > lastActivityAt) lastActivityAt = st.lastActivityAt;
      if (st.lastUserAt && st.lastUserAt > lastUserAt) lastUserAt = st.lastUserAt;
      if (st.calls) {
        const calls = Object.values(st.calls);
        totalCalls += calls.length;
        // Group by turn boundaries inferred from sequential ordering against
        // milestones. Cheap fallback: just bucket by turn count of the agent.
        // We approximate per-turn buckets by spreading calls evenly.
        const turn = st.turn || 1;
        for (const c of calls) {
          const kind = c.kind || 'tool';
          const slot = perKind.get(kind) || { count: 0, totalMs: 0 };
          slot.count += 1;
          const end = c.endedAt || (c.startedAt ? Date.now() : 0);
          const dur = (c.startedAt && end) ? Math.max(0, end - c.startedAt) : 0;
          slot.totalMs += dur;
          if (dur > longestMs) longestMs = dur;
          perKind.set(kind, slot);
        }
        // Per-turn aggregation: assume each turn has the same average; the
        // user-facing chart is approximate. To get a better signal we walk
        // milestones if present.
        if (Array.isArray(st.milestones) && st.milestones.length) {
          let curTurn = 0;
          const turnBoundaries = [];
          for (const m of st.milestones) {
            if (m.kind === 'turn') {
              curTurn += 1;
              turnBoundaries.push({ turn: curTurn, t: m.t });
            }
          }
          for (const c of calls) {
            const ts = c.startedAt || 0;
            let t = 1;
            for (const tb of turnBoundaries) {
              if (ts >= tb.t) t = tb.turn;
              else break;
            }
            perTurn.set(t, (perTurn.get(t) || 0) + 1);
          }
        } else if (calls.length) {
          perTurn.set(turn, (perTurn.get(turn) || 0) + calls.length);
        }
      }
    }

    allHist.sort((a, b) => a.t - b.t);

    const topKinds = [...perKind.entries()]
      .map(([k, v]) => ({ kind: k, count: v.count, avgMs: v.count ? Math.round(v.totalMs / v.count) : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const turns = [...perTurn.entries()].sort((a, b) => a[0] - b[0]);

    subAgentEntries.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    const lastSubAgent = subAgentEntries.length ? subAgentEntries[subAgentEntries.length - 1] : null;
    const subAgentAvgMs = subAgentTimed ? Math.round(subAgentTotalMs / subAgentTimed) : 0;

    // Total fetched child tool calls across all loaded sub-agents. Only
    // sub-agents the user has expanded contribute (their child trace was
    // lazy-fetched on expand); collapsed ones report 0 here.
    let subAgentChildCallTotal = 0;
    if (subagentChildren && typeof subagentChildren === 'object') {
      for (const v of Object.values(subagentChildren)) {
        if (v && v.status === 'loaded' && Array.isArray(v.calls)) {
          subAgentChildCallTotal += v.calls.length;
        }
      }
    }

    return {
      tokensHist: allHist,
      totalCalls,
      totalTurns,
      totalTokens,
      peakInFlight,
      longestMs,
      lastActivityAt,
      lastUserAt,
      topKinds,
      perTurnBars: turns,
      subAgentCount: subAgentEntries.length,
      subAgentAvgMs,
      subAgentChildCallTotal,
      lastSubAgent,
    };
  }, [agents, agentState, subagentChildren]);

  const sincePart = (ts) => {
    if (!ts) return 'never';
    const d = Date.now() - ts;
    if (d < 1500) return 'just now';
    if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
    if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
    return `${Math.round(d / 3_600_000)}h ago`;
  };

  // Build a bigger token sparkline. Reuse buildSparkPath but tune dims.
  const tokSpark = stats.tokensHist.length >= 2
    ? buildSparkPath(stats.tokensHist, 280, 70)
    : null;

  // Tools-per-turn bars. Max bar count visible: 10.
  const bars = stats.perTurnBars.slice(-10);
  const maxBar = bars.reduce((m, [, v]) => Math.max(m, v), 1);

  return (
    <aside className="flow-stats" role="complementary" aria-label="flow stats">
      <header className="flow-stats__head">
        <h3 className="flow-stats__title">stats</h3>
        <button
          type="button"
          className="flow-stats__close"
          onClick={onClose}
          title="close stats panel"
        >x</button>
      </header>

      <section className="flow-stats__section">
        <div className="flow-stats__section-title">tokens over time</div>
        {tokSpark ? (
          <svg className="flow-stats__chart" viewBox="0 0 280 70" preserveAspectRatio="none">
            <path d={tokSpark.area} fill="rgba(94, 234, 212, 0.15)" />
            <path d={tokSpark.line} fill="none" stroke="var(--teal)" strokeWidth="1.4" />
          </svg>
        ) : (
          <div className="flow-stats__empty">not enough samples yet.</div>
        )}
        <div className="flow-stats__row">
          <span className="flow-stats__row-key">total</span>
          <span className="flow-stats__row-val flow-stats__row-val--teal">{stats.totalTokens ? fmtTokens(stats.totalTokens) : '0'}</span>
        </div>
      </section>

      <section className="flow-stats__section">
        <div className="flow-stats__section-title">tools per turn</div>
        {bars.length ? (
          <div className="flow-stats__bars">
            {bars.map(([turn, v]) => (
              <div className="flow-stats__bar" key={`bar-${turn}`} title={`turn ${turn}: ${v} call${v === 1 ? '' : 's'}`}>
                <div
                  className="flow-stats__bar-fill"
                  style={{ height: `${Math.max(4, (v / maxBar) * 56)}px` }}
                />
                <div className="flow-stats__bar-x">{turn}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flow-stats__empty">no turns yet.</div>
        )}
      </section>

      <section className="flow-stats__section">
        <div className="flow-stats__section-title">top tool kinds</div>
        {stats.topKinds.length ? (
          <ul className="flow-stats__list">
            {stats.topKinds.map((k) => (
              <li className="flow-stats__list-row" key={k.kind}>
                <span className="flow-stats__kind">{k.kind || 'tool'}</span>
                <span className="flow-stats__list-meta">{k.count} . avg {fmtDuration(k.avgMs)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flow-stats__empty">no tool calls yet.</div>
        )}
      </section>

      <section className="flow-stats__section">
        <div className="flow-stats__section-title">sub-agents</div>
        {stats.subAgentCount > 0 ? (
          <>
            <div className="flow-stats__row">
              <span className="flow-stats__row-key">spawned</span>
              <span className="flow-stats__row-val">{stats.subAgentCount}</span>
            </div>
            <div className="flow-stats__row">
              <span className="flow-stats__row-key">avg time</span>
              <span className="flow-stats__row-val">{stats.subAgentAvgMs ? fmtDuration(stats.subAgentAvgMs) : '--'}</span>
            </div>
            <div className="flow-stats__row" title="sum of tool calls inside expanded sub-agents (fetched on demand)">
              <span className="flow-stats__row-key">total child calls</span>
              <span className="flow-stats__row-val">{stats.subAgentChildCallTotal || 0}</span>
            </div>
            {stats.lastSubAgent && (
              <div className="flow-stats__row">
                <span className="flow-stats__row-key">most recent</span>
                <span
                  className="flow-stats__row-val flow-stats__row-val--blue"
                  title={stats.lastSubAgent.label || ''}
                >
                  {truncCmd(stats.lastSubAgent.label || '(unnamed)')}
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="flow-stats__empty">none yet.</div>
        )}
      </section>

      <section className="flow-stats__section flow-stats__section--counters">
        <Counter label="tool calls" value={stats.totalCalls} />
        <Counter label="turns"      value={stats.totalTurns} />
        <Counter label="sub-agents" value={stats.subAgentCount} />
        <Counter label="peak parallel" value={stats.peakInFlight} />
        <Counter label="longest"    value={fmtDuration(stats.longestMs) || '0ms'} />
        <Counter label="last activity" value={sincePart(stats.lastActivityAt)} />
        <Counter label="last user msg" value={sincePart(stats.lastUserAt)} />
      </section>
    </aside>
  );
}

function Counter({ label, value }) {
  return (
    <div className="flow-stats__counter">
      <div className="flow-stats__counter-val">{value == null || value === 0 ? '0' : value}</div>
      <div className="flow-stats__counter-key">{label}</div>
    </div>
  );
}

// ── settings panel ──────────────────────────────────────────────────────────
//
// Right-side overlay (mirrors FlowStatsPanel placement) that exposes every
// DEFAULT_FLOW_SETTINGS knob. Each control calls onChange with a partial
// patch; FlowInner.updateSettings merges + persists to localStorage.
function FlowSettingsPanel({
  settings,
  statsOpen,
  onChange,
  onClose,
  onResetLayout,
  onResetAll,
  onToggleStats,
  canResetLayout,
}) {
  return (
    <aside
      className="flow-settings"
      role="complementary"
      aria-label="flow settings"
      // Stop pan/zoom gestures inside the panel from being interpreted as
      // canvas pan/zoom. The panel sits over .flow-canvas; without this
      // React Flow grabs the mousedown.
      onMouseDownCapture={(e) => e.stopPropagation()}
      onWheelCapture={(e) => e.stopPropagation()}
    >
      <header className="flow-settings__head">
        <h3 className="flow-settings__title">flow settings</h3>
        <button
          type="button"
          className="flow-settings__close"
          onClick={onClose}
          title="close settings panel"
          aria-label="close"
        >x</button>
      </header>

      <div className="flow-settings__body">
        <section className="flow-settings__section">
          <div className="flow-settings__section-title">Layout</div>
          <div className="flow-settings__row">
            <label className="flow-settings__label" htmlFor="flow-set-dir">Direction</label>
            <select
              id="flow-set-dir"
              className="flow-settings__select"
              value={settings.direction}
              onChange={(e) => onChange({ direction: e.target.value })}
            >
              <option value="LR">left to right</option>
              <option value="TB">top to bottom</option>
              <option value="RL">right to left</option>
              <option value="BT">bottom to top</option>
            </select>
          </div>
          <SliderRow
            id="flow-set-ranksep"
            label="Rank spacing"
            min={40} max={200} step={5}
            value={settings.rankSpacing}
            onChange={(v) => onChange({ rankSpacing: v })}
            suffix="px"
          />
          <SliderRow
            id="flow-set-nodesep"
            label="Node spacing"
            min={10} max={100} step={2}
            value={settings.nodeSpacing}
            onChange={(v) => onChange({ nodeSpacing: v })}
            suffix="px"
          />
          <div className="flow-settings__row flow-settings__row--actions">
            <button
              type="button"
              className="flow-settings__btn"
              onClick={onResetLayout}
              disabled={!canResetLayout}
              title="snap every dragged node back to the auto-computed position"
            >Reset layout</button>
          </div>
        </section>

        <section className="flow-settings__section">
          <div className="flow-settings__section-title">Display</div>
          <ToggleRow
            label="Show milestones strip"
            checked={!!settings.showMilestones}
            onChange={(v) => onChange({ showMilestones: v })}
          />
          <ToggleRow
            label="Show stats panel"
            checked={!!statsOpen}
            onChange={() => onToggleStats()}
          />
          <ToggleRow
            label="Show bg-task nodes"
            checked={!!settings.showBgTasks}
            onChange={(v) => onChange({ showBgTasks: v })}
          />
          <ToggleRow
            label="Show sub-agent nodes"
            checked={!!settings.showSubAgents}
            onChange={(v) => onChange({ showSubAgents: v })}
          />
          <ToggleRow
            label="Show tool calls"
            checked={!!settings.showToolCalls}
            onChange={(v) => onChange({ showToolCalls: v })}
          />
          <ToggleRow
            label="Show tool groups"
            checked={!!settings.showGroups}
            onChange={(v) => onChange({ showGroups: v })}
          />
          <NumberRow
            id="flow-set-group-thresh"
            label="Group threshold"
            min={2} max={20} step={1}
            value={settings.groupThreshold}
            onChange={(v) => onChange({ groupThreshold: v })}
            disabled={!settings.showGroups}
          />
        </section>

        <section className="flow-settings__section">
          <div className="flow-settings__section-title">Interaction</div>
          <ToggleRow
            label="Nodes draggable"
            checked={!!settings.nodesDraggable}
            onChange={(v) => onChange({ nodesDraggable: v })}
          />
          <ToggleRow
            label="Pan on drag"
            checked={!!settings.panOnDrag}
            onChange={(v) => onChange({ panOnDrag: v })}
          />
          <ToggleRow
            label="Zoom on scroll"
            checked={!!settings.zoomOnScroll}
            onChange={(v) => onChange({ zoomOnScroll: v })}
          />
          <ToggleRow
            label="Snap to grid"
            checked={!!settings.snapToGrid}
            onChange={(v) => onChange({ snapToGrid: v })}
          />
          <NumberRow
            id="flow-set-snap-size"
            label="Snap grid size"
            min={5} max={50} step={1}
            value={settings.snapGridSize}
            onChange={(v) => onChange({ snapGridSize: v })}
            disabled={!settings.snapToGrid}
            suffix="px"
          />
        </section>

        <section className="flow-settings__section">
          <div className="flow-settings__section-title">Animation</div>
          <ToggleRow
            label="Auto-fit on expand"
            checked={!!settings.autoFitOnExpand}
            onChange={(v) => onChange({ autoFitOnExpand: v })}
          />
          <ToggleRow
            label="Edge animations"
            checked={!!settings.edgeAnimations}
            onChange={(v) => onChange({ edgeAnimations: v })}
          />
          <SliderRow
            id="flow-set-animdur"
            label="Animation duration"
            min={0} max={500} step={10}
            value={settings.animationDuration}
            onChange={(v) => onChange({ animationDuration: v })}
            suffix="ms"
          />
        </section>

        <section className="flow-settings__section">
          <div className="flow-settings__section-title">Advanced</div>
          <ToggleRow
            label="Auto-expand new nodes"
            checked={!!settings.autoExpandNewNodes}
            onChange={(v) => onChange({ autoExpandNewNodes: v })}
          />
          <div className="flow-settings__row">
            <label className="flow-settings__label" htmlFor="flow-set-edge-type">Edge type</label>
            <select
              id="flow-set-edge-type"
              className="flow-settings__select"
              value={settings.edgeType || 'floating'}
              onChange={(e) => onChange({ edgeType: e.target.value })}
            >
              <option value="floating">floating (closest)</option>
              <option value="bezier">bezier</option>
              <option value="smoothstep">smoothstep</option>
              <option value="step">step</option>
              <option value="straight">straight</option>
            </select>
          </div>
          <div className="flow-settings__row">
            <label className="flow-settings__label" htmlFor="flow-set-bg-pattern">Background pattern</label>
            <select
              id="flow-set-bg-pattern"
              className="flow-settings__select"
              value={settings.backgroundPattern || 'dots'}
              onChange={(e) => onChange({ backgroundPattern: e.target.value })}
            >
              <option value="dots">dots</option>
              <option value="lines">lines</option>
              <option value="cross">cross</option>
              <option value="none">none</option>
            </select>
          </div>
          <SliderRow
            id="flow-set-bg-gap"
            label="Background gap"
            min={10} max={50} step={1}
            value={settings.backgroundGap}
            onChange={(v) => onChange({ backgroundGap: v })}
            suffix="px"
          />
          <ToggleRow
            label="Show controls"
            checked={settings.showControls !== false}
            onChange={(v) => onChange({ showControls: v })}
          />
          <ToggleRow
            label="Show minimap"
            checked={!!settings.showMinimap}
            onChange={(v) => onChange({ showMinimap: v })}
          />
          <div className="flow-settings__row">
            <label className="flow-settings__label" htmlFor="flow-set-conn-mode">Connection mode</label>
            <select
              id="flow-set-conn-mode"
              className="flow-settings__select"
              value={settings.connectionMode || 'loose'}
              onChange={(e) => onChange({ connectionMode: e.target.value })}
            >
              <option value="loose">loose</option>
              <option value="strict">strict</option>
            </select>
          </div>
          <SliderRow
            id="flow-set-fit-padding"
            label="Fit-view padding"
            min={0.05} max={0.5} step={0.01}
            value={settings.fitViewPadding}
            onChange={(v) => onChange({ fitViewPadding: v })}
          />
          <SliderRow
            id="flow-set-max-zoom"
            label="Max zoom"
            min={1.5} max={4} step={0.1}
            value={settings.maxZoom}
            onChange={(v) => onChange({ maxZoom: v })}
            suffix="x"
          />
          <SliderRow
            id="flow-set-min-zoom"
            label="Min zoom"
            min={0.1} max={1} step={0.05}
            value={settings.minZoom}
            onChange={(v) => onChange({ minZoom: v })}
            suffix="x"
          />
        </section>

        <section className="flow-settings__section flow-settings__section--footer">
          <button
            type="button"
            className="flow-settings__btn flow-settings__btn--danger"
            onClick={onResetAll}
            title="clear localStorage + revert every setting to its default"
          >Reset to defaults</button>
        </section>
      </div>
    </aside>
  );
}

function ToggleRow({ label, checked, onChange }) {
  return (
    <label className="flow-settings__row flow-settings__row--toggle">
      <span className="flow-settings__label">{label}</span>
      <input
        type="checkbox"
        className="flow-settings__check"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function SliderRow({ id, label, min, max, step, value, onChange, suffix }) {
  const v = Number.isFinite(value) ? value : min;
  return (
    <div className="flow-settings__row flow-settings__row--slider">
      <label className="flow-settings__label" htmlFor={id}>{label}</label>
      <div className="flow-settings__slider-wrap">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step || 1}
          value={v}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flow-settings__slider"
        />
        <span className="flow-settings__slider-val">
          {v}{suffix ? <span className="flow-settings__slider-unit">{suffix}</span> : null}
        </span>
      </div>
    </div>
  );
}

function NumberRow({ id, label, min, max, step, value, onChange, suffix, disabled }) {
  const v = Number.isFinite(value) ? value : min;
  return (
    <div className={`flow-settings__row flow-settings__row--num${disabled ? ' flow-settings__row--disabled' : ''}`}>
      <label className="flow-settings__label" htmlFor={id}>{label}</label>
      <div className="flow-settings__num-wrap">
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step || 1}
          value={v}
          disabled={!!disabled}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
          }}
          className="flow-settings__num"
        />
        {suffix ? <span className="flow-settings__slider-unit">{suffix}</span> : null}
      </div>
    </div>
  );
}

export default function FlowApp(props) {
  return (
    <ReactFlowProvider>
      <FlowInner {...props} />
    </ReactFlowProvider>
  );
}
