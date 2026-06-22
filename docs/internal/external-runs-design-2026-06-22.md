# External Runs — native-harness log-back design

**Status:** draft / spec
**Date:** 2026-06-22
**Tracking issue:** quadraplatform/demo-env-azure-template#37 (WS4: Dev Team & Tooling, epic #8)
**Implementation branch:** `feat/external-runs-logback`

---

## 1. Goal

Let Quadra R&D run coding work in **native harnesses** (Claude Code first, Codex
later) — own terminal, own config, **no local agor daemon** — while the work
stays traceable in agor as a first-class **External Run / External Chat**
record, with structured events, links to work anchors, and curated Knowledge
summaries.

This replaces the earlier `feat/agor-cli-session-capture` spike (quadra-q),
which is now **rejected**: it (a) made native work _masquerade as a normal agor
session_ — the exact thing #37's design choices rule out — and (b) depended on
each dev running a local daemon to tail the transcript. We run a **single
central daemon** (the VM at `agor.quadraplatform.com`); there is no local daemon
to tail anything.

### Resolved design choices (from the #37 spike)

- External native work is a **first-class External Run**, NOT a fake session.
- UI shows it in a separate **External** lane/section.
- Each run has **one primary work anchor** (an agor branch where possible) with
  secondary links allowed.
- **Knowledge is the curated checkpoint/completion layer**; the event log is the
  continuous record.
- **No raw transcript capture** in MVP — structured events + summaries only.
- Validate with **Claude first**; Codex follows once the MCP contract is proven.

---

## 2. Architecture

```
 dev laptop / CI                        Cloudflare edge            Azure VM
┌─────────────────────┐                ┌──────────────┐    ┌────────────────────────┐
│ native Claude Code   │  HTTPS POST    │ Access (SSO  │    │ cloudflared → caddy →   │
│  (no local daemon)   │ ─────────────► │ + service    │ ──►│ agor daemon :3031       │
│                      │  /mcp JSON-RPC │ token gate)  │    │  /mcp  → external-runs   │
│  agor MCP server     │                └──────────────┘    │         service          │
│  registered w/ key   │ ◄───────────── tool results ────── │                          │
└─────────────────────┘                                     │  shared Neon Postgres ◄──┤
                                                             └────────────────────────┘
```

Native harness talks **directly to the central daemon's `/mcp`** over HTTPS. No
shared-Neon-bus-via-local-daemon. The daemon owns all writes; the harness only
calls MCP tools. Same Neon DB the VM already uses, so every other agent/human
sees the run live in the UI.

### 2.1 Transport / auth (the central-only piece)

`agor.quadraplatform.com` is fronted by **Cloudflare Tunnel** (`cloudflared`,
outbound-only — see `infra/central-daemon/docker-compose.yml`) and gated by
**Cloudflare Access (SSO)**. A headless MCP client therefore needs **two**
credentials:

1. **Cloudflare Access service token** — add a _Service Auth_ policy to the
   Access application for `agor.quadraplatform.com` (or scope it to the `/mcp`
   path). Cloudflare issues a `Client ID` + `Client Secret`; requests carrying
   them as headers bypass the interactive SSO login.
2. **agor `agor_sk_` personal API key** — the daemon's `/mcp` endpoint validates
   it as `Authorization: Bearer` (confirmed: `mcp/server.ts` auth block, key
   verified by `UserApiKeysRepository.verifyKey` via `auth/api-key-strategy.ts`).

Claude Code MCP registration (`claude mcp add --scope user --transport http`):

```jsonc
{
  "mcpServers": {
    "agor": {
      "type": "http",
      "url": "https://agor.quadraplatform.com/mcp",
      "headers": {
        "Authorization": "Bearer agor_sk_…",
        "CF-Access-Client-Id": "<token>.access",
        "CF-Access-Client-Secret": "<secret>",
      },
    },
  },
}
```

Both secrets stay out of git (env-substituted or generated at install). CRLF
gotcha from the prior spike still applies: `tr -d '\r\n'` any Windows-edited key.

**Caddyfile note:** the active block is currently HTTP-only `:80 { reverse_proxy
agor:3031 }` — it already proxies _all_ paths, so `/mcp` is reachable today; no
Caddy change needed. (The HTTPS termination is Cloudflare's, not Caddy's.)

### 2.2 Session binding (v1 vs v2)

The `agor_sk_` key is **user-scoped**. An external run is created _by_ the user;
it is not a spawned agor session, so there is no session token to bind. v1 keys
the run to `created_by` (the API-key owner) + the primary branch anchor. v2 may
add `X-Agor-Session-Id` style self-awareness if we ever co-run with native agor
sessions — **deferred**, not needed for the External Run model.

---

## 3. Data model

Three new tables, Drizzle dual-dialect — schemas in
`packages/core/src/db/schema.sqlite.ts` and `schema.postgres.ts`, re-exported
from `schema.ts`; generate with `pnpm db:generate` in `packages/core`. Follow
the `sessions`/`branches` column conventions: `text(36)` UUID PKs,
`t.timestamp()` / `t.bool()` / `t.json<T>()` helpers, FK `onDelete`
cascade/set-null, soft-delete via `archived` + `archived_at`.

### `external_runs`

| column                                   | type                                                     | notes                                                           |
| ---------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| `run_id`                                 | text(36) PK                                              | UUIDv7                                                          |
| `created_by`                             | text(36) FK→users (set null)                             | the `agor_sk_` key owner                                        |
| `harness`                                | text enum `['claude-code','codex']`                      | which native tool                                               |
| `title`                                  | text                                                     | human label                                                     |
| `status`                                 | text enum `['running','completed','failed','abandoned']` | lifecycle                                                       |
| `capture_mode`                           | text enum `['events-only']`                              | MVP = events-only (no transcript)                               |
| `primary_anchor_type`                    | text enum `['branch','card']` nullable                   | see open-Q resolution §7                                        |
| `primary_branch_id`                      | text(36) FK→branches (set null), nullable                | primary anchor                                                  |
| `summary_document_id`                    | text(36) FK→kb documents (set null), nullable            | curated KB summary                                              |
| `data`                                   | json                                                     | `{ cwd, git_repo, git_branch, git_sha, harness_version, host }` |
| `created_at`/`updated_at`/`completed_at` | timestamp                                                |                                                                 |
| `archived`/`archived_at`                 | bool / timestamp                                         |                                                                 |

### `external_run_events`

| column       | type                                                                              | notes                                                   |
| ------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `event_id`   | text(36) PK                                                                       |                                                         |
| `run_id`     | text(36) FK→external_runs (cascade)                                               |                                                         |
| `event_type` | text enum `['start','progress','checkpoint','link','summary','complete','error']` |                                                         |
| `body`       | json                                                                              | `{ message, details }` — structured, NOT raw transcript |
| `created_at` | timestamp                                                                         | indexed `(run_id, created_at)` for the timeline         |

### `external_run_links`

| column         | type                                                                                                     | notes                     |
| -------------- | -------------------------------------------------------------------------------------------------------- | ------------------------- |
| `link_id`      | text(36) PK                                                                                              |                           |
| `run_id`       | text(36) FK→external_runs (cascade)                                                                      |                           |
| `target_kind`  | text enum `['github_issue','github_pr','commit','agor_branch','agor_card','agor_session','kb_document']` |                           |
| `target_ref`   | text                                                                                                     | URL / id / `agor://…` URI |
| `relationship` | text enum `['primary','secondary']`                                                                      | one `primary` per run     |
| `created_at`   | timestamp                                                                                                |                           |

---

## 4. MCP surface

New domain `external-runs`. Add a registrar to `DOMAIN_TOOL_REGISTRARS`
(`apps/agor-daemon/src/mcp/server.ts`), a tool file
`mcp/tools/external-runs.ts`, and a description in `mcp/tool-registry.ts`
(`DOMAIN_DESCRIPTIONS`). Each tool resolves ids then calls a Feathers
`external-runs` service (`services/external-runs.ts`, registered in
`register-services.ts`, RBAC hooks in `register-hooks.ts`). Tools are discovered
via the existing `agor_search_tools` → `agor_get_tool_details` →
`agor_execute_tool` two-tier flow.

| Tool                                | Maps to                                                                 | Purpose (#37 item 2)                                      |
| ----------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `agor_external_run_start`           | `create`                                                                | start run; record harness + git context; returns `run_id` |
| `agor_external_run_log`             | custom `logEvent`                                                       | append a structured event                                 |
| `agor_external_run_set_anchor`      | `patch`                                                                 | set the one primary branch/card anchor                    |
| `agor_external_run_link`            | links `create`                                                          | add a secondary artefact/work-item link                   |
| `agor_external_run_publish_summary` | calls `kb/documents` `agor_kb_put`/`_edit` + sets `summary_document_id` | create/update the curated Knowledge summary               |
| `agor_external_run_complete`        | `patch` status                                                          | finalize; emits `complete` event                          |
| `agor_work_items_search`            | thin wrapper over `branches`/`kb/search`/GitHub                         | find an anchor/work item to attach                        |

**Knowledge reuse:** the summary is a normal KB document (`kind: 'external'`
already exists in the `documents` enum) written through the existing
`agor_kb_put`/`agor_kb_edit` tools. We do NOT build a parallel doc store — we
point `external_runs.summary_document_id` at the KB doc and let the existing KB
viewer/graph render it. Summaries are created **only at checkpoints/completion**,
not per event.

---

## 5. UI — External lane

React/AntD app at `apps/agor-ui` (Vite, Feathers + socket.io realtime). Mirror
the existing session-rendering components rather than overloading them:

- **Data:** new `AppExternalRunDataContext` (parallel to `AppLiveDataContext`,
  `contexts/AppDataContext.tsx`) subscribing to `external_runs:*` /
  `external_run_events:created` socket events (Feathers auto-emits for the
  registered service — declare `events` in `register-services.ts`).
- **Lane:** an **External** tab/section in `BoardAssistantPanel.tsx` (alongside
  `assistant` / `all-sessions` / `comments`), rendering an `ExternalRunsSection`
  (parallel to `BranchSessionSections.tsx`).
- **Detail:** `ExternalRunPanel` = event timeline (reuse the `TaskBlock` /
  `MessageBlock` renderers where the event shape matches) + a summary/artifacts
  panel showing the linked KB doc and `external_run_links`.
- **Anchor:** runs with a `primary_branch_id` surface on that branch's card as an
  "External runs" badge/section so the work stays anchored.

---

## 6. Client skill / instructions pack (#37 item 3)

Ship a Claude Code **skill** (`skills/agor-logback/`) that teaches _when + how_
to log back — this is the "process" the team actually invokes:

- **When:** start a run at task kickoff; `log` at meaningful checkpoints (not
  every turn); `set_anchor` once a branch exists; `link` PRs/issues/commits as
  they appear; `publish_summary` + `complete` at the end (or at major
  checkpoints). Summary = outcome, artefacts, decisions, follow-ups.
- **How:** call the `agor_external_run_*` tools via the registered `agor` MCP
  server. The skill includes the registration snippet (§2.1) and a short
  decision rubric so the agent self-paces summaries.

Codex equivalent (config.toml `mcp_servers`) is a **later phase** once the MCP
contract is proven with Claude.

---

## 7. Open questions — resolved

- **Primary anchor strictly branch, or allow card?** → **Allow `card`**, promote
  to `branch` later. `primary_anchor_type` + nullable `primary_branch_id` cover
  it; many native runs start before a branch exists.
- **Minimum External lane UI?** → **Event list + summary/artifacts panel** (not
  event-list-only) — the artifacts panel is what makes a run traceable.
- **First checkpoint = immediate KB summary, or defer to completion?** →
  **Default to completion**, allow explicit earlier `publish_summary`. Avoids
  half-baked summaries; the event log already carries continuous detail.
- **Native MCP auth shape?** → **user `agor_sk_` key + Cloudflare Access service
  token** (§2.1). Short-lived UI tokens are useless headless; per-session tokens
  don't apply (no spawned session).

---

## 8. Phasing

- **Phase 1 — Claude validation slice (MVP, #37 acceptance):** tables + service +
  hooks; MCP tools `start`/`log`/`set_anchor`/`link`/`publish_summary`/`complete`;
  minimal External lane (list + detail + summary panel); Cloudflare service-token
  - skill; repoint VM `Dockerfile` `git clone` from `preset-io/agor` to our fork
    commit. Acceptance = a native Claude Code session starts a run, logs events,
    links a PR, publishes a KB summary, completes — visible/searchable in the UI.
- **Phase 2 — Codex:** Codex `mcp_servers` config + skill parity once the
  contract holds.
- **Phase 3 (deferred):** session-binding self-awareness (v2), optional opt-in
  transcript capture, richer work-item search.

## 9. Build / deploy notes

- DB: edit both dialect schema files, `pnpm db:generate` (produces
  `drizzle/{sqlite,postgres}/*.sql` — different sequence numbers per dialect),
  review SQL, commit. Migrations run at daemon start
  (`apps/agor-daemon/src/setup/database.ts`).
- Image: the VM builds agor from source at pinned `AGOR_COMMIT`
  (`infra/central-daemon/Dockerfile`, currently `preset-io/agor@e34aa872`).
  Shipping this feature = repoint the clone to `JakeHarveyy/agor` (or upstream
  to `preset-io`/`quadra-org`) at the feature commit and bump `AGOR_COMMIT`.
- Upstreaming: prefer a PR to `preset-io/agor` so we don't carry fork drift
  (External Runs is a generally useful feature); fall back to fork-pin if the
  upstream timeline doesn't fit.

## 10. Implementation status (branch `feat/external-runs-logback`)

**Done:**

- **DB** — `external_runs` / `external_run_events` / `external_run_links` in both
  Drizzle dialects + additive migrations (sqlite `0059`, postgres `0050`).
  Migrations hand-authored (main has pre-existing snapshot drift that makes
  `pnpm db:generate` prompt); sqlite migration verified to apply via `node:sqlite`.
- **Backend** — `ExternalRun*Repository` (`@agor/core`), three Feathers services
  (`/external-runs`, `/external-run-events`, `/external-run-links`) registered
  alongside Knowledge, auth/role hooks, `resolveExternalRunId`.
- **MCP** — `agor_external_run_*` tools (`start`, `log`, `set_anchor`, `link`,
  `publish_summary`, `complete`) + `agor_external_runs_list` / `_get`, under a new
  `external-runs` domain (piggybacks the `knowledge` service tier).
- **Skill** — `skills/agor-logback/` (SKILL.md + `references/setup.md`): when/how
  to log back + the Cloudflare-service-token + `claude mcp add` registration.
- `@agor/core` and `@agor/daemon` typecheck clean; biome clean.

**Remaining for Phase 1 MVP:**

- **UI** — the External lane (`AppExternalRunDataContext`, `ExternalRunsSection`,
  `ExternalRunPanel`) per §5. Backend already emits Feathers `created`/`patched`
  events for live updates. _(Largest remaining piece; can be its own PR — the
  feature is already functional/searchable over MCP without it.)_
- **Deploy** — repoint the VM `infra/central-daemon/Dockerfile` clone to this
  fork's commit + bump `AGOR_COMMIT` **(change lives in `quadra-q`, not this
  repo)**; provision the Cloudflare Access service token; distribute the skill.
- **Validation** — boot the daemon on the VM (runs the migration), register the
  MCP server in a native Claude Code session, run the full lifecycle end-to-end.

**`work_items_search` (issue item 2)** intentionally not a dedicated tool — the
skill uses existing `agor_branches_list` / `agor_kb_search` / GitHub to find an
anchor. Add a wrapper later only if the indirection proves clumsy.
