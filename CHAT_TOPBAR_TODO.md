# Chat topbar follow-up

The sidebar rows in `src/views/agents.ts` no longer show the agent `cwd`. The
plan was to relocate that information into the chat topbar so it is still
visible when you have a conversation selected, but `src/views/chat.ts` was
being edited by another agent in parallel and is off-limits in this PR.

When chat.ts lands, do the following:

1. In the chat topbar (the header row that already shows the conversation
   title, the model picker, and the star/settings cluster), add a small `cwd`
   chip immediately after the title or below it on a second line.
2. The chip should:
   - Show the same string the sidebar used to render (the raw `agent.cwd`).
   - Truncate with ellipsis when it overflows; `title=` the full path.
   - Be hidden when `agent.cwd` is empty.
   - Have a copy-to-clipboard affordance (re-use `src/lib/copy.ts`).
3. Keep it visually de-emphasized (muted color, smaller font). It is reference
   info, not a primary control.
4. Make sure the topbar still collapses nicely on narrow viewports.

No backend work is required for this; the cwd is already on the agent record
returned by `GET /api/agents/:id`.
