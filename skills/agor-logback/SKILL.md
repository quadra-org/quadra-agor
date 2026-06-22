---
name: agor-logback
description: Log work done in this native Claude Code session back to the central Agor instance as a first-class External Run — structured events, links to work anchors (branch/PR/issue), and a curated Knowledge summary. Use when working outside an Agor-spawned session on anything the team should be able to trace. Trigger on "log this to agor", "start an external run", "record this work in agor", or at the start of any non-trivial coding task on a Quadra repo.
---

# Agor log-back (External Runs)

You are running in a **native** Claude Code session (not an Agor-spawned one).
Agor can't see this work automatically. Use the `agor_external_run_*` MCP tools
to leave a traceable record: a first-class **External Run** with a structured
event log, links to the branch/PR/issue, and a curated Knowledge summary.

Do NOT dump the transcript — this is structured events + a summary, not a
chat mirror.

## Prerequisite: the `agor` MCP server

These tools come from the `agor` MCP server pointed at the central instance.
Register it once (user scope) — see `references/setup.md`. Verify with
`claude mcp list` → `agor … ✔ Connected`. If it's not connected, tell the user
and stop; don't fake the log-back.

## When to call what

Lifecycle: **start → log\* → (set_anchor, link)\* → publish_summary? → complete.**

| Moment                                                                       | Tool                                                                                                                          |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Task kickoff (non-trivial work)                                              | `agor_external_run_start` — title + harness `claude-code` + git context (cwd, repo, branch, sha). Keep the returned `run_id`. |
| A meaningful checkpoint — a decision, milestone, or blocker (NOT every turn) | `agor_external_run_log` — `eventType: progress\|checkpoint\|error` + a one-line `message`.                                    |
| Once a branch exists for the work                                            | `agor_external_run_set_anchor` — `branchId` (preferred) or `cardId`.                                                          |
| When a PR / issue / commit appears                                           | `agor_external_run_link` — `targetKind` + `targetRef` (URL or id).                                                            |
| At completion (or a major checkpoint)                                        | publish a summary, then complete (below).                                                                                     |

### Self-pacing the event log

Log when something a teammate would care about happened. A 5-step refactor is
~1–3 events, not 15. Skip routine tool calls, file reads, and back-and-forth.

### Publishing the summary (completion layer)

Knowledge is the curated layer; the event log is the continuous one. **Default
to summarizing at completion**, not mid-run, unless the user asks earlier.

1. Author/update the doc with **`agor_kb_put`** — `kind: "external"`, covering:
   **outcome, artefacts (PR/branch/files), decisions, follow-ups.**
2. Pass its `documentId` to **`agor_external_run_publish_summary`**.

Don't reimplement KB writes — `agor_kb_put` owns that.

### Completing

`agor_external_run_complete` — `status: completed` (success), `failed` (errored
stop), or `abandoned` (dropped). Add a closing `message`.

## Resuming / inspecting

- `agor_external_runs_list` — find runs (filter by status/harness/branch).
- `agor_external_run_get` — a run with its full event timeline + links.

## Rules

- One run per coherent task. Don't start a new run for every prompt.
- Never block real work on log-back; if a tool errors, note it and continue.
- The run is attributed to the API-key owner — no need to pass a user.
