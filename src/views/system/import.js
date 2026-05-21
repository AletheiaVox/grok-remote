// Import page. Owned by its sub-agent.
//
// Wraps `grok import`:
//   - GET  /api/system/import         -> "available to import" list
//   - POST /api/system/import {tgts}  -> import selected + pasted paths
//
// Layout:
//   1. "available" list with a checkbox per row.
//   2. free-form textarea for .jsonl paths (one per line).
//   3. submit button that combines both into the targets argv.
//   4. result panel below with one row per NDJSON event.

import { api } from '../../lib/api';

let activeContainer = null;
let state = {
  loadingList: false,
  listError: null,
  available: [],
  selected: new Set(),
  pasteText: '',
  submitting: false,
  submitError: null,
  events: [],
};

export function mount(container) {
  activeContainer = container;
  state = {
    loadingList: false,
    listError: null,
    available: [],
    selected: new Set(),
    pasteText: '',
    submitting: false,
    submitError: null,
    events: [],
  };
  render();
  loadList();
}

export function unmount() {
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

async function loadList() {
  state.loadingList = true;
  state.listError = null;
  render();
  try {
    const data = await api.importer.list();
    state.available = Array.isArray(data?.available) ? data.available : [];
  } catch (err) {
    state.listError = err?.message || String(err);
    state.available = [];
  } finally {
    state.loadingList = false;
    if (activeContainer) render();
  }
}

function collectTargets() {
  const targets = [];
  for (const sid of state.selected) {
    if (typeof sid === 'string' && sid.trim()) targets.push(sid.trim());
  }
  const pasted = (state.pasteText || '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  for (const p of pasted) targets.push(p);
  // De-dupe while preserving order.
  const seen = new Set();
  const out = [];
  for (const t of targets) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

async function submit() {
  if (state.submitting) return;
  state.submitting = true;
  state.submitError = null;
  state.events = [];
  render();
  const targets = collectTargets();
  try {
    const data = await api.importer.run(targets);
    state.events = Array.isArray(data?.events) ? data.events : [];
  } catch (err) {
    state.submitError = err?.message || String(err);
    state.events = [];
  } finally {
    state.submitting = false;
    if (activeContainer) render();
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortId(v) {
  const s = String(v == null ? '' : v);
  if (s.length <= 18) return s;
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

// Pull a session-id-looking field out of an available-record. We don't
// know the exact JSON shape grok emits (the CLI may evolve); try the
// most likely keys, then fall back to the first string field.
function pickId(rec) {
  if (!rec || typeof rec !== 'object') return '';
  const keys = ['sessionId', 'session_id', 'id', 'sid', 'uuid'];
  for (const k of keys) {
    if (typeof rec[k] === 'string' && rec[k]) return rec[k];
  }
  for (const v of Object.values(rec)) {
    if (typeof v === 'string' && /^[0-9a-f-]{8,}$/i.test(v)) return v;
  }
  return '';
}

function pickSummary(rec) {
  if (!rec || typeof rec !== 'object') return '';
  const keys = ['summary', 'label', 'title', 'first_prompt', 'firstPrompt'];
  for (const k of keys) {
    if (typeof rec[k] === 'string' && rec[k]) return rec[k];
  }
  return '';
}

function pickEventStatus(ev) {
  if (!ev || typeof ev !== 'object') return 'unknown';
  if (typeof ev.event === 'string')  return ev.event;
  if (typeof ev.status === 'string') return ev.status;
  if (typeof ev.kind === 'string')   return ev.kind;
  return 'event';
}

function pickEventTarget(ev) {
  if (!ev || typeof ev !== 'object') return '';
  const keys = ['sessionId', 'session_id', 'id', 'sid', 'path', 'target', 'file'];
  for (const k of keys) {
    if (typeof ev[k] === 'string' && ev[k]) return ev[k];
  }
  return '';
}

function pickEventMessage(ev) {
  if (!ev || typeof ev !== 'object') return '';
  const keys = ['message', 'reason', 'detail', 'error'];
  for (const k of keys) {
    if (typeof ev[k] === 'string' && ev[k]) return ev[k];
  }
  return '';
}

function render() {
  if (!activeContainer) return;

  const availableRowsHtml = state.available.length
    ? state.available.map((rec) => {
        const id = pickId(rec);
        const summary = pickSummary(rec);
        const checked = state.selected.has(id) ? 'checked' : '';
        return `
          <label class="import-available-row">
            <input type="checkbox" class="import-check" data-sid="${escapeHtml(id)}" ${checked} ${id ? '' : 'disabled'} />
            <code class="import-available-id" title="${escapeHtml(id)}">${escapeHtml(shortId(id) || '(no id)')}</code>
            <span class="import-available-summary">${escapeHtml(summary)}</span>
          </label>
        `;
      }).join('')
    : '';

  const targetsPreview = collectTargets();

  const eventsHtml = state.events.length
    ? state.events.map((ev) => {
        const st = pickEventStatus(ev);
        const tgt = pickEventTarget(ev);
        const msg = pickEventMessage(ev);
        const cls = `import-event import-event--${escapeHtml(st)}`;
        return `
          <tr class="${cls}">
            <td class="import-event-status">${escapeHtml(st)}</td>
            <td class="import-event-target"><code>${escapeHtml(shortId(tgt))}</code></td>
            <td class="import-event-msg">${escapeHtml(msg)}</td>
          </tr>
        `;
      }).join('')
    : '';

  activeContainer.innerHTML = `
    <section class="system-page importer-page">
      <h2 class="system-page-title">Import</h2>
      <p class="system-page-sub">
        wraps <code>grok import</code>. tick a row, or paste <code>.jsonl</code>
        paths below, then "import selected". no selection imports everything.
      </p>

      <div class="importer-section">
        <div class="importer-section-head">
          <span class="importer-section-title">available to import</span>
          <button class="importer-reload" type="button">${state.loadingList ? 'loading...' : 'reload'}</button>
        </div>
        ${state.listError ? `<div class="importer-error">${escapeHtml(state.listError)}</div>` : ''}
        <div class="importer-available">
          ${availableRowsHtml || `<div class="importer-empty">${state.loadingList ? 'loading...' : 'nothing available. paste a path below, or submit empty to let grok scan.'}</div>`}
        </div>
      </div>

      <div class="importer-section">
        <label class="importer-section-title" for="importer-paste">paste .jsonl paths (one per line)</label>
        <textarea
          id="importer-paste"
          class="importer-paste"
          rows="4"
          placeholder="/path/to/session-019e4056.jsonl"
        >${escapeHtml(state.pasteText)}</textarea>
      </div>

      <div class="importer-submit-row">
        <button class="importer-submit" type="button" ${state.submitting ? 'disabled' : ''}>
          ${state.submitting ? 'importing...' : (targetsPreview.length ? `import selected (${targetsPreview.length})` : 'import all available')}
        </button>
        <span class="importer-targets-hint">
          ${targetsPreview.length ? `targets: ${targetsPreview.length}` : 'no targets selected; grok will import every session it can find.'}
        </span>
      </div>

      ${state.submitError ? `<div class="importer-error">${escapeHtml(state.submitError)}</div>` : ''}

      <div class="importer-section">
        <div class="importer-section-title">result</div>
        <div class="importer-result-wrap">
          <table class="importer-result-table">
            <thead>
              <tr><th>status</th><th>target</th><th>detail</th></tr>
            </thead>
            <tbody>${eventsHtml}</tbody>
          </table>
          ${state.events.length ? '' : `<div class="importer-empty">no events yet. hit "import" above.</div>`}
        </div>
      </div>
    </section>
  `;

  wire();
}

function wire() {
  if (!activeContainer) return;

  const reloadBtn = activeContainer.querySelector('.importer-reload');
  if (reloadBtn) reloadBtn.addEventListener('click', () => loadList());

  const checks = activeContainer.querySelectorAll('.import-check');
  checks.forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const sid = cb.getAttribute('data-sid') || '';
      if (!sid) return;
      if (e.target.checked) state.selected.add(sid);
      else state.selected.delete(sid);
      // Re-render to update the submit button counter.
      render();
    });
  });

  const paste = activeContainer.querySelector('#importer-paste');
  if (paste) {
    paste.addEventListener('input', (e) => {
      state.pasteText = e.target.value;
      // Only re-render the bottom hint; avoid stealing focus by skipping
      // a full render. We update just the counter and hint manually.
      const submitBtn = activeContainer.querySelector('.importer-submit');
      const hint      = activeContainer.querySelector('.importer-targets-hint');
      const targets   = collectTargets();
      if (submitBtn && !state.submitting) {
        submitBtn.textContent = targets.length ? `import selected (${targets.length})` : 'import all available';
      }
      if (hint) {
        hint.textContent = targets.length
          ? `targets: ${targets.length}`
          : 'no targets selected; grok will import every session it can find.';
      }
    });
  }

  const submitBtn = activeContainer.querySelector('.importer-submit');
  if (submitBtn) submitBtn.addEventListener('click', () => submit());
}
