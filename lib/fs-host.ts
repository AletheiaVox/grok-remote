// Implements fs/read_text_file and fs/write_text_file.
// Scoped to the agent's working directory so a misbehaving agent can't escape.

import fs from 'node:fs/promises';
import path from 'node:path';

export interface RpcError extends Error {
  rpc: { code: number; message: string };
}

export interface ReadTextFileParams {
  path?: string;
  limit?: number;
  line?: number;
}

export interface ReadTextFileResult {
  content: string;
}

export interface WriteTextFileParams {
  path?: string;
  content?: string;
}

export interface FsHostOptions {
  getCwd: () => string | null | undefined;
}

export interface FsHost {
  readTextFile(params: ReadTextFileParams): Promise<ReadTextFileResult>;
  writeTextFile(params: WriteTextFileParams): Promise<Record<string, never>>;
}

function withinScope(scopeDir: string | null | undefined, target: string): boolean {
  if (!scopeDir) return true;
  const scope = path.resolve(scopeDir);
  const resolved = path.resolve(target);
  // Allow exact scope dir match plus any descendant.
  return resolved === scope || resolved.startsWith(scope + path.sep);
}

function rpcError(code: number, message: string): RpcError {
  const err = new Error(message) as RpcError;
  err.rpc = { code, message };
  return err;
}

export function createFsHost({ getCwd }: FsHostOptions): FsHost {
  function resolveAndCheck(p: unknown): string {
    if (typeof p !== 'string' || !p.length) {
      throw rpcError(-32602, 'path must be a non-empty string');
    }
    const scope = getCwd();
    const abs = path.isAbsolute(p) ? p : path.resolve(scope || process.cwd(), p);
    if (!withinScope(scope, abs)) {
      throw rpcError(-32002, `path escapes agent scope: ${p}`);
    }
    return abs;
  }

  return {
    async readTextFile(params: ReadTextFileParams): Promise<ReadTextFileResult> {
      const target = resolveAndCheck(params?.path);
      const content = await fs.readFile(target, 'utf8');
      const limit = params?.limit;
      const line = params?.line;
      if (typeof line === 'number' || typeof limit === 'number') {
        const lines = content.split('\n');
        const start = Math.max(0, (line || 1) - 1);
        const end = typeof limit === 'number' ? start + limit : lines.length;
        return { content: lines.slice(start, end).join('\n') };
      }
      return { content };
    },

    async writeTextFile(params: WriteTextFileParams): Promise<Record<string, never>> {
      const target = resolveAndCheck(params?.path);
      const content = params?.content;
      if (typeof content !== 'string') {
        throw rpcError(-32602, 'content must be a string');
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
      return {};
    },
  };
}
