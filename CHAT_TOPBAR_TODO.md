# Chat topbar: pending changes (manual integration)

Done in this branch:
- Sidebar rows in `src/views/agents.js` no longer show the model badge.
- Sidebar rows no longer show the inline connect/disconnect button.
- Sidebar rows no longer show `agent.cwd` underneath the row meta.

Outstanding work, lives in `src/views/chat.js` (touched by another agent in parallel; not modified here):

1. Surface `cwd` in the conversation header (topbar) so users still see it after it leaves the sidebar.
   - Suggested place: the row that already shows the title + status pill.
   - Render as a small muted breadcrumb. Truncate the middle with an ellipsis if it's wider than the available space, but keep the basename visible.
   - Tooltip with the full path. Add a "copy cwd" affordance (the existing info-grid in chat.js has `copyValueBtn` you can reuse).

2. Surface connect / disconnect in the conversation header.
   - It already exists in the info-grid via the lifecycle controls (status pill + dropdown menu) but the user expects a single-click button next to the conversation title.
   - Use the same status logic as `agent-link` from `src/views/agents.js`:
     - When `agent.status` is `disconnected` or `exited`: label "connect", call `api.connect(id)`.
     - Otherwise: label "disconnect", call `api.disconnect(id)`.
   - Reuse the `.agent-link` / `.agent-link--off` styles already in `src/style.css`.

3. After moving the cwd display, drop the (now duplicate) info-grid `cwd` row inside the conversation info panel if you want, or leave it: it's a deeper detail view and is fine to keep.

No backend changes needed. `api.connect` / `api.disconnect` / `api.updateAgent` already exist.
