// Trace tab. Re-fetches `grok trace <sessionId>` every time the tab is opened
// and renders the eight archive members into something readable: summary
// card, RPC timeline, method distribution bars, chat-history list, system
// prompt viewer, raw-file dump.

import { api } from '../lib/api';
import { el, escapeHtml } from '../lib/render.js';

let activeState = null;

export function mountTraceTab(container, agent) {
  unmountTraceTab();
  if (!container) return;

  if (!agent || !agent.id) {
    container.replaceChildren(el('div', { class: 'pane-empty' }, 'no agent selected'));
    return;
  }

  const state = { container, agent, destroyed: false };
  activeState = state;

  // Always start with a loading placeholder; we re-fetch every mount.
  container.replaceChildren(buildLoading());
  fetchAndRender(state).catch((err) => {
    if (state.destroyed) return;
    container.replaceChildren(buildError(err.message || String(err)));
  });
}

export function unmountTraceTab() {
  if (!activeState) return;
  activeState.destroyed = true;
  activeState = null;
}

async function fetchAndRender(state) {
  let data;
  try {
    data = await api.trace(state.agent.id);
  } catch (err) {
    throw err;
  }
  if (state.destroyed) return;
  state.container.replaceChildren(renderTrace(data));
}

function buildLoading() {
  return el('div', { class: 'trace trace--loading' },
    el('div', { class: 'trace-spinner' }, 'fetching trace from grok...'),
    el('div', { class: 'trace-loading-sub' }, 'we run `grok trace <sessionId> --local`, extract the tar.gz, and parse every file in it. takes a few seconds.'),
  );
}

function buildError(msg) {
  return el('div', { class: 'trace trace--err' },
    el('div', { class: 'trace-err-title' }, 'trace failed'),
    el('pre', { class: 'trace-err-body' }, msg),
    el('div', { class: 'trace-err-hint' }, 'common causes: the agent has not completed its handshake yet (no sessionId), or the grok binary is not on PATH.'),
  );
}

function renderTrace(d) {
  const root = el('div', { class: 'trace' });
  root.appendChild(renderHeader(d));
  root.appendChild(renderSummaryCard(d));
  root.appendChild(renderTimeline(d));
  root.appendChild(renderMethodDistribution(d));
  root.appendChild(renderToolLatency(d));
  root.appendChild(renderTurnBreakdown(d));
  root.appendChild(renderTokenChart(d));
  root.appendChild(renderChatHistory(d));
  root.appendChild(renderSystemPrompt(d));
  root.appendChild(renderRawFiles(d));
  return root;
}

// ── header ───────────────────────────────────────────────────────────────

function renderHeader(d) {
  return el('header', { class: 'trace-head' },
    el('div', null,
      el('h2', { class: 'trace-h2' }, 'session trace'),
      el('div', { class: 'trace-sub' },
        el('span', null, 'session '),
        el('code', null, d.sessionId || '·'),
        el('span', null, ' · captured '),
        el('span', null, fmtTime(d.generatedAt)),
        el('span', null, ' · archive '),
        el('span', null, fmtBytes(d.archiveBytes)),
      ),
    ),
    el('button', {
      class: 'btn btn--ghost trace-refresh',
      type: 'button',
      title: 'fetch the latest export',
      onclick: () => {
        if (!activeState) return;
        activeState.container.replaceChildren(buildLoading());
        fetchAndRender(activeState).catch((err) => {
          if (activeState && !activeState.destroyed) {
            activeState.container.replaceChildren(buildError(err.message));
          }
        });
      },
    }, 'refresh'),
  );
}

// ── summary card ─────────────────────────────────────────────────────────

function renderSummaryCard(d) {
  const s = d.summary || {};
  const info = s.info || {};
  const pairs = [
    ['session id',     info.id || d.sessionId || '·'],
    ['model',          s.current_model_id || '·'],
    ['cwd',            info.cwd || '·'],
    ['created',        fmtTime(s.created_at)],
    ['updated',        fmtTime(s.updated_at)],
    ['last active',    fmtTime(s.last_active_at)],
    ['messages',       String(s.num_messages ?? '·')],
    ['chat messages',  String(s.num_chat_messages ?? '·')],
    ['next trace turn',String(s.next_trace_turn ?? '·')],
    ['format version', String(s.chat_format_version ?? '·')],
    ['git branch',     s.head_branch || '·'],
    ['head commit',    s.head_commit ? s.head_commit.slice(0, 12) : '·'],
    ['git root',       s.git_root_dir || '·'],
    ['git remotes',    (s.git_remotes || []).join(', ') || '·'],
    ['grok home',      s.grok_home || '·'],
  ];
  return el('section', { class: 'trace-section' },
    el('h3', { class: 'trace-section-title' }, 'summary'),
    el('div', { class: 'trace-kv' },
      ...pairs.flatMap(([k, v]) => [
        el('div', { class: 'trace-kv-k' }, k),
        el('div', { class: 'trace-kv-v' }, v),
      ]),
    ),
    s.session_summary ? el('div', { class: 'trace-summary-text' },
      el('div', { class: 'trace-section-sub' }, 'session summary text'),
      el('div', null, s.session_summary),
    ) : null,
  );
}

// ── RPC timeline ─────────────────────────────────────────────────────────

function renderTimeline(d) {
  // updates.jsonl rows are { timestamp, method, params }. Plot them on a
  // horizontal time axis colored by method.
  const rows = Array.isArray(d.updates) ? d.updates : [];
  if (!rows.length) {
    return el('section', { class: 'trace-section' },
      el('h3', { class: 'trace-section-title' }, 'rpc timeline'),
      el('div', { class: 'trace-section-empty' }, 'no updates recorded for this session.'),
    );
  }
  const ts = rows.map(r => parseTs(r.timestamp)).filter(n => Number.isFinite(n));
  if (!ts.length) {
    return el('section', { class: 'trace-section' },
      el('h3', { class: 'trace-section-title' }, 'rpc timeline'),
      el('div', { class: 'trace-section-empty' }, 'no parseable timestamps in updates.jsonl.'),
    );
  }
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const span = Math.max(1, t1 - t0);

  const methodColor = {};
  let cI = 0;
  const palette = ['#5eead4', '#79c0ff', '#86efac', '#fca854', '#ff7b72', '#c084fc', '#f59e0b', '#22d3ee'];
  function colorFor(method) {
    if (!methodColor[method]) methodColor[method] = palette[cI++ % palette.length];
    return methodColor[method];
  }

  const lane = el('div', { class: 'trace-timeline' });
  for (const r of rows) {
    const t = parseTs(r.timestamp);
    if (!Number.isFinite(t)) continue;
    const left = ((t - t0) / span) * 100;
    const dot = el('div', {
      class: 'trace-timeline-dot',
      style: {
        left: `${left}%`,
        background: colorFor(r.method || 'unknown'),
      },
      title: `${r.method || 'unknown'}  @ ${new Date(t).toISOString()}`,
    });
    lane.appendChild(dot);
  }

  // Legend
  const legend = el('div', { class: 'trace-legend' },
    ...Object.entries(methodColor).map(([m, c]) =>
      el('span', { class: 'trace-legend-item' },
        el('span', { class: 'trace-legend-dot', style: { background: c } }),
        el('span', null, m),
      )
    ),
  );

  // Axis labels
  const axis = el('div', { class: 'trace-axis' },
    el('span', null, fmtTime(new Date(t0).toISOString())),
    el('span', null, `${(span / 1000).toFixed(1)}s span`),
    el('span', null, fmtTime(new Date(t1).toISOString())),
  );

  return el('section', { class: 'trace-section' },
    el('h3', { class: 'trace-section-title' }, `rpc timeline (${rows.length} updates)`),
    lane,
    axis,
    legend,
  );
}

// ── method distribution ──────────────────────────────────────────────────

function renderMethodDistribution(d) {
  const rows = Array.isArray(d.updates) ? d.updates : [];
  const counts = new Map();
  for (const r of rows) {
    const k = r.method || 'unknown';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (!counts.size) {
    return el('section', { class: 'trace-section' },
      el('h3', { class: 'trace-section-title' }, 'method distribution'),
      el('div', { class: 'trace-section-empty' }, 'no methods to summarize.'),
    );
  }
  const max = Math.max(...counts.values());
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return el('section', { class: 'trace-section' },
    el('h3', { class: 'trace-section-title' }, 'method distribution'),
    el('div', { class: 'trace-bars' },
      ...sorted.map(([m, n]) =>
        el('div', { class: 'trace-bar-row' },
          el('span', { class: 'trace-bar-label', title: m }, m),
          el('div', { class: 'trace-bar-track' },
            el('div', {
              class: 'trace-bar-fill',
              style: { width: `${(n / max) * 100}%` },
            }),
          ),
          el('span', { class: 'trace-bar-count' }, String(n)),
        )
      ),
    ),
  );
}

// ── tool call latency ───────────────────────────────────────────────────

function renderToolLatency(d) {
  // Pair each tool_call (params.update.sessionUpdate === 'tool_call') with
  // its completing tool_call_update (status === 'completed'). Latency is the
  // delta between the two timestamps. Group by tool kind/title.
  const rows = Array.isArray(d.updates) ? d.updates : [];
  const starts = new Map(); // toolCallId -> { t, kind, title }
  const samples = []; // { kind, title, ms }
  for (const r of rows) {
    const u = r && r.params && r.params.update;
    if (!u || typeof u !== 'object') continue;
    const sub = u.sessionUpdate || u.kind;
    const id = u.toolCallId || u.id;
    if (!id) continue;
    const t = parseTs(r.timestamp);
    if (!Number.isFinite(t)) continue;
    if (sub === 'tool_call' || sub === 'tool_call_start') {
      starts.set(id, { t, kind: u.kind || u.toolKind || 'tool', title: u.title || u.label || u.toolName || 'tool' });
    } else if ((sub === 'tool_call_update' || sub === 'tool_call_end') && (u.status === 'completed' || u.status === 'failed' || u.status === 'canceled')) {
      const s = starts.get(id);
      if (!s) continue;
      samples.push({ kind: s.kind, title: s.title, ms: Math.max(0, t - s.t), status: u.status });
      starts.delete(id);
    }
  }
  if (!samples.length) {
    return el('section', { class: 'trace-section' },
      el('h3', { class: 'trace-section-title' }, 'tool call latency'),
      el('div', { class: 'trace-section-empty' }, 'no completed tool calls in this trace.'),
    );
  }
  // Group by title; compute p50/p95/sum.
  const groups = new Map();
  for (const s of samples) {
    let g = groups.get(s.title);
    if (!g) { g = { title: s.title, kind: s.kind, ms: [], failed: 0 }; groups.set(s.title, g); }
    g.ms.push(s.ms);
    if (s.status === 'failed' || s.status === 'canceled') g.failed++;
  }
  const list = [];
  for (const g of groups.values()) {
    g.ms.sort((a, b) => a - b);
    const n = g.ms.length;
    const sum = g.ms.reduce((a, b) => a + b, 0);
    const p50 = g.ms[Math.floor(n * 0.50)];
    const p95 = g.ms[Math.min(n - 1, Math.floor(n * 0.95))];
    list.push({ title: g.title, kind: g.kind, n, sum, p50, p95, failed: g.failed, max: g.ms[n - 1] });
  }
  list.sort((a, b) => b.sum - a.sum);
  const maxSum = list[0].sum;

  const fmtMs = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
  return el('section', { class: 'trace-section' },
    el('h3', { class: 'trace-section-title' }, `tool call latency (${samples.length} calls)`),
    el('div', { class: 'trace-tool-table' },
      el('div', { class: 'trace-tool-row trace-tool-row--head' },
        el('span', { class: 'trace-tool-c trace-tool-c--name' }, 'tool'),
        el('span', { class: 'trace-tool-c trace-tool-c--num' }, 'n'),
        el('span', { class: 'trace-tool-c trace-tool-c--num' }, 'p50'),
        el('span', { class: 'trace-tool-c trace-tool-c--num' }, 'p95'),
        el('span', { class: 'trace-tool-c trace-tool-c--num' }, 'max'),
        el('span', { class: 'trace-tool-c trace-tool-c--bar' }, 'total time'),
      ),
      ...list.map(g => el('div', { class: 'trace-tool-row' },
        el('span', { class: 'trace-tool-c trace-tool-c--name', title: g.title }, g.title),
        el('span', { class: 'trace-tool-c trace-tool-c--num' }, String(g.n) + (g.failed ? ` (${g.failed}✗)` : '')),
        el('span', { class: 'trace-tool-c trace-tool-c--num' }, fmtMs(g.p50)),
        el('span', { class: 'trace-tool-c trace-tool-c--num' }, fmtMs(g.p95)),
        el('span', { class: 'trace-tool-c trace-tool-c--num' }, fmtMs(g.max)),
        el('span', { class: 'trace-tool-c trace-tool-c--bar' },
          el('span', { class: 'trace-tool-bar-track' },
            el('span', { class: 'trace-tool-bar-fill', style: { width: `${(g.sum / maxSum) * 100}%` } }),
          ),
          el('span', { class: 'trace-tool-bar-num' }, fmtMs(g.sum)),
        ),
      )),
    ),
  );
}

// ── per-turn tool count ─────────────────────────────────────────────────

function renderTurnBreakdown(d) {
  // Bucket tool starts into turns. Prefer an explicit `session/prompt` RPC
  // boundary if present; otherwise fall back to a 5-second idle gap between
  // consecutive tool calls as the heuristic boundary.
  const rows = Array.isArray(d.updates) ? d.updates : [];
  if (!rows.length) return el('section', { class: 'trace-section' },
    el('h3', { class: 'trace-section-title' }, 'tool calls per turn'),
    el('div', { class: 'trace-section-empty' }, 'no updates to analyse.'),
  );

  // Collect tool-call starts in time order.
  const starts = [];
  let hasPromptMethod = false;
  const promptTs = [];
  for (const r of rows) {
    const t = parseTs(r.timestamp);
    if (!Number.isFinite(t)) continue;
    if ((r.method || '') === 'session/prompt') {
      hasPromptMethod = true;
      promptTs.push(t);
    }
    const u = r && r.params && r.params.update;
    if (!u || typeof u !== 'object') continue;
    const sub = u.sessionUpdate || u.kind;
    if (sub === 'tool_call' || sub === 'tool_call_start') starts.push(t);
  }
  if (!starts.length) return el('section', { class: 'trace-section' },
    el('h3', { class: 'trace-section-title' }, 'tool calls per turn'),
    el('div', { class: 'trace-section-empty' }, 'no tool calls in this trace.'),
  );
  starts.sort((a, b) => a - b);

  // Bucket starts by turn boundaries.
  const GAP_MS = 5000;
  let turns;
  let mode;
  if (hasPromptMethod && promptTs.length > 0) {
    mode = 'prompt';
    promptTs.sort((a, b) => a - b);
    turns = promptTs.map(t => ({ startTs: t, count: 0 }));
    for (const s of starts) {
      // Find latest prompt boundary <= s.
      let idx = -1;
      for (let i = 0; i < promptTs.length; i++) {
        if (promptTs[i] <= s) idx = i; else break;
      }
      if (idx < 0) {
        // Tool call before any prompt; treat as preamble.
        if (!turns.length || turns[0].startTs > s) turns.unshift({ startTs: s, count: 0 });
        turns[0].count++;
      } else {
        turns[idx].count++;
      }
    }
  } else {
    mode = 'gap';
    turns = [];
    let cur = { startTs: starts[0], count: 1, lastTs: starts[0] };
    for (let i = 1; i < starts.length; i++) {
      const s = starts[i];
      if (s - cur.lastTs > GAP_MS) {
        turns.push(cur);
        cur = { startTs: s, count: 1, lastTs: s };
      } else {
        cur.count++;
        cur.lastTs = s;
      }
    }
    turns.push(cur);
  }

  const max = Math.max(1, ...turns.map(t => t.count));
  const total = turns.reduce((a, t) => a + t.count, 0);
  const avg = (total / turns.length).toFixed(1);
  const subtitle = mode === 'prompt'
    ? `${turns.length} turn${turns.length === 1 ? '' : 's'} (session/prompt boundaries)`
    : `${turns.length} turn${turns.length === 1 ? '' : 's'} (>${GAP_MS / 1000}s idle gap heuristic)`;

  return el('section', { class: 'trace-section' },
    el('h3', { class: 'trace-section-title' }, `tool calls per turn — ${subtitle}, avg ${avg}/turn`),
    el('div', { class: 'trace-turn-bars' },
      ...turns.map((t, i) => el('div', {
        class: 'trace-turn-bar',
        title: `turn ${i + 1}: ${t.count} tool call${t.count === 1 ? '' : 's'} @ ${new Date(t.startTs).toLocaleTimeString()}`,
      },
        el('span', { class: 'trace-turn-bar-track' },
          el('span', { class: 'trace-turn-bar-fill', style: { height: `${(t.count / max) * 100}%` } }),
        ),
        el('span', { class: 'trace-turn-bar-label' }, `t${i + 1}`),
        el('span', { class: 'trace-turn-bar-count' }, String(t.count)),
      )),
    ),
  );
}

// ── context-size growth (from updates.jsonl params._meta.totalTokens) ────

function renderTokenChart(d) {
  // The trace archive only carries a cumulative totalTokens on each
  // session/update; the per-turn input/output/cached/reasoning split lives
  // in the live prompt_result response and isn't archived. So we plot the
  // context-window fill over time. Tooltips on each point show the exact
  // totalTokens value and timestamp.
  const rows = Array.isArray(d.updates) ? d.updates : [];
  const points = [];
  for (const r of rows) {
    const meta = r?.params?._meta || r?._meta;
    const tt = meta && (meta.totalTokens ?? meta.total_tokens);
    if (typeof tt !== 'number') continue;
    const t = parseTs(r.timestamp);
    points.push({ t, total: tt });
  }
  if (!points.length) {
    return el('section', { class: 'trace-section' },
      el('h3', { class: 'trace-section-title' }, 'context-window growth'),
      el('div', { class: 'trace-section-empty' },
        'this trace did not record any totalTokens fields. ',
        'grok archives totalTokens on session/update events; if the agent ',
        'never emitted one, there is nothing to chart.'),
    );
  }
  points.sort((a, b) => a.t - b.t);
  const finalT = points[points.length - 1].total;
  const peakT  = Math.max(...points.map(p => p.total));
  const minT   = Math.min(...points.map(p => p.total));
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = Math.max(1, t1 - t0);

  // Build an inline SVG sparkline. Width auto-scales (viewBox), height
  // fixed at 80.
  const W = 1000, H = 80, padY = 6;
  const x = (tt) => ((tt - t0) / span) * W;
  const y = (tk) => H - padY - ((tk - 0) / peakT) * (H - padY * 2);
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.t).toFixed(2)} ${y(p.total).toFixed(2)}`).join(' ');
  const areaD = pathD + ` L ${x(points[points.length - 1].t).toFixed(2)} ${H} L ${x(points[0].t).toFixed(2)} ${H} Z`;

  // SVG via raw markup string (avoids re-implementing namespaced createElementNS).
  const svgHtml = `
    <svg class="trace-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${areaD}" fill="rgba(94, 234, 212, 0.18)"></path>
      <path d="${pathD}" fill="none" stroke="var(--teal)" stroke-width="2"></path>
      ${points.map(p => `<circle cx="${x(p.t).toFixed(2)}" cy="${y(p.total).toFixed(2)}" r="2.4" fill="var(--teal)"><title>${p.total} tokens @ ${new Date(p.t).toLocaleTimeString()}</title></circle>`).join('')}
    </svg>
  `;
  const spark = document.createElement('div');
  spark.className = 'trace-spark-wrap';
  spark.innerHTML = svgHtml;

  const stats = el('div', { class: 'trace-token-stats' },
    el('div', null,
      el('span', { class: 'trace-token-stat-k' }, 'peak '),
      el('span', { class: 'trace-token-stat-v' }, String(peakT.toLocaleString())),
    ),
    el('div', null,
      el('span', { class: 'trace-token-stat-k' }, 'final '),
      el('span', { class: 'trace-token-stat-v' }, String(finalT.toLocaleString())),
    ),
    el('div', null,
      el('span', { class: 'trace-token-stat-k' }, 'min '),
      el('span', { class: 'trace-token-stat-v' }, String(minT.toLocaleString())),
    ),
    el('div', null,
      el('span', { class: 'trace-token-stat-k' }, 'samples '),
      el('span', { class: 'trace-token-stat-v' }, String(points.length.toLocaleString())),
    ),
  );

  return el('section', { class: 'trace-section' },
    el('h3', { class: 'trace-section-title' }, 'context-window growth (cumulative tokens)'),
    spark,
    el('div', { class: 'trace-axis' },
      el('span', null, fmtTime(new Date(t0).toISOString())),
      el('span', null, `${(span / 1000).toFixed(1)}s span · range ${minT.toLocaleString()} → ${peakT.toLocaleString()}`),
      el('span', null, fmtTime(new Date(t1).toISOString())),
    ),
    stats,
    el('div', { class: 'trace-section-sub' },
      'shows totalTokens carried on each session/update event. ',
      'the trace export does not include the per-turn input/output split.'),
  );
}

// ── chat history ─────────────────────────────────────────────────────────

function renderChatHistory(d) {
  const rows = Array.isArray(d.chatHistory) ? d.chatHistory : [];
  if (!rows.length) {
    return el('section', { class: 'trace-section' },
      el('h3', { class: 'trace-section-title' }, 'chat history'),
      el('div', { class: 'trace-section-empty' }, 'no chat history rows.'),
    );
  }
  return el('section', { class: 'trace-section' },
    el('h3', { class: 'trace-section-title' }, `chat history (${rows.length})`),
    el('div', { class: 'trace-chat' },
      ...rows.map((m, idx) => renderChatRow(m, idx))
    ),
  );
}

function renderChatRow(m, idx) {
  const type = m.type || m.role || 'unknown';
  const content = m.content;
  let body;
  if (typeof content === 'string') {
    body = el('pre', { class: 'trace-chat-text' }, content);
  } else if (Array.isArray(content)) {
    body = el('div', { class: 'trace-chat-blocks' },
      ...content.map(b => {
        if (!b || typeof b !== 'object') return null;
        if (b.type === 'text' || b.type === 'input_text') {
          return el('pre', { class: 'trace-chat-text' }, b.text || '');
        }
        return el('pre', { class: 'trace-chat-raw' }, JSON.stringify(b, null, 2));
      }),
    );
  } else if (content != null) {
    body = el('pre', { class: 'trace-chat-raw' }, JSON.stringify(content, null, 2));
  } else {
    body = el('div', { class: 'trace-chat-empty' }, '(no content)');
  }
  const headLine = el('div', { class: 'trace-chat-head' },
    el('span', { class: `trace-chat-type trace-chat-type--${type}` }, type),
    el('span', { class: 'trace-chat-idx' }, `#${idx + 1}`),
  );
  // Long bodies (like the system prompt) are collapsed for legibility.
  const wrap = el('details', { class: 'trace-chat-row' },
    el('summary', null, headLine),
    body,
  );
  // Auto-expand user / assistant messages; keep system collapsed.
  if (type === 'user' || type === 'assistant') wrap.open = true;
  return wrap;
}

// ── system prompt viewer ─────────────────────────────────────────────────

function renderSystemPrompt(d) {
  const text = d.systemPrompt || '';
  return el('section', { class: 'trace-section' },
    el('h3', { class: 'trace-section-title' }, `system prompt (${fmtBytes(text.length)})`),
    el('details', { class: 'trace-sys' },
      el('summary', null, text.length ? 'show / hide' : '(empty)'),
      el('pre', { class: 'trace-sys-body' }, text),
    ),
  );
}

// ── raw file dump ────────────────────────────────────────────────────────

function renderRawFiles(d) {
  const items = [
    ['summary.json',        d.summary,        false],
    ['chat_history.jsonl',  d.chatHistory,    false],
    ['events.jsonl',        d.events,         false],
    ['updates.jsonl',       d.updates,        false],
    ['prompt_context.json', d.promptContext,  false],
    ['trace_config.json',   d.traceConfig,    false],
    ['export_metadata.json',d.exportMetadata, false],
  ];
  return el('section', { class: 'trace-section' },
    el('h3', { class: 'trace-section-title' }, 'raw archive files'),
    el('div', { class: 'trace-section-sub' },
      'parsed in-memory; every tab open re-runs `grok trace --local` and re-parses.'),
    ...items.map(([name, value]) => renderRawBlock(name, value, d.memberSizes)),
  );
}

function renderRawBlock(name, value, sizes) {
  const sz = sizes && sizes[memberKeyFromFilename(name)];
  const present = !(value == null || (Array.isArray(value) && value.length === 0));
  const dl = el('button', {
    class: 'trace-copy',
    type: 'button',
    title: 'copy parsed JSON to clipboard',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
        dl.textContent = 'copied';
        setTimeout(() => { dl.textContent = 'copy'; }, 1500);
      } catch { /* ignore */ }
    },
  }, 'copy');
  return el('details', { class: 'trace-raw' },
    el('summary', null,
      el('span', { class: 'trace-raw-name' }, name),
      el('span', { class: 'trace-raw-meta' },
        present ? `${Array.isArray(value) ? value.length + ' rows' : 'object'}${sz ? ' · ' + fmtBytes(sz) : ''}` : '(empty)'),
      dl,
    ),
    el('pre', { class: 'trace-raw-body' }, JSON.stringify(value, null, 2)),
  );
}

function memberKeyFromFilename(name) {
  // matches keys in trace-host.js memberSizes map
  switch (name) {
    case 'summary.json':         return 'summary';
    case 'chat_history.jsonl':   return 'chatHistory';
    case 'events.jsonl':         return 'events';
    case 'updates.jsonl':        return 'updates';
    case 'prompt_context.json':  return 'promptContext';
    case 'trace_config.json':    return 'traceConfig';
    case 'export_metadata.json': return 'exportMetadata';
    case 'system_prompt.txt':    return 'systemPrompt';
  }
  return name;
}

// ── helpers ──────────────────────────────────────────────────────────────

function parseTs(v) {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}

function fmtTime(iso) {
  if (!iso) return '·';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return String(iso);
  }
}

function fmtBytes(n) {
  if (n == null) return '·';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default mountTraceTab;
