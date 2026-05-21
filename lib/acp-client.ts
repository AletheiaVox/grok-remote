// One ACP client per grok agent stdio process.
//
// Responsibilities:
//   - Spawn `grok agent --no-leader --always-approve stdio`.
//   - Drive the handshake (initialize + session/new).
//   - Read stdout line by line as JSON-RPC frames.
//   - Resolve responses to our outgoing requests.
//   - Dispatch agent->client requests to the host modules.
//   - Emit high-level events.

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

import { createTerminalHost, type TerminalHost } from './terminal-host.js';
import { createFsHost, type FsHost } from './fs-host.js';
import { createPermissionHost, type PermissionHost } from './permission-host.js';

const GROK_BIN = process.env['GROK_BIN'] || 'grok';

export interface AcpClientSettings {
  model?: string;
  reasoningEffort?: string;
  systemPromptOverride?: string;
  rules?: string;
  tools?: string;
  disallowedTools?: string;
  allow?: string[];
  deny?: string[];
  worktree?: boolean | string;
  sandbox?: string;
  alwaysApprove?: boolean;
  [key: string]: unknown;
}

export interface AcpClientInit {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  modelHint?: string | null;
  settings?: AcpClientSettings | null;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: never;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse | (JsonRpcRequest & JsonRpcResponse);

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  method: string;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
}

export interface AcpStatusExtra { [key: string]: unknown; }

export class AcpClient extends EventEmitter {
  cwd: string;
  env: NodeJS.ProcessEnv;
  modelHint: string | null;
  settings: AcpClientSettings | null;

  proc: ChildProcess | null = null;
  sessionId: string | null = null;
  handshake: unknown = null;
  modelId: string | null = null;
  availableCommands: unknown[] = [];
  status: string = 'starting';
  lastError: string | null = null;
  exitInfo: ExitInfo | null = null;

  terminalHost: TerminalHost;
  fsHost: FsHost;
  permissionHost: PermissionHost;

  private _pending = new Map<string | number, PendingRpc>();
  private _nextId = 1;
  private _closing = false;
  protected _activePromptId: string | null = null;

  constructor({ cwd, env, modelHint, settings }: AcpClientInit) {
    super();
    this.cwd = cwd;
    this.env = env || process.env;
    this.modelHint = modelHint || null;
    this.settings = settings && typeof settings === 'object' ? settings : null;

    this.terminalHost = createTerminalHost({ getCwd: () => this.cwd });
    this.fsHost = createFsHost({ getCwd: () => this.cwd });
    this.permissionHost = createPermissionHost();
  }

  private _buildArgv(): string[] {
    const top: string[] = [];
    const s = this.settings || {};

    const modelOverride = typeof s.model === 'string' ? s.model.trim() : '';
    const model = modelOverride || (typeof this.modelHint === 'string' ? this.modelHint.trim() : '');
    if (model) top.push('-m', model);

    if (typeof s.reasoningEffort === 'string' && s.reasoningEffort.trim()) {
      top.push('--reasoning-effort', s.reasoningEffort.trim());
    }
    if (typeof s.systemPromptOverride === 'string' && s.systemPromptOverride.length > 0) {
      top.push('--system-prompt-override', s.systemPromptOverride);
    }
    if (typeof s.rules === 'string' && s.rules.length > 0) {
      top.push('--rules', s.rules);
    }
    if (typeof s.tools === 'string' && s.tools.trim()) {
      top.push('--tools', s.tools.trim());
    }
    if (typeof s.disallowedTools === 'string' && s.disallowedTools.trim()) {
      top.push('--disallowed-tools', s.disallowedTools.trim());
    }
    if (Array.isArray(s.allow)) {
      for (const rule of s.allow) {
        if (typeof rule === 'string' && rule.trim()) top.push('--allow', rule.trim());
      }
    }
    if (Array.isArray(s.deny)) {
      for (const rule of s.deny) {
        if (typeof rule === 'string' && rule.trim()) top.push('--deny', rule.trim());
      }
    }
    if (typeof s.sandbox === 'string' && s.sandbox.trim()) {
      top.push('--sandbox', s.sandbox.trim());
    }
    if (typeof s.worktree === 'string' && s.worktree.trim()) {
      top.push('-w', s.worktree.trim());
    } else if (s.worktree === true) {
      top.push('-w');
    }

    const alwaysApprove = s.alwaysApprove === false ? false : true;
    const agentFlags: string[] = ['agent', '--no-leader'];
    if (alwaysApprove) agentFlags.push('--always-approve');
    agentFlags.push('stdio');

    return [...top, ...agentFlags];
  }

  setStatus(s: string, extra?: AcpStatusExtra): void {
    this.status = s;
    this.emit('status', { status: s, ...(extra || {}) });
  }

  async start({ resumeSessionId = null }: { resumeSessionId?: string | null } = {}): Promise<void> {
    const argv = this._buildArgv();
    this.proc = spawn(
      GROK_BIN,
      argv,
      { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    this.proc.on('error', (err: Error) => {
      this.lastError = err.message;
      this.setStatus('errored', { error: err.message });
      this.emit('error', err);
    });

    this.proc.on('exit', (code, signal) => {
      this.exitInfo = { code, signal, at: Date.now() };
      this.setStatus('exited', { code, signal });
      this.emit('exit', this.exitInfo);
      this.terminalHost.shutdownAll();
      for (const [, pending] of this._pending) {
        pending.reject(new Error('agent exited'));
      }
      this._pending.clear();
    });

    this.proc.stderr?.on('data', (b: Buffer) => {
      this.emit('stderr', b.toString('utf8'));
    });

    if (!this.proc.stdout) throw new Error('grok stdio process has no stdout');
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line: string) => { void this._onLine(line); });

    try {
      await this._handshake(resumeSessionId);
      this.setStatus('idle');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.setStatus('errored', { error: msg });
      this.emit('error', err);
    }
  }

  private async _handshake(resumeSessionId: string | null): Promise<void> {
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    }) as { _meta?: { modelState?: { currentModelId?: string }; availableCommands?: unknown[] }; agentCapabilities?: { loadSession?: boolean } };
    this.handshake = init;
    const meta = init?._meta || {};
    this.modelId = meta?.modelState?.currentModelId || null;
    this.availableCommands = meta?.availableCommands || [];
    this.emit('handshake', init);

    const canLoad = !!init?.agentCapabilities?.loadSession;
    let loaded = false;
    if (resumeSessionId && canLoad) {
      try {
        await this.request('session/load', {
          sessionId: resumeSessionId,
          cwd: this.cwd,
          mcpServers: [],
        });
        this.sessionId = resumeSessionId;
        loaded = true;
        this.emit('session_ready', { sessionId: this.sessionId, resumed: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit('stderr', `session/load failed (${msg}); starting fresh session\n`);
      }
    }
    if (!loaded) {
      const ns = await this.request('session/new', {
        cwd: this.cwd,
        mcpServers: [],
      }) as { sessionId?: string };
      if (!ns?.sessionId) throw new Error('session/new did not return sessionId');
      this.sessionId = ns.sessionId;
      this.emit('session_ready', { sessionId: this.sessionId, resumed: false });
    }
  }

  private _send(msg: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (!this.proc || !this.proc.stdin?.writable) {
      throw new Error('agent stdin not writable');
    }
    this.emit('rpc_send', msg);
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = `c-${this._nextId++}`;
    return new Promise<unknown>((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this._send({ jsonrpc: '2.0', method, params });
  }

  private async _onLine(line: string): Promise<void> {
    if (!line) return;
    let msg: JsonRpcMessage;
    try { msg = JSON.parse(line) as JsonRpcMessage; }
    catch {
      this.emit('error', new Error(`non-json frame: ${line.slice(0, 120)}`));
      return;
    }
    this.emit('rpc_recv', msg);

    // `Partial<JsonRpcRequest & JsonRpcResponse>` collapses to never because
    // JsonRpcResponse declares `method?: never`. Use an explicit ad-hoc shape
    // covering every JSON-RPC field we read in this dispatcher.
    const anyMsg = msg as {
      id?: string | number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    if (anyMsg.id != null && (anyMsg.result !== undefined || anyMsg.error !== undefined) && !anyMsg.method) {
      const p = this._pending.get(anyMsg.id);
      if (p) {
        this._pending.delete(anyMsg.id);
        if (anyMsg.error) {
          const e = new Error(anyMsg.error.message || 'rpc error') as Error & { rpc?: unknown };
          e.rpc = anyMsg.error;
          p.reject(e);
        } else {
          p.resolve(anyMsg.result);
        }
      }
      return;
    }

    if (anyMsg.id != null && anyMsg.method) {
      this.emit('request', msg);
      try {
        const result = await this._dispatch(anyMsg.method, anyMsg.params);
        this._send({ jsonrpc: '2.0', id: anyMsg.id, result });
      } catch (err) {
        const e = err as { rpc?: { code: number; message: string }; message?: string };
        const rpc = e?.rpc && typeof e.rpc === 'object'
          ? e.rpc
          : { code: -32603, message: e?.message || 'internal error' };
        this._send({ jsonrpc: '2.0', id: anyMsg.id, error: rpc });
      }
      return;
    }

    if (anyMsg.method) {
      this.emit('notification', msg);
      if (anyMsg.method === 'session/update') {
        this.emit('update', anyMsg.params);
      } else if (anyMsg.method === '_x.ai/session/prompt_complete') {
        this.emit('prompt_complete', anyMsg.params);
      } else if (anyMsg.method.startsWith('_x.ai/')) {
        this.emit('x_notification', msg);
      }
    }
  }

  private async _dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'terminal/create':        return this.terminalHost.create(params as never);
      case 'terminal/output':        return this.terminalHost.output(params as never);
      case 'terminal/wait_for_exit': return this.terminalHost.waitForExit(params as never);
      case 'terminal/kill':          return this.terminalHost.kill(params as never);
      case 'terminal/release':       return this.terminalHost.release(params as never);
      case 'fs/read_text_file':      return this.fsHost.readTextFile(params as never);
      case 'fs/write_text_file':     return this.fsHost.writeTextFile(params as never);
      case 'session/request_permission':
        return this.permissionHost.requestPermission(params);
      default: {
        const err = new Error(`Method not found: ${method}`) as Error & { rpc?: { code: number; message: string } };
        err.rpc = { code: -32601, message: `Method not found: ${method}` };
        throw err;
      }
    }
  }

  async prompt(textOrBlocks: string | unknown[]): Promise<unknown> {
    if (!this.sessionId) throw new Error('session not ready');
    let prompt: unknown[];
    if (Array.isArray(textOrBlocks)) {
      prompt = textOrBlocks;
    } else {
      prompt = [{ type: 'text', text: String(textOrBlocks) }];
    }
    this.setStatus('running');
    try {
      const result = await this.request('session/prompt', {
        sessionId: this.sessionId,
        prompt,
      });
      this.setStatus('idle');
      this.emit('prompt_result', result);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus('errored', { error: msg });
      throw err;
    }
  }

  async cancel(): Promise<{ cancelled: boolean; reason?: string; result?: unknown; fallback?: string; error?: string }> {
    if (!this.sessionId) return { cancelled: false, reason: 'no session' };
    try {
      const result = await this.request('session/cancel', { sessionId: this.sessionId });
      return { cancelled: true, result };
    } catch (err) {
      try {
        this.notify('session/cancel', { sessionId: this.sessionId });
      } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      return { cancelled: true, fallback: 'notification', error: msg };
    }
  }

  async shutdown(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (this._closing) return;
    this._closing = true;
    this.terminalHost.shutdownAll();
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(signal); } catch { /* ignore */ }
      const proc = this.proc;
      const timer = setTimeout(() => {
        if (proc.exitCode == null && !proc.killed) {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 2000);
      timer.unref?.();
    }
  }
}
