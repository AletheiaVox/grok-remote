// Import page.

import { api } from '../../lib/api.js';

interface AvailableRecord {
  sessionId?: string;
  session_id?: string;
  id?: string;
  sid?: string;
  uuid?: string;
  summary?: string;
  label?: string;
  title?: string;
  first_prompt?: string;
  firstPrompt?: string;
  [k: string]: unknown;
}

interface ImportEvent {
  event?: string;
  status?: string;
  kind?: string;
  sessionId?: string;
  session_id?: string;
  id?: string;
  sid?: string;
  path?: string;
  target?: string;
  file?: string;
  message?: string;
  reason?: string;
  detail?: string;
  error?: string;
}

interface ImportState {
  loadingList: boolean;
  listError: string | null;
  available: AvailableRecord[];
  selected: Set<string>;
  pasteText: string;
  submitting: boolean;
  submitError: string | null;
  events: ImportEvent[];
}

let activeContainer: HTMLElement | null = null;
let state: ImportState = freshState();

function freshState(): ImportState {
  return {
    loadingList: false,
    listError: null,
    available: [],
    selected: new Set(),
    pasteText: '',
    submitting: false,
    submitError: null,
    events: [],
  };
}

export function mount(container: HTMLElement): void {
  activeContainer = container;
  state = freshState();
  render();
  void loadList();
}

export function unmount(): void {
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

async function loadList(): Promise<void> {
  state.loadingList = true;
  state.listError = null;
  render();
  try {
    const data = await api.importer.list() as { available?: AvailableRecord[] };
    state.available = Array.isArray(data?.available) ? data.available : [];
  } catch (err) {
    state.listError = err instanceof Error ? err.message : String(err);
    state.available = [];
  } finally {
    state.loadingList = false;
    if (activeContainer) render();
  }
}

function collectTargets(): string[] {
  const targets: string[] = [];
  for (const sid of state.selected) {
    if (typeof sid === 'string' && sid.trim()) targets.push(sid.trim());
  }
  const pasted = (state.pasteText || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of pasted) targets.push(p);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of targets) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

async function submit(): Promise<void> {
  if (state.submitting) return;
  state.submitting = true;
  state.submitError = null;
  state.events = [];
  render();
  const targets = collectTargets();
  try {
    const data = await api.importer.run(targets) as { events?: ImportEvent[] };
    state.events = Array.isArray(data?.events) ? data.events : [];
  } catch (err) {
    state.submitError = err instanceof Error ? err.message : String(err);
    state.events = [];
  } finally {
    state.submitting = false;
    if (activeContainer) render();
  }
}

function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortId(v: unknown): string {
  const s = String(v == null ? '' : v);
  if (s.length <= 18) return s;
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

function pickId(rec: AvailableRecord | null | undefined): string {
  if (!rec || typeof rec !== 'object') return '';
  const keys = ['sessionId', 'session_id', 'id', 'sid', 'uuid'] as const;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v) return v;
  }
  for (const v of Object.values(rec)) {
    if (typeof v === 'string' && /^[0-9a-f-]{8,}$/i.test(v)) return v;
  }
  return '';
}

function pickSummary(rec: AvailableRecord | null | undefined): string {
  if (!rec || typeof rec !== 'object') return '';
  const keys = ['summary', 'label', 'title', 'first_prompt', 'firstPrompt'] as const;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function pickEventStatus(ev: ImportEvent | null | undefined): string {
  if (!ev || typeof ev !== 'object') return 'unknown';
  if (typeof ev.event === 'string')  return ev.event;
  if (typeof ev.status === 'string') return ev.status;
  if (typeof ev.kind === 'string')   return ev.kind;
  return 'event';
}

function pickEventTarget(ev: ImportEvent | null | undefined): string {
  if (!ev || typeof ev !== 'object') return '';
  const keys = ['sessionId', 'session_id', 'id', 'sid', 'path', 'target', 'file'] as const;
  for (const k of keys) {
    const v = ev[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function pickEventMessage(ev: ImportEvent | null | undefined): string {
  if (!ev || typeof ev !== 'object') return '';
  const keys = ['message', 'reason', 'detail', 'error'] as const;
  for (const k of keys) {
    const v = ev[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function render(): void {
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

function wire(): void {
  if (!activeContainer) return;

  const reloadBtn = activeContainer.querySelector('.importer-reload') as HTMLButtonElement | null;
  if (reloadBtn) reloadBtn.addEventListener('click', () => void loadList());

  const checks = activeContainer.querySelectorAll('.import-check');
  checks.forEach((cb) => {
    cb.addEventListener('change', (e: Event) => {
      const sid = cb.getAttribute('data-sid') || '';
      if (!sid) return;
      if ((e.target as HTMLInputElement).checked) state.selected.add(sid);
      else state.selected.delete(sid);
      render();
    });
  });

  const paste = activeContainer.querySelector('#importer-paste') as HTMLTextAreaElement | null;
  if (paste) {
    paste.addEventListener('input', (e: Event) => {
      state.pasteText = (e.target as HTMLTextAreaElement).value;
      const submitBtn2 = activeContainer!.querySelector('.importer-submit') as HTMLButtonElement | null;
      const hint      = activeContainer!.querySelector('.importer-targets-hint') as HTMLElement | null;
      const targets   = collectTargets();
      if (submitBtn2 && !state.submitting) {
        submitBtn2.textContent = targets.length ? `import selected (${targets.length})` : 'import all available';
      }
      if (hint) {
        hint.textContent = targets.length
          ? `targets: ${targets.length}`
          : 'no targets selected; grok will import every session it can find.';
      }
    });
  }

  const submitBtn = activeContainer.querySelector('.importer-submit') as HTMLButtonElement | null;
  if (submitBtn) submitBtn.addEventListener('click', () => void submit());
}
