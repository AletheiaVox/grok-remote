// Self-update modal.

import { el } from '../lib/render.js';
import { iconHtml as _iconHtml } from '../lib/icons.js';
import { api } from '../lib/api.js';

void _iconHtml;

const STEP_LABELS: Record<string, string> = {
  open:      'connecting',
  preflight: 'preflight',
  fetch:     'git fetch origin main',
  pull:      'git pull --ff-only',
  install:   'npm install',
  build:     'npm run build',
  restart:   'pm2 restart',
  done:      'done',
};

const STEP_ORDER = ['preflight', 'fetch', 'pull', 'install', 'build', 'restart'] as const;

interface CurrentInfo {
  gitSha?: string;
  version?: string;
}

interface LatestInfo {
  latestSha?: string;
  latestVersion?: string;
  behind?: number;
}

export interface UpdateModalOptions {
  current?: CurrentInfo | null;
  latest?:  LatestInfo  | null;
}

interface UpdateStepEvent {
  step?: string;
  status?: 'start' | 'log' | 'ok' | 'fail' | 'skip';
  detail?: string;
}

interface StepRow {
  node: HTMLElement;
  start(text?: string): void;
  appendLog(chunk?: string): void;
  markOk(text?: string): void;
  markFail(text?: string): void;
  markSkip(text?: string): void;
  markWaiting(text?: string): void;
}

export function openUpdateModal({ current, latest }: UpdateModalOptions = {}): { close: () => void } {
  const beforeSha = current && current.gitSha;
  const beforeVersion = current && current.version;

  const closeBtn = el('button', {
    type: 'button',
    class: 'update-modal__close',
    title: 'close',
    'aria-label': 'close',
    onclick: () => close(),
  }, '×');

  const headerSummary = el('div', { class: 'update-modal__summary' });
  if (current && latest) {
    headerSummary.appendChild(el('span', { class: 'update-modal__summary-line' },
      `current ${shortSha(current.gitSha)} · v${current.version || '?'}`));
    headerSummary.appendChild(el('span', { class: 'update-modal__summary-line' },
      `latest  ${shortSha(latest.latestSha)} · v${latest.latestVersion || '?'} · ${latest.behind || 0} commits behind`));
  }

  const stepsHost = el('div', { class: 'update-modal__steps' });
  const stepRows = new Map<string, StepRow>();
  for (const name of STEP_ORDER) {
    const row = createStepRow(name);
    stepRows.set(name, row);
    stepsHost.appendChild(row.node);
  }

  const statusEl = el('div', { class: 'update-modal__status update-modal__status--running' }, 'connecting...') as HTMLElement;
  const dismissBtn = el('button', {
    type: 'button',
    class: 'btn update-modal__dismiss',
    onclick: () => close(),
  }, 'close') as HTMLButtonElement;
  dismissBtn.hidden = true;
  const footer = el('div', { class: 'update-modal__footer' }, statusEl, dismissBtn);

  const card = el('div', { class: 'update-modal__card' },
    el('div', { class: 'update-modal__head' },
      el('div', { class: 'update-modal__title' }, 'updating grok-remote'),
      closeBtn,
    ),
    headerSummary,
    stepsHost,
    footer,
  );
  const backdrop = el('div', { class: 'update-modal' }, card) as HTMLElement;
  document.body.appendChild(backdrop);

  try {
    localStorage.setItem('grok-remote.update.beforeVersion', beforeVersion || '');
    localStorage.setItem('grok-remote.update.beforeSha', beforeSha || '');
  } catch { /* ignore */ }

  let aborted = false;
  let healthTimer: ReturnType<typeof setTimeout> | null = null;
  let healthDeadline = 0;
  const abortCtl = new AbortController();

  function close(): void {
    aborted = true;
    try { abortCtl.abort(); } catch { /* ignore */ }
    if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
    if (backdrop.isConnected) backdrop.remove();
  }

  function setStatus(text: string, kind?: 'running' | 'ok' | 'fail'): void {
    statusEl.textContent = text;
    statusEl.className = `update-modal__status update-modal__status--${kind || 'running'}`;
  }

  function applyEvent(ev: UpdateStepEvent | null | undefined): void {
    const step = ev && ev.step;
    const status = ev && ev.status;
    if (!step) return;
    if (step === 'open') {
      setStatus('streaming update...', 'running');
      return;
    }
    if (step === 'done') {
      if (status === 'fail') {
        setStatus(`update failed: ${ev?.detail || 'unknown error'}`, 'fail');
        dismissBtn.hidden = false;
      } else {
        setStatus('update applied; waiting for server', 'running');
      }
      return;
    }
    const row = stepRows.get(step);
    if (!row) return;
    if (status === 'start') row.start(ev?.detail);
    else if (status === 'log') row.appendLog(ev?.detail);
    else if (status === 'ok') row.markOk(ev?.detail);
    else if (status === 'fail') row.markFail(ev?.detail);
    else if (status === 'skip') row.markSkip(ev?.detail);
  }

  (async () => {
    let res: Response;
    try {
      res = await fetch(api.version.updateUrl(), {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        signal: abortCtl.signal,
      });
    } catch (err) {
      if (aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`could not start update: ${msg}`, 'fail');
      dismissBtn.hidden = false;
      return;
    }
    if (res.status === 409) {
      setStatus('an update is already in progress in another tab. close it and try again.', 'fail');
      dismissBtn.hidden = false;
      return;
    }
    if (!res.ok || !res.body) {
      setStatus(`update endpoint failed: HTTP ${res.status}`, 'fail');
      dismissBtn.hidden = false;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let restartStarted = false;

    function processFrame(frame: string): void {
      const dataLines: string[] = [];
      for (const ln of frame.split('\n')) {
        if (ln.startsWith('data: ')) dataLines.push(ln.slice(6));
        else if (ln.startsWith('data:')) dataLines.push(ln.slice(5));
      }
      if (!dataLines.length) return;
      let payload: UpdateStepEvent;
      try { payload = JSON.parse(dataLines.join('\n')) as UpdateStepEvent; }
      catch { return; }
      if (payload && payload.step === 'restart' && payload.status === 'start') {
        restartStarted = true;
      }
      applyEvent(payload);
    }

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.trim()) processFrame(frame);
        }
      }
    } catch (err) {
      if (!aborted && !restartStarted) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(`stream interrupted: ${msg}`, 'fail');
        dismissBtn.hidden = false;
        return;
      }
    }
    if (aborted) return;
    if (restartStarted) {
      const row = stepRows.get('restart');
      if (row) row.markWaiting('waiting for server to come back...');
      setStatus('waiting for server to come back...', 'running');
      startHealthPoll();
    } else {
      dismissBtn.hidden = false;
    }
  })();

  function startHealthPoll(): void {
    const TIMEOUT_MS = 30_000;
    healthDeadline = Date.now() + TIMEOUT_MS;
    const tick = async (): Promise<void> => {
      if (aborted) return;
      if (Date.now() > healthDeadline) {
        setStatus('server did not come back in 30s. check `pm2 logs grok-remote`.', 'fail');
        const row = stepRows.get('restart');
        if (row) row.markFail('did not recover within 30s');
        dismissBtn.hidden = false;
        return;
      }
      let healthy = false;
      try {
        const r = await fetch('/api/health', { cache: 'no-store' });
        if (r.ok) healthy = true;
      } catch { /* server still down */ }
      if (healthy) {
        try {
          const v = await api.version.current() as { gitSha?: string; version?: string };
          if (v && v.gitSha && beforeSha && v.gitSha !== beforeSha) {
            try {
              localStorage.setItem('grok-remote.update.justUpdatedTo', v.version || '');
            } catch { /* ignore */ }
            const row = stepRows.get('restart');
            if (row) row.markOk(`booted ${v.gitSha.slice(0, 7)} (v${v.version || '?'})`);
            setStatus('reloading...', 'ok');
            setTimeout(() => location.reload(), 600);
            return;
          }
        } catch { /* keep polling */ }
      }
      healthTimer = setTimeout(tick, 1000);
    };
    healthTimer = setTimeout(tick, 1000);
  }

  return { close };
}

function shortSha(s: string | null | undefined): string {
  return s ? String(s).slice(0, 7) : '?';
}

function createStepRow(name: string): StepRow {
  const dot = el('span', { class: 'update-step__dot update-step__dot--idle' });
  const label = el('span', { class: 'update-step__label' }, STEP_LABELS[name] || name);
  const detail = el('span', { class: 'update-step__detail' }) as HTMLElement;
  const head = el('div', { class: 'update-step__head' }, dot, label, detail);
  const log = el('pre', { class: 'update-step__log', hidden: true }) as HTMLPreElement;
  const node = el('div', { class: 'update-step update-step--idle' }, head, log) as HTMLElement;

  let buf = '';

  function setState(state: string): void {
    node.className = `update-step update-step--${state}`;
    (dot as HTMLElement).className  = `update-step__dot update-step__dot--${state}`;
  }
  function ensureLogVisible(): void {
    if (log.hidden) log.hidden = false;
  }

  return {
    node,
    start(text?: string): void {
      setState('running');
      detail.textContent = '';
      if (text) {
        ensureLogVisible();
        buf = text + '\n';
        log.textContent = buf;
      }
    },
    appendLog(chunk?: string): void {
      if (!chunk) return;
      ensureLogVisible();
      buf += String(chunk);
      if (buf.length > 64 * 1024) buf = buf.slice(buf.length - 64 * 1024);
      log.textContent = buf;
      log.scrollTop = log.scrollHeight;
    },
    markOk(text?: string): void {
      setState('ok');
      if (text) detail.textContent = text;
    },
    markFail(text?: string): void {
      setState('fail');
      ensureLogVisible();
      if (text) detail.textContent = text;
    },
    markSkip(text?: string): void {
      setState('skip');
      if (text) detail.textContent = text;
    },
    markWaiting(text?: string): void {
      setState('waiting');
      if (text) detail.textContent = text;
    },
  };
}
