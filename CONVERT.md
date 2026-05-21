# TypeScript conversion plan

This document tracks the full migration of grok-remote from JavaScript /
JSX to TypeScript. Each file is listed with its target file name, the
phase it lands in, and a status flag. Iterations of `/loop 15m …`
should pick up where the previous one left off; the status table is
the source of truth.

## Goals

- Every file in `src/`, `lib/`, `server.js`, `installer.js`, `bin/`,
  and `test/` lands in TypeScript with explicit types on public APIs.
- Strict mode enabled (`strict: true`, `noUncheckedIndexedAccess: true`).
- `npm run build` still produces a working frontend bundle.
- `npm test` keeps passing the existing 24 unit tests and gains new
  coverage as files are converted.
- Optional integration tests boot the server binary and curl the
  public endpoints (`/api/health`, `/api/version/*`, `/api/agents`, ...);
  these run locally only because they need a logged-in `grok` CLI.

## Tooling decisions

- **Frontend**: Vite handles `.ts` and `.tsx` natively; no build script
  changes required beyond extension renames. `@vitejs/plugin-react`
  is already installed and handles JSX/TSX (flow page).
- **Backend**: compile with `tsc` to `build/` (CommonJS-shaped ESM,
  preserving `"type": "module"` in package.json). Use `tsx` for dev so
  `npm run dev:server` can run TS directly without a build step. Prod
  scripts (`pm2:start`, `gr start`) point at `build/server.js`.
- **Module shape**: `"module": "NodeNext"` for `lib/**` (so we keep the
  `.js` extension in imports, matching Node's resolution). Frontend
  uses `"module": "ESNext"` with `"moduleResolution": "bundler"`.
- **Strictness**: `strict: true`, `noUncheckedIndexedAccess: true`,
  `noImplicitOverride: true`. Leave `allowJs: true` during migration
  so unconverted files still type-check at the import surface; flip
  to `false` once everything is `.ts`.
- **Tests**: keep `node --test` runner. Convert `.test.js` to
  `.test.ts`, run through `tsx --test`. Add a new
  `test/integration/*.test.ts` that boots `build/server.js` via
  `spawn`, polls `/api/health`, and exercises a few endpoints.

## Phase order

Lowest-blast-radius first. Each phase commits at least once so we can
bisect if anything regresses.

| Phase | Scope                                                  |
|-------|--------------------------------------------------------|
| 0     | tsconfig, deps, scripts, smoke build                   |
| 1     | leaf utilities (no internal deps)                      |
| 2     | server-side support libs                               |
| 3     | server route handlers                                  |
| 4     | top-level server / installer / bin                     |
| 5     | frontend lib + small views                             |
| 6     | system pages                                           |
| 7     | the heavy hitters (chat.js, render.js, flow.jsx)       |
| 8     | tests: convert + expand                                |
| 9     | integration tests against the running binary           |
| 10    | flip allowJs off, final sweep, delete dead JS          |

## File inventory

Status legend: `[ ]` pending · `[x]` converted · `[!]` blocked (note) ·
`[skip]` keep as-is (e.g. CommonJS config, service worker).

### Phase 0 — config

| Status | File                          | Target                          | Notes |
|--------|-------------------------------|----------------------------------|-------|
| [x]    | tsconfig.json (new)           | tsconfig.json                    | strict, NodeNext for lib, bundler for src |
| [x]    | tsconfig.server.json (new)    | for `tsc` emit of backend        | extends root; `outDir: build` |
| [x]    | package.json (edit)           | add scripts + devDeps            | typescript, tsx, @types/node, @types/react, @types/react-dom |
| [skip] | ecosystem.config.cjs          | stays CommonJS                   | pm2 reads CJS; not worth converting |
| [x]    | vite.config.js                | vite.config.ts                   | trivial |

### Phase 1 — leaf utilities

| Status | File                          | Target                          |
|--------|-------------------------------|----------------------------------|
| [x]    | src/lib/format.js             | src/lib/format.ts                |
| [x]    | src/lib/themes.js             | src/lib/themes.ts                |
| [x]    | src/lib/copy.js               | src/lib/copy.ts                  |
| [x]    | src/lib/icons.js              | src/lib/icons.ts                 |
| [x]    | src/lib/sse.js                | src/lib/sse.ts                   |
| [x]    | src/lib/pwa.js                | src/lib/pwa.ts                   |
| [x]    | src/lib/image-lightbox.js     | src/lib/image-lightbox.ts        |
| [x]    | src/lib/intro-animation.js    | src/lib/intro-animation.ts       |
| [x]    | src/lib/slash-palette.js      | src/lib/slash-palette.ts         |
| [x]    | src/lib/attach-images.js      | src/lib/attach-images.ts         |
| [x]    | lib/sse.js                    | lib/sse.ts                       |
| [x]    | lib/install-mode.js           | lib/install-mode.ts              |
| [x]    | lib/launch.js                 | lib/launch.ts                    |
| [x]    | lib/dev-url.js                | lib/dev-url.ts                   |
| [x]    | lib/retention.js              | lib/retention.ts                 |

### Phase 2 — server-side support libs

| Status | File                          | Target                          |
|--------|-------------------------------|----------------------------------|
| [x]    | lib/settings.js               | lib/settings.ts                  |
| [x]    | lib/history.js                | lib/history.ts                   |
| [x]    | lib/version-update.js         | lib/version-update.ts            |
| [x]    | lib/grok-cli.js               | lib/grok-cli.ts                  |
| [x]    | lib/acp-client.js             | lib/acp-client.ts                |
| [x]    | lib/fs-host.js                | lib/fs-host.ts                   |
| [x]    | lib/terminal-host.js          | lib/terminal-host.ts             |
| [x]    | lib/permission-host.js        | lib/permission-host.ts           |
| [x]    | lib/trace-host.js             | lib/trace-host.ts                |
| [x]    | lib/agent-manager.js          | lib/agent-manager.ts             |

### Phase 3 — server route handlers

| Status | File                                | Target                              |
|--------|-------------------------------------|--------------------------------------|
| [x]    | lib/routes/helpers.js               | lib/routes/helpers.ts                |
| [x]    | lib/routes/system.js                | lib/routes/system.ts                 |
| [x]    | lib/routes/system/agents.js         | lib/routes/system/agents.ts          |
| [x]    | lib/routes/system/health.js         | lib/routes/system/health.ts          |
| [x]    | lib/routes/system/import.js         | lib/routes/system/import.ts          |
| [x]    | lib/routes/system/leaders.js        | lib/routes/system/leaders.ts         |
| [x]    | lib/routes/system/mcp.js            | lib/routes/system/mcp.ts             |
| [x]    | lib/routes/system/memory.js         | lib/routes/system/memory.ts          |
| [x]    | lib/routes/system/models.js         | lib/routes/system/models.ts          |
| [x]    | lib/routes/system/sessions.js       | lib/routes/system/sessions.ts        |
| [x]    | lib/routes/system/setup.js          | lib/routes/system/setup.ts           |
| [x]    | lib/routes/system/skills.js         | lib/routes/system/skills.ts          |
| [x]    | lib/routes/system/worktrees.js      | lib/routes/system/worktrees.ts       |

### Phase 4 — top-level server / installer / bin

| Status | File                          | Target                          |
|--------|-------------------------------|----------------------------------|
| [x]    | server.js                     | server.ts                        |
| [x]    | installer.js                  | installer.ts                     |
| [skip] | bin/gr                        | shebang script symlinked into PATH; converting requires `tsx` at every shell invocation. Left as JS so global `gr` stays a single, fast file. |
| [skip] | public/sw.js                  | service worker, browser-served as-is |
| [skip] | experiments/probe.js          | one-off scratch, leave alone     |

### Phase 5 — frontend lib + small views

| Status | File                              | Target                              |
|--------|-----------------------------------|--------------------------------------|
| [x]    | src/lib/api.js                    | src/lib/api.ts                       |
| [x]    | src/lib/version-footer.js         | src/lib/version-footer.ts            |
| [x]    | src/views/changelog-modal.js      | src/views/changelog-modal.ts         |
| [x]    | src/views/update-modal.js         | src/views/update-modal.ts            |
| [x]    | src/views/settings.js             | src/views/settings.ts                |
| [x]    | src/views/files.js                | src/views/files.ts                   |
| [x]    | src/views/agents.js               | src/views/agents.ts                  |
| [x]    | src/views/trace.js                | src/views/trace.ts                   |

### Phase 6 — system pages

| Status | File                                  | Target                                  |
|--------|---------------------------------------|------------------------------------------|
| [x]    | src/views/system/index.js             | src/views/system/index.ts                |
| [x]    | src/views/system/_native_common.js    | src/views/system/_native_common.ts       |
| [x]    | src/views/system/agents.js            | src/views/system/agents.ts               |
| [x]    | src/views/system/health.js            | src/views/system/health.ts               |
| [x]    | src/views/system/hooks.js             | src/views/system/hooks.ts                |
| [x]    | src/views/system/import.js            | src/views/system/import.ts               |
| [x]    | src/views/system/leaders.js           | src/views/system/leaders.ts              |
| [x]    | src/views/system/lsp.js               | src/views/system/lsp.ts                  |
| [x]    | src/views/system/marketplaces.js      | src/views/system/marketplaces.ts         |
| [x]    | src/views/system/mcp.js               | src/views/system/mcp.ts                  |
| [x]    | src/views/system/memory.js            | src/views/system/memory.ts               |
| [x]    | src/views/system/models.js            | src/views/system/models.ts               |
| [x]    | src/views/system/plugins.js           | src/views/system/plugins.ts              |
| [x]    | src/views/system/sessions.js          | src/views/system/sessions.ts             |
| [x]    | src/views/system/setup.js             | src/views/system/setup.ts                |
| [x]    | src/views/system/skills.js            | src/views/system/skills.ts               |
| [x]    | src/views/system/worktrees.js         | src/views/system/worktrees.ts            |
| [x]    | src/views/system/flow.js              | src/views/system/flow.ts                 |
| [x]    | src/views/system/flow.jsx             | src/views/system/flow.tsx                |

| [x]    | src/views/system/flow-floating-edge.jsx | src/views/system/flow-floating-edge.tsx |

### Phase 7 — heavy hitters

| Status | File                          | Target                          |
|--------|-------------------------------|----------------------------------|
| [x]    | src/lib/render.js             | src/lib/render.ts                |
| [x]    | src/views/chat.js             | src/views/chat.ts                |

| [x]    | src/main.js                   | src/main.ts                      |

### Phase 8 — tests

| Status | File                                  | Target                                  |
|--------|---------------------------------------|------------------------------------------|
| [x]    | test/install-mode.test.js             | test/install-mode.test.ts                |
| [x]    | test/launch.test.js                   | test/launch.test.ts                      |
| [x]    | test/user-attachments.test.js         | test/user-attachments.test.ts            |
| [x]    | (new)                                 | test/format.test.ts                      |
| [x]    | (new)                                 | test/dev-url.test.ts                     |
| [x]    | (new)                                 | test/copy.test.ts                        |
| [x]    | (new)                                 | test/themes.test.ts                      |
| [x]    | (new)                                 | test/icons.test.ts                       |
| [x]    | (new)                                 | test/sse-ring.test.ts                    |
| [x]    | (new)                                 | test/permission-host.test.ts             |
| [x]    | (new)                                 | test/routes-helpers.test.ts              |
| [x]    | (new)                                 | test/history-paths.test.ts               |
| [x]    | (new)                                 | test/sse-server.test.ts                  |
| [x]    | (new)                                 | test/grok-cli-error.test.ts              |
| [x]    | (new)                                 | test/retention.test.ts                   |
| [x]    | (new)                                 | test/render-pure.test.ts                 |
| [x]    | (new)                                 | test/fs-host.test.ts                     |
| [x]    | (new)                                 | test/sse-client.test.ts                  |
| [x]    | (new)                                 | test/terminal-host.test.ts               |
| [x]    | (new)                                 | test/agent-manager-helpers.test.ts       |
| [x]    | (new)                                 | test/agent-manager-bg.test.ts            |
| [x]    | (new)                                 | test/acp-payload.test.ts                 |
| [x]    | (new)                                 | test/flow-helpers.test.ts                |
| [ ]    | (new)                                 | test/render-todo.test.ts                 |
| [ ]    | (new)                                 | test/render-attachments.test.ts          |
| [ ]    | (new)                                 | test/agent-manager.test.ts               |
| [ ]    | (new)                                 | test/version-update.test.ts              |
| [ ]    | (new)                                 | test/routes-system.test.ts               |

### Phase 9 — integration tests against the running binary

Tests under `test/integration/` boot the compiled server via
`spawn(process.execPath, ['build/server.js'], ...)`, wait for
`/api/health` to return 200, then drive a handful of public
endpoints. They are skipped on CI (gated on
`process.env.RUN_LOCAL_INTEGRATION === '1'`) because they need a
logged-in `grok` CLI on the host.

| Status | Endpoint                            |
|--------|--------------------------------------|
| [x]    | GET /api/health                      | (test/integration/server-boot.test.ts) |
| [x]    | GET /api/hello                       | (test/integration/server-boot.test.ts) |
| [x]    | GET /api/version/current             | (test/integration/server-boot.test.ts) |
| [x]    | GET /api/unknown -> 404              | (test/integration/server-boot.test.ts) |
| [ ]    | GET /api/version/latest              | (network-dependent; skipped)            |
| [ ]    | GET /api/version/releases            | (network-dependent; skipped)            |
| [x]    | GET /api/agents                      | (test/integration/endpoints.test.ts)    |
| [x]    | GET /api/agents/stream (SSE smoke)   | (test/integration/endpoints.test.ts)    |
| [x]    | GET /api/settings                    | (test/integration/endpoints.test.ts)    |
| [x]    | PATCH /api/settings (no-op idempotency) | (test/integration/endpoints.test.ts) |
| [x]    | GET /api/system/health               | (test/integration/endpoints.test.ts)    |

### Phase 10 — final sweep

- [x] turn off `allowJs` in tsconfig (also dropped `.js`/`.jsx` globs from `include`)
- [x] delete any remaining `.js` files in `src/` and `lib/` (only `experiments/probe.js` left, already excluded)
- [x] update README's repo layout section (lib/ and src/ trees retyped + new modules listed)
- [x] document local integration test runner in README (Develop > Tests subsection)
- [x] remove `// @ts-nocheck` from `src/views/system/flow.tsx` and add real types
- [x] remove `// @ts-nocheck` from `src/views/chat.ts` and add real types
      (chat.ts: 103 field declarations + method param `any` annotations + catch
       `any` casts. flow.tsx had no implicit-any errors once the directive was
       removed because params were already explicit. typecheck clean, 246 tests
       pass, build clean.)
- [x] fix backlog of `tsc --noEmit` errors accumulated through phases 4-6
      (acp-client never-collapse, attach-images EventListener casts,
       version-footer LatestInfo, settings PageModule, mcp AddServerBody,
       worktrees Filters/GcState, render.ts PENDING_STYLE, main.ts callback)
      → `npm run typecheck` now clean (was 64 errors)

## How to iterate

When `/loop 15m …` fires:

1. Pull the latest from the branch (we never push, but local commits accumulate).
2. Open this file and find the **first row whose status is `[ ]`**.
3. Convert that file (or batch of small ones). Add explicit types on
   exports; let inference handle locals.
4. Run `npm run build` and `npm test` before flipping the status.
5. Flip the row to `[x]`, commit with a clear message, do NOT push.
6. If a file is blocked (needs another file converted first), mark it
   `[!]` with a one-line note and move on to the next.

This file IS the work queue. Don't rely on chat memory between
iterations.
