// Setup page.

import { el } from '../../lib/render.js';

interface SetupResponse {
  ok?: boolean;
  kind?: string;
  exitCode?: number;
  summary?: string;
  error?: string;
  stderr?: string;
  stdout?: string;
  inspect?: unknown;
  inspectError?: string;
}

let activeContainer: HTMLElement | null = null;
let activeAbort: AbortController | null = null;

export function mount(container: HTMLElement): void {
  activeContainer = container;
  container.replaceChildren();

  const desc = el('div', { class: 'setup-desc' },
    el('p', null,
      'Fetches and installs the managed deployment configuration that ',
      'your organisation (or xAI) has bound this install to.'),
    el('p', null,
      'It downloads the managed bundle (config + agent profiles + MCP ',
      'servers + skill definitions) and merges it into your local config ',
      'while preserving user-only fields.'),
    el('p', null,
      'Re-running is idempotent: the same bundle will not be reapplied.'),
    el('p', null,
      'If you have no managed deployment configured (no ',
      el('code', null, 'GROK_DEPLOYMENT_KEY'),
      ' set and no ', el('code', null, '[endpoints].deployment_key'),
      ' in ', el('code', null, '~/.grok/config.toml'),
      '), grok will exit with an error explaining that. The dashboard ',
      'treats that as informational rather than a failure.'),
    el('p', { class: 'setup-desc-foot' },
      'After the run completes, ', el('code', null, 'grok inspect --json'),
      ' is invoked automatically so you can see the resulting configuration.'),
  );

  const runBtn = el('button', {
    class: 'btn btn--primary setup-run-btn',
    type: 'button',
    onclick: () => void runSetup(runBtn as HTMLButtonElement, resultHost as HTMLElement),
  }, 'Run grok setup') as HTMLButtonElement;

  const resultHost = el('div', { class: 'setup-result-host' }) as HTMLElement;

  const wrap = el('section', { class: 'system-page setup-page' },
    el('h2', { class: 'system-page-title' }, 'Setup'),
    el('p', { class: 'system-page-sub' },
      'Run the managed-deployment installer. Pulls the latest bundle and merges it into your local config.'),
    desc,
    el('div', { class: 'setup-actions' }, runBtn),
    resultHost,
  );

  container.appendChild(wrap);
}

export function unmount(): void {
  if (activeAbort) {
    try { activeAbort.abort(); } catch { /* ignore */ }
    activeAbort = null;
  }
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

async function runSetup(btn: HTMLButtonElement, resultHost: HTMLElement): Promise<void> {
  if (!btn || !resultHost) return;
  btn.disabled = true;
  const origLabel = btn.textContent;
  btn.textContent = 'running...';
  resultHost.replaceChildren(
    el('div', { class: 'setup-running' }, 'invoking grok setup; this may take a moment...'),
  );

  const abort = new AbortController();
  activeAbort = abort;
  try {
    const r = await fetch('/api/system/setup', {
      method: 'POST',
      headers: { accept: 'application/json' },
      signal: abort.signal,
    });
    const data = await r.json().catch(() => null) as SetupResponse | null;
    renderResult(resultHost, r.status, data);
  } catch (err) {
    if (err && (err as { name?: string }).name === 'AbortError') return;
    const msg = err instanceof Error ? err.message : String(err);
    resultHost.replaceChildren(
      el('div', { class: 'setup-error' },
        el('strong', null, 'request failed: '),
        msg),
    );
  } finally {
    if (activeAbort === abort) activeAbort = null;
    btn.disabled = false;
    btn.textContent = origLabel;
  }
}

function renderResult(host: HTMLElement, status: number, data: SetupResponse | null): void {
  host.replaceChildren();
  if (!data || typeof data !== 'object') {
    host.appendChild(el('div', { class: 'setup-error' },
      `unexpected response from server (HTTP ${status})`));
    return;
  }
  const kind = typeof data.kind === 'string' ? data.kind : (data.ok ? 'ok' : 'error');
  const exit = data.exitCode ?? '?';
  const summary = (typeof data.summary === 'string' && data.summary)
    || data.error
    || 'unknown error';

  let badge: string, headline: string, headMod: string;
  if (kind === 'ok') {
    badge    = 'success';
    headMod  = 'ok';
    headline = `grok setup completed (exit ${exit}).`;
  } else if (kind === 'no-deployment-key') {
    badge    = 'info';
    headMod  = 'info';
    headline = `no managed deployment configured (exit ${exit}). This is expected for individual users.`;
  } else {
    badge    = 'failed';
    headMod  = 'fail';
    headline = `grok setup failed (exit ${exit}): ${summary}`;
  }

  const head = el('div', { class: `setup-result-head setup-result-head--${headMod}` },
    el('span', { class: 'setup-result-badge' }, badge),
    el('span', { class: 'setup-result-summary' }, headline),
  );
  host.appendChild(head);

  if (data.stderr) {
    host.appendChild(buildOutputBlock('stderr', data.stderr));
  }
  if (data.stdout) {
    host.appendChild(buildOutputBlock('stdout', data.stdout));
  }

  if (data.inspect) {
    const pretty = JSON.stringify(data.inspect, null, 2);
    host.appendChild(buildOutputBlock('grok inspect --json (after setup)', pretty));
  } else if (data.inspectError) {
    host.appendChild(el('div', { class: 'setup-result-note' },
      el('strong', null, 'grok inspect: '),
      `unavailable (${data.inspectError})`,
    ));
  }
}

function buildOutputBlock(title: string, text: string): HTMLElement {
  const pre = el('pre', { class: 'setup-output-pre' }, text);
  return el('section', { class: 'setup-output' },
    el('header', { class: 'setup-output-head' },
      el('span', { class: 'setup-output-title' }, title),
    ),
    pre,
  ) as HTMLElement;
}
