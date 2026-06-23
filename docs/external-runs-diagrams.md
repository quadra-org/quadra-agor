# External Runs — MCP + Skill Diagrams

**Status:** Reference (companion to `internal/external-runs-design-2026-06-22.md`)
**Date:** 2026-06-23
**Scope:** How a native harness (Claude Code) logs work back to central Agor as a
first-class **External Run** — the MCP transport, the tool lifecycle, the skill's
decision flow, and the data it writes.

Diagrams are [Mermaid](https://mermaid.js.org/) (GitHub renders inline). For the
full spec — tables, columns, build/deploy — see the design doc.

---

## 1. Architecture — native harness → central daemon

No local daemon. The native harness talks straight to the central VM's `/mcp`
over HTTPS, through Cloudflare Access. The daemon owns every write; the harness
only calls MCP tools. Same Neon DB the VM already uses, so every other
human/agent sees the run live.

```mermaid
flowchart LR
    subgraph laptop["dev laptop / CI"]
        cc["native Claude Code<br/>(no local daemon)"]
        mcp["agor MCP server<br/>registered w/ agor_sk_ key<br/>+ CF service token"]
        cc --> mcp
    end

    subgraph edge["Cloudflare edge"]
        access["Access (SSO)<br/>+ service-token gate"]
    end

    subgraph vm["Azure VM — agor.quadraplatform.com"]
        tunnel["cloudflared → caddy"]
        daemon["agor daemon :3031<br/>/mcp → external-runs service"]
        db[("shared Neon Postgres")]
        tunnel --> daemon --> db
    end

    mcp -->|"HTTPS POST /mcp (JSON-RPC)"| access
    access --> tunnel
    daemon -.->|tool results| mcp
```

**Auth = two credentials** (both as headers on every request):

```mermaid
flowchart TB
    req["MCP request"]
    cf{"CF-Access-Client-Id<br/>+ CF-Access-Client-Secret<br/>valid?"}
    key{"Authorization: Bearer<br/>agor_sk_ key valid?"}
    ok["→ external-runs service"]
    html["HTML login page<br/>(service-token policy missing)"]
    unauth["401 not authorised<br/>(key wrong / revoked)"]

    req --> cf
    cf -->|no| html
    cf -->|yes| key
    key -->|no| unauth
    key -->|yes| ok
```

---

## 2. Tool discovery — two-tier MCP flow

The `agor_external_run_*` tools are not listed flat; they surface through Agor's
progressive-discovery tier. The harness narrows from domain → schema → call.

```mermaid
flowchart LR
    s["agor_search_tools<br/>(domain: external-runs)"]
    d["agor_get_tool_details<br/>(tool_name)"]
    e["agor_execute_tool<br/>(tool_name + arguments)"]
    s -->|pick a tool| d -->|exact input schema| e
    e -->|runs| svc["external-runs Feathers service"]
```

> When scripting `claude -p --allowedTools`, allow the **server**
> (`mcp__agor`), not a bare tool name — the real tools live behind the three
> discovery tools above.

---

## 3. Run lifecycle — start → log → anchor → link → summary → complete

The canonical sequence the skill paces. Events are **structured, not the
transcript**; the harness self-paces (a 5-step refactor is ~1–3 events).

```mermaid
sequenceDiagram
    autonumber
    participant H as Native Claude Code
    participant M as agor /mcp
    participant DB as Neon Postgres
    participant UI as Agor UI (live)

    H->>M: agor_external_run_start (title, harness, git context)
    M->>DB: insert external_runs (status=running) + start event
    M-->>H: run_id
    DB-->>UI: external_runs:created (External lane)

    loop meaningful checkpoints only
        H->>M: agor_external_run_log (progress|checkpoint|error)
        M->>DB: insert external_run_events
        DB-->>UI: external_run_events:created (timeline)
    end

    H->>M: agor_external_run_set_anchor (branchId)
    M->>DB: patch external_runs.primary_branch_id
    Note over UI: run badges on the branch card

    H->>M: agor_external_run_link (github_pr, target_ref)
    M->>DB: insert external_run_links (secondary)

    H->>M: agor_kb_put (kind=external) → documentId
    H->>M: agor_external_run_publish_summary (documentId)
    M->>DB: set summary_document_id + summary event

    H->>M: agor_external_run_complete (status=completed)
    M->>DB: patch status + completed_at + complete event
    DB-->>UI: run shows completed, summary + artefacts attached
```

---

## 4. Tool → service → table map

What each MCP tool actually touches. (Knowledge is reused, not reinvented — the
summary is a normal KB document the run points at.)

```mermaid
flowchart LR
    subgraph tools["MCP tools (external-runs domain)"]
        t1["_start"]
        t2["_log"]
        t3["_set_anchor"]
        t4["_link"]
        t5["_publish_summary"]
        t6["_complete"]
        t7["_list / _get"]
    end

    subgraph svc["Feathers services"]
        sr["external-runs"]
        se["external-run-events"]
        sl["external-run-links"]
        kb["kb/documents"]
    end

    subgraph db["tables"]
        runs[("external_runs")]
        events[("external_run_events")]
        links[("external_run_links")]
        docs[("documents (kind=external)")]
    end

    t1 --> sr --> runs
    t2 --> se --> events
    t3 --> sr
    t4 --> sl --> links
    t5 --> kb --> docs
    t5 -.->|sets summary_document_id| runs
    t6 --> sr
    t7 --> sr
```

---

## 5. Data model — entity relationships

```mermaid
erDiagram
    users ||--o{ external_runs : "created_by"
    external_runs ||--o{ external_run_events : "run_id (cascade)"
    external_runs ||--o{ external_run_links : "run_id (cascade)"
    external_runs }o--o| branches : "primary_branch_id (anchor)"
    external_runs }o--o| documents : "summary_document_id"

    external_runs {
        text run_id PK
        text created_by FK
        enum harness "claude-code|codex"
        enum status "running|completed|failed|abandoned"
        enum capture_mode "events-only"
        text primary_branch_id FK
        text summary_document_id FK
        json data "cwd,git_*,host"
    }
    external_run_events {
        text event_id PK
        text run_id FK
        enum event_type "start|progress|checkpoint|link|summary|complete|error"
        json body "message,details"
    }
    external_run_links {
        text link_id PK
        text run_id FK
        enum target_kind "github_pr|github_issue|commit|agor_*|kb_document"
        text target_ref "URL / id / agor:// URI"
        enum relationship "primary|secondary"
    }
```

---

## 6. Skill decision flow — when to call what

The `agor-logback` skill is the _process_: it teaches the agent **when** each
tool fires, so the human never drives them by hand. The rule of thumb: log what a
teammate would care about, summarize at completion.

```mermaid
flowchart TD
    start{"non-trivial task<br/>on a Quadra repo?"}
    start -->|no| skip["don't log"]
    start -->|yes| run["_start (keep run_id)"]

    run --> work["do real work"]
    work --> check{"teammate-worthy<br/>moment?"}
    check -->|"decision / milestone / blocker"| log["_log (checkpoint|progress|error)"] --> work
    check -->|"routine read / tool call"| work

    work --> branch{"branch exists?"}
    branch -->|yes, once| anchor["_set_anchor (branchId)"]
    anchor --> work
    branch -->|not yet| work

    work --> pr{"PR / issue / commit<br/>appeared?"}
    pr -->|yes| link["_link (target)"] --> work
    pr -->|no| work

    work --> done{"task done?"}
    done -->|no| work
    done -->|yes| sum["agor_kb_put (kind=external)<br/>→ _publish_summary"]
    sum --> complete["_complete (completed|failed|abandoned)"]
```

**Summary contents** (`kind: external` KB doc): outcome · artefacts (PR / branch
/ files) · decisions · follow-ups. Default to summarizing **at completion**, not
mid-run.

---

## See also

- `internal/external-runs-design-2026-06-22.md` — full design + data model + phasing
- `skills/agor-logback/SKILL.md` — agent-facing when/how instructions
- `skills/agor-logback/references/setup.md` — credential + MCP registration detail
- `skills/agor-logback/DEMO.md` — per-dev demo & troubleshooting walkthrough
