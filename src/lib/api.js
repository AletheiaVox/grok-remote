// Small fetch wrapper for the REST endpoints described in PROTOCOL.md.
// No external deps. Throws on non-2xx with the parsed body if available.

async function request(method, path, body) {
  const opts = {
    method,
    headers: { accept: 'application/json' },
  };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  const txt = await r.text();
  let data = null;
  if (txt) {
    try { data = JSON.parse(txt); }
    catch { data = txt; }
  }
  if (!r.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.body = data;
    throw err;
  }
  return data;
}

export const api = {
  hello:    ()                => request('GET',    '/api/hello'),
  health:   ()                => request('GET',    '/api/health'),
  models:   ()                => request('GET',    '/api/models'),

  listAgents:   ()            => request('GET',    '/api/agents'),
  agentsStreamUrl: ()         => '/api/agents/stream',
  getAgent:     (id)          => request('GET',    `/api/agents/${encodeURIComponent(id)}`),
  createAgent:  (body)        => request('POST',   '/api/agents', body || {}),
  deleteAgent:  (id)          => request('DELETE', `/api/agents/${encodeURIComponent(id)}`),
  updateAgent:  (id, patch)   => request('PATCH',  `/api/agents/${encodeURIComponent(id)}`, patch || {}),
  disconnect:   (id)          => request('POST',   `/api/agents/${encodeURIComponent(id)}/disconnect`),
  connect:      (id)          => request('POST',   `/api/agents/${encodeURIComponent(id)}/connect`),
  share:        (id)          => request('POST',   `/api/agents/${encodeURIComponent(id)}/publish`),
  runSetup:     ()            => request('POST',   '/api/system/setup'),
  prompt:       (id, textOrOpts) => {
    // Backwards compat: a plain string still works.
    const body = (textOrOpts && typeof textOrOpts === 'object')
      ? {
          text: String(textOrOpts.text || ''),
          ...(Array.isArray(textOrOpts.attachments) && textOrOpts.attachments.length
            ? { attachments: textOrOpts.attachments }
            : {}),
        }
      : { text: String(textOrOpts || '') };
    return request('POST', `/api/agents/${encodeURIComponent(id)}/prompt`, body);
  },
  cancel:       (id)          => request('POST',   `/api/agents/${encodeURIComponent(id)}/cancel`),
  history:      async (id, opts) => {
    const { turns, all } = opts || {};
    const qs = new URLSearchParams();
    if (all) qs.set('all', '1');
    if (typeof turns === 'number' && turns > 0) qs.set('turns', String(turns));
    const url = `/api/agents/${encodeURIComponent(id)}/history${qs.toString() ? `?${qs}` : ''}`;
    const r = await fetch(url, { headers: { accept: 'application/x-ndjson' } });
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    const text = await r.text();
    const events = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { events.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
    }
    return {
      events,
      totalTurns:    parseInt(r.headers.get('X-Total-Turns')    || '0', 10) || 0,
      returnedTurns: parseInt(r.headers.get('X-Returned-Turns') || '0', 10) || 0,
    };
  },
  listFiles:    (id, path)    => request('GET',    `/api/agents/${encodeURIComponent(id)}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  readFile:     (id, path)    => request('GET',    `/api/agents/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`),
  fileRawUrl:   (id, p)       => `/api/agents/${encodeURIComponent(id)}/files/raw?path=${encodeURIComponent(p || '')}`,
  trace:        (id)          => request('GET',    `/api/agents/${encodeURIComponent(id)}/trace`),

  terminals:    {
    list:   (id)          => request('GET',    `/api/agents/${encodeURIComponent(id)}/terminals`),
    read:   (id, tid)     => request('GET',    `/api/agents/${encodeURIComponent(id)}/terminals/${encodeURIComponent(tid)}`),
    kill:   (id, tid)     => request('POST',   `/api/agents/${encodeURIComponent(id)}/terminals/${encodeURIComponent(tid)}/kill`),
    global: ()            => request('GET',    '/api/bg-terminals'),
  },

  // Sub-agent (child) trace fetch. Sub-agents spawned via the Task tool run
  // in their own grok sessions, so their tool_call rows aren't on the
  // parent agent's stream. This shells out to `grok trace <sid>` server-side
  // and returns the same shape as api.trace(agentId).
  subagents: {
    trace: (sessionId) => request('GET', `/api/subagents/${encodeURIComponent(sessionId)}/trace`),
    // Fast direct read of the child session's updates.jsonl. Skips the
    // grok-trace shell-out + archive extraction so it succeeds while the
    // session dir is still being written. cwd is the parent agent's cwd
    // (sub-agents share the parent's cwd-keyed sessions root).
    updates: (sessionId, cwd) => {
      const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
      return request('GET', `/api/subagents/${encodeURIComponent(sessionId)}/updates${qs}`);
    },
  },

  getSettings:  ()            => request('GET',    '/api/settings'),
  patchSettings:(body)        => request('PATCH',  '/api/settings', body),

  folders: {
    list:   ()                  => request('GET',    '/api/folders'),
    create: (name)              => request('POST',   '/api/folders', { name }),
    update: (id, patch)         => request('PATCH',  `/api/folders/${encodeURIComponent(id)}`, patch || {}),
    remove: (id)                => request('DELETE', `/api/folders/${encodeURIComponent(id)}`),
    assignAgent: (agentId, folderId) =>
      request('PUT', `/api/agents/${encodeURIComponent(agentId)}/folder`, { folderId: folderId || null }),
  },

  mcp: {
    list:     ()      => request('GET',    '/api/system/mcp'),
    add:      (body)  => request('POST',   '/api/system/mcp', body || {}),
    remove:   (name)  => request('DELETE', `/api/system/mcp/${encodeURIComponent(name)}`),
    doctor:   (name)  => request('GET',    name
                                              ? `/api/system/mcp/${encodeURIComponent(name)}/doctor`
                                              : '/api/system/mcp/doctor'),
  },

  memory: {
    get:         ()             => request('GET',  '/api/system/memory'),
    clear:       (scope)        => request('POST', '/api/system/memory/clear', { scope }),
    read:        (p)            => request('GET',
      `/api/system/memory/read?path=${encodeURIComponent(p || '')}`),
    saveContent: (p, content)   => request('PUT',  '/api/system/memory/content',
      { path: p, content }),
    createFile:  (scope, name, content) => request('POST', '/api/system/memory/file',
      { scope, name, ...(typeof content === 'string' ? { content } : {}) }),
    deleteFile:  (p)            => request('DELETE',
      `/api/system/memory/file?path=${encodeURIComponent(p || '')}`),
  },

  skills: {
    list:     (opts) => {
      const qs = new URLSearchParams();
      if (opts && opts.includeArchived) qs.set('includeArchived', '1');
      const tail = qs.toString();
      return request('GET', `/api/system/skills${tail ? `?${tail}` : ''}`);
    },
    read:        (path)            => request('GET',  `/api/system/skills/read?path=${encodeURIComponent(path)}`),
    archive:     (scope, name)     => request('POST', '/api/system/skills/archive', { scope, name }),
    restore:     (scope, name)     => request('POST', '/api/system/skills/restore', { scope, name }),
    move:        (scope, name, toScope) => request('POST', '/api/system/skills/move', { scope, name, toScope }),
    saveContent: (scope, name, content) => request('PUT',  '/api/system/skills/content', { scope, name, content }),
    history:     (scope, name)     => request('GET',
      `/api/system/skills/history?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}`),
    historySnapshot: (scope, name, ts) => request('GET',
      `/api/system/skills/history/content?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}&ts=${encodeURIComponent(ts)}`),
    historyRestore: (scope, name, ts) => request('POST',
      '/api/system/skills/history/restore', { scope, name, ts }),
    use:        (name, agentId)    => request('POST', '/api/system/skills/use', { name, ...(agentId ? { agentId } : {}) }),
    usage:      ()                 => request('GET',  '/api/system/skills/usage'),
  },

  systemModels: {
    get:      ()      => request('GET',  '/api/system/models'),
  },

  // Subagents (worker profiles) live as .md files under
  // ~/.grok/agents/ or <cwd>/.grok/agents/. The list comes from `grok
  // inspect` via /api/system/health; this section covers read/write of
  // the individual files. Built-in subagents are not editable.
  systemAgents: {
    read:         (p)                       => request('GET',  `/api/system/agents/read?path=${encodeURIComponent(p || '')}`),
    saveContent:  (p, content)              => request('PUT',  '/api/system/agents/content', { path: p, content }),
    createFile:   (scope, name, content)    => request('POST', '/api/system/agents/file',
      { scope, name, ...(typeof content === 'string' ? { content } : {}) }),
    deleteFile:   (p)                       => request('DELETE',
      `/api/system/agents/file?path=${encodeURIComponent(p || '')}`),
  },

  systemHealth: {
    get:      ()      => request('GET',  '/api/system/health'),
    recheck:  ()      => request('POST', '/api/system/health/recheck'),
  },

  leaders: {
    list:          ()           => request('GET',  '/api/system/leaders'),
    info:          (pid)        => request('GET',  `/api/system/leaders/${encodeURIComponent(pid)}`),
    killAll:       ()           => request('POST', '/api/system/leaders/kill', {}),
    profileStatus: (pid)        => request('GET',  `/api/system/leaders/${encodeURIComponent(pid)}/profile/status`),
    profileStart:  (pid, body)  => request('POST', `/api/system/leaders/${encodeURIComponent(pid)}/profile/start`, body || {}),
    profileStop:   (pid, body)  => request('POST', `/api/system/leaders/${encodeURIComponent(pid)}/profile/stop`, body || {}),
  },

  worktrees: {
    list: (opts) => {
      const qs = new URLSearchParams();
      if (opts && opts.all)  qs.set('all',  '1');
      if (opts && opts.repo) qs.set('repo', String(opts.repo));
      if (opts && opts.type) qs.set('type', String(opts.type));
      const tail = qs.toString();
      return request('GET', `/api/system/worktrees${tail ? `?${tail}` : ''}`);
    },
    show: (id) => request('GET', `/api/system/worktrees/${encodeURIComponent(id)}`),
    rm: (id, opts) => {
      const qs = new URLSearchParams();
      if (opts && opts.force)  qs.set('force',  '1');
      if (opts && opts.dryRun) qs.set('dryRun', '1');
      const tail = qs.toString();
      return request('DELETE', `/api/system/worktrees/${encodeURIComponent(id)}${tail ? `?${tail}` : ''}`);
    },
    gc:        (body) => request('POST', '/api/system/worktrees/gc', body || {}),
    dbStats:   ()     => request('GET',  '/api/system/worktrees/db/stats'),
    dbPath:    ()     => request('GET',  '/api/system/worktrees/db/path'),
    dbRebuild: ()     => request('POST', '/api/system/worktrees/db/rebuild', {}),
  },

  sessions: {
    list: (opts) => {
      const { q, limit } = opts || {};
      const qs = new URLSearchParams();
      if (q && String(q).trim()) qs.set('q', String(q).trim());
      if (typeof limit === 'number' && limit > 0) qs.set('limit', String(limit));
      const tail = qs.toString();
      return request('GET', `/api/system/sessions${tail ? `?${tail}` : ''}`);
    },
  },

  // Named "importer" to avoid the reserved word `import` in callers.
  importer: {
    list: ()        => request('GET',  '/api/system/import'),
    run:  (targets) => request('POST', '/api/system/import', { targets: Array.isArray(targets) ? targets : [] }),
  },

  // Self-update. /api/version/update is a POST SSE stream; consumers should
  // use the URL with a fetch + ReadableStream, not this object.
  version: {
    current:    () => request('GET', '/api/version/current'),
    latest:     () => request('GET', '/api/version/latest'),
    diff:       () => request('GET', '/api/version/diff'),
    releases:   ({ force = false } = {}) =>
      request('GET', `/api/version/releases${force ? '?force=1' : ''}`),
    updateUrl:  () => '/api/version/update',
  },
};
