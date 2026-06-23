# Proposal: External Runs — tools to edit and remove runs / links

**Status:** Proposed
**Area:** External Runs (`apps/agor-daemon/src/mcp/tools/external-runs.ts`)

> Filed as a doc PR because Issues are disabled on this repo.

## Problem

The External Runs MCP surface is currently **append-only**. The tools are
`start`, `set_anchor`, `link`, `log`, `publish_summary`, `complete`, `get`,
`list`. Once a run exists, there is no way to **mutate** or **remove** any part
of it. Two concrete gaps hit in real use:

1. **Title / metadata is frozen at `start`.** A run opened with a generic or
   wrong title cannot be renamed. The only workaround is
   `complete(status: abandoned)` followed by starting a fresh run — which throws
   away the run's identity and timeline.
2. **Links are append-only with no removal.** `agor_external_run_link` appends
   an artefact (issue / PR / commit / branch / card / KB doc), but there is no
   unlink. A mistaken or hallucinated link is permanent, again forcing an
   abandon + restart of the whole run.

Both surfaced while logging back a native Claude Code session: a run was
started, links were added, then needed correcting. With no edit/unlink, the
only clean fix was to abandon the run and recreate it.

## Requested tools

- **`agor_external_run_update`** — patch mutable fields on a run. At minimum
  `title`; ideally `description` and the captured `git_*` / `host` context.
- **`agor_external_run_unlink`** — remove a previously added artefact link,
  addressed by `linkId` (preferred) or by `targetKind` + `targetRef`.
- **`agor_external_run_reopen`** _(optional)_ — move a terminal run
  (`completed` / `failed` / `abandoned`) back to `running`, so an accidental
  `complete` is recoverable without losing the run.

## Why it matters

Log-back is meant to be low-friction and forgiving, and the recommended
workflow is explicitly "start generic, refine as work lands". Today any mistake
in title or links forces a full abandon-and-restart, which fragments run
history and discourages correcting records. Edit + unlink make the surface safe
to use incrementally, matching the workflow the docs already recommend.

## Sketch

Repository methods likely live alongside the existing ones in
`packages/core/src/db/repositories/external-runs.ts`; tool registration in
`apps/agor-daemon/src/mcp/tools/external-runs.ts`. No schema change needed for
`update`/`reopen` (mutating existing columns); `unlink` is a delete on the
run-links table.
