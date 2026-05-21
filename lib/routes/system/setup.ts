// setup routes. Wraps `grok setup`.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { send } from '../helpers.js';
import {
  runGrok,
  runGrokJson,
  GrokCliError,
  errorToResponse,
} from '../../grok-cli.js';
import type { RouteRegistrar } from '../system.js';

export function register(add: RouteRegistrar): void {
  add('POST', '/api/system/setup', runHandler);
}

const SETUP_TIMEOUT_MS = 90_000;
const SETUP_MAX_BYTES  = 2 * 1024 * 1024;

type SetupKind = 'no-deployment-key' | 'ok' | 'error';

interface SetupOutputs {
  code: number | null;
  stdout: string;
  stderr: string;
}

function classifySetupOutput({ code, stdout, stderr }: SetupOutputs): SetupKind {
  const blob = `${stderr || ''}\n${stdout || ''}`;
  if (code !== 0 && /GROK_DEPLOYMENT_KEY is not set/i.test(blob)) {
    return 'no-deployment-key';
  }
  if (code === 0) return 'ok';
  return 'error';
}

function firstMeaningfulLine(text: string | null | undefined): string {
  if (!text) return '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line) return line;
  }
  return '';
}

async function runHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  let result: SetupOutputs | null = null;
  let setupError: GrokCliError | null = null;

  try {
    const r = await runGrok(['setup'], {
      timeoutMs: SETUP_TIMEOUT_MS,
      maxBytes:  SETUP_MAX_BYTES,
    });
    result = { code: r.code, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    if (err instanceof GrokCliError) {
      setupError = err;
      result = {
        stdout: err.stdout || '',
        stderr: err.stderr || '',
        code:   err.code   ?? null,
      };
    } else {
      send(res, 500, errorToResponse(err));
      return;
    }
  }

  const kind = classifySetupOutput({
    code:   result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  });

  const ok = kind === 'ok' || kind === 'no-deployment-key';

  let inspect: unknown = null;
  let inspectError: string | null = null;
  try {
    inspect = await runGrokJson(['inspect', '--json'], {
      timeoutMs: 15_000,
      maxBytes:  1 * 1024 * 1024,
    });
  } catch (err) {
    inspectError = err instanceof Error ? err.message : String(err);
  }

  const firstLine =
    firstMeaningfulLine(result.stderr) ||
    firstMeaningfulLine(result.stdout) ||
    (setupError ? setupError.message : '');

  send(res, 200, {
    ok,
    kind,
    exitCode: result.code ?? 0,
    stdout:   result.stdout || '',
    stderr:   result.stderr || '',
    summary:  firstLine,
    inspect,
    inspectError,
    error:    setupError ? setupError.message : null,
  });
}
