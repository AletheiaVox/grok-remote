// Self-update modal: streams /api/version/update SSE events into a
// per-step log, then polls /api/health after the restart step until the
// new server comes back. On a successful sha change we reload the page.
//
// This file owns the modal lifecycle. Callers just call openUpdateModal({...}).

import { el } from '../lib/render.js';
import { iconHtml } from '../lib/icons';
import { api } from '../lib/api';

const STEP_LABELS = {
  open:      'connecting',
  preflight: 'preflight',
  fetch:     'git fetch origin main',
  pull:      'git pull --ff-only',
  install:   'npm install',
  build:     'npm run build',
  restart:   'pm2 restart',
  done:      'done',
};

const STEP_ORDER = ['preflight', 'fetch', 'pull', 'install', 'build', 'restart'];

export function openUpdateModal({ current, latest } = {}) {
  // Track the running sha BEFORE the update kicks off so we can compare
  // after the server restarts and tell whether the new code actually
  // booted.
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
  const stepRows = new Map();
  for (const name of STEP_ORDER) {
    stepRows.set(name, createStepRow(name));
    stepsHost.appendChild(stepRows.get(name).node);
  }

  // Footer: dismiss when finished, or live status while running.
  const statusEl = el('div', { class: 'update-modal__status update-modal__status--running' }, 'connecting...');
  const dismissBtn = el('button', {
    type: 'button',
    class: 'btn update-modal__dismiss',
    onclick: () => close(),
  }, 'close');
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
  const backdrop = el('div', { class: 'update-modal' }, card);
  document.body.appendChild(backdrop);

  // Persist the pre-update version so the post-reload toast can tell what
  // bumped. Cleared by the toast hook on next load.
  try {
    localStorage.setItem('grok-remote.update.beforeVersion', beforeVersion || '');
    localStorage.setItem('grok-remote.update.beforeSha', beforeSha || '');
  } catch { /* ignore */ }

  let aborted = false;
  let healthTimer = null;
  let healthDeadline = 0;
  const abortCtl = new AbortController();

  function close() {
    aborted = true;
    try { abortCtl.abort(); } catch { /* ignore */ }
    if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
    if (backdrop.isConnected) backdrop.remove();
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = `update-modal__status update-modal__status--${kind || 'running'}`;
  }

  function applyEvent(ev) {
    const step = ev && ev.step;
    const status = ev && ev.status;
    if (!step) return;
    if (step === 'open') {
      setStatus('streaming update...', 'running');
      return;
    }
    if (step === 'done') {
      // Final pseudo-step; rendered as overall status only.
      if (status === 'fail') {
        setStatus(`update failed: ${ev.detail || 'unknown error'}`, 'fail');
        dismissBtn.hidden = false;
      } else {
        // The restart row may already be telling us "waiting for server"; the
        // health poll will flip statuses when the new build comes back.
        setStatus('update applied; waiting for server', 'running');
      }
      return;
    }
    const row = stepRows.get(step);
    if (!row) return;
    if (status === 'start') row.start(ev.detail);
    else if (status === 'log') row.appendLog(ev.detail);
    else if (status === 'ok') row.markOk(ev.detail);
    else if (status === 'fail') row.markFail(ev.detail);
    else if (status === 'skip') row.markSkip(ev.detail);
  }

  // ── Stream + parser ─────────────────────────────────────────────────
  // We use fetch + ReadableStream because EventSource only does GET, and
  // the endpoint is POST. The wire format is plain SSE; we parse it by
  // hand. Each `event: update / data: <json>` pair becomes an applyEvent.
  (async () => {
    let res;
    try {
      res = await fetch(api.version.updateUrl(), {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        signal: abortCtl.signal,
      });
    } catch (err) {
      if (aborted) return;
      setStatus(`could not start update: ${err.message}`, 'fail');
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

    function processFrame(frame) {
      // SSE frame: lines separated by \n, terminated by an empty line. We
      // only care about `data:` lines. Multi-line data values are joined
      // by newlines per spec.
      let dataLines = [];
      for (const ln of frame.split('\n')) {
        if (ln.startsWith('data: ')) dataLines.push(ln.slice(6));
        else if (ln.startsWith('data:')) dataLines.push(ln.slice(5));
      }
      if (!dataLines.length) return;
      let payload;
      try { payload = JSON.parse(dataLines.join('\n')); }
      catch { return; }
      if (payload && payload.step === 'restart' && payload.status === 'start') {
        restartStarted = true;
      }
      applyEvent(payload);
    }

    try {
      // Loop reading chunks. The body may end naturally (success) or be
      // cut short by pm2 SIGTERMing the server during restart; both are
      // expected. The catch below treats them the same.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are terminated by a blank line. Split on \n\n.
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.trim()) processFrame(frame);
        }
      }
    } catch (err) {
      // Connection died. If the restart step had already fired, this is
      // the expected outcome; fall through to the health poll.
      if (!aborted && !restartStarted) {
        setStatus(`stream interrupted: ${err.message}`, 'fail');
        dismissBtn.hidden = false;
        return;
      }
    }
    if (aborted) return;
    if (restartStarted) {
      // Mark the restart row as waiting and start polling /api/health.
      const row = stepRows.get('restart');
      if (row) row.markWaiting('waiting for server to come back...');
      setStatus('waiting for server to come back...', 'running');
      startHealthPoll();
    } else {
      // Stream ended without restart; the server may have logged an early
      // failure. The "done" event sets the final status above.
      dismissBtn.hidden = false;
    }
  })();

  function startHealthPoll() {
    const TIMEOUT_MS = 30_000;
    healthDeadline = Date.now() + TIMEOUT_MS;
    const tick = async () => {
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
          const v = await api.version.current();
          if (v && v.gitSha && beforeSha && v.gitSha !== beforeSha) {
            // New code is up. Persist the new version for the toast on reload.
            try {
              localStorage.setItem('grok-remote.update.justUpdatedTo', v.version || '');
            } catch { /* ignore */ }
            const row = stepRows.get('restart');
            if (row) row.markOk(`booted ${v.gitSha.slice(0, 7)} (v${v.version || '?'})`);
            setStatus('reloading...', 'ok');
            setTimeout(() => location.reload(), 600);
            return;
          }
          // Server is up but on the old sha. Keep polling: pm2 may still be
          // in the middle of cycling.
        } catch { /* ignore parse failures, keep polling */ }
      }
      healthTimer = setTimeout(tick, 1000);
    };
    healthTimer = setTimeout(tick, 1000);
  }

  return { close };
}

function shortSha(s) {
  return s ? String(s).slice(0, 7) : '?';
}

function createStepRow(name) {
  const dot = el('span', { class: 'update-step__dot update-step__dot--idle' });
  const label = el('span', { class: 'update-step__label' }, STEP_LABELS[name] || name);
  const detail = el('span', { class: 'update-step__detail' });
  const head = el('div', { class: 'update-step__head' }, dot, label, detail);
  const log = el('pre', { class: 'update-step__log', hidden: true });
  const node = el('div', { class: 'update-step update-step--idle' }, head, log);

  let buf = '';

  function setState(state) {
    node.className = `update-step update-step--${state}`;
    dot.className  = `update-step__dot update-step__dot--${state}`;
  }
  function ensureLogVisible() {
    if (log.hidden) log.hidden = false;
  }

  return {
    node,
    start(text) {
      setState('running');
      detail.textContent = '';
      if (text) {
        ensureLogVisible();
        buf = text + '\n';
        log.textContent = buf;
      }
    },
    appendLog(chunk) {
      if (!chunk) return;
      ensureLogVisible();
      buf += String(chunk);
      // Trim the log buffer so a chatty npm install doesn't grow forever.
      if (buf.length > 64 * 1024) buf = buf.slice(buf.length - 64 * 1024);
      log.textContent = buf;
      log.scrollTop = log.scrollHeight;
    },
    markOk(text) {
      setState('ok');
      if (text) detail.textContent = text;
    },
    markFail(text) {
      setState('fail');
      ensureLogVisible();
      if (text) detail.textContent = text;
    },
    markSkip(text) {
      setState('skip');
      if (text) detail.textContent = text;
    },
    markWaiting(text) {
      setState('waiting');
      if (text) detail.textContent = text;
    },
  };
}
