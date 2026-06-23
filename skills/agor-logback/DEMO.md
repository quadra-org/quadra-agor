# External Runs — demo & dev guide

**Work in your own Claude Code (VSCode), keep the team's visibility.** This shows
how a native Claude Code session logs its work back to the central Agor instance
as a first-class **External Run** — a live event timeline, links to the
branch/PR/issue, and a curated Knowledge summary — without running any local Agor
daemon.

- **Central instance:** https://agor.quadraplatform.com
- **You need:** Claude Code in VSCode (or any terminal), ~3 min one-time setup.

---

## 1. One-time setup (per dev)

You register the central Agor MCP server once. No local daemon, no repo changes.

### a. Get your two credentials

1. **Agor API key** — at https://agor.quadraplatform.com → **Settings → API Keys**
   → create one → copy the `agor_sk_…` value.
2. **Cloudflare service token** (Client ID + Secret) — ask the Agor admin (the
   central instance sits behind Cloudflare SSO; the service token lets a headless
   tool through). One shared token for the team is fine.

### b. Register the MCP server (user scope → applies in every repo)

```bash
claude mcp add --scope user --transport http quadra_central_agor_mcp https://agor.quadraplatform.com/mcp \
  --header "Authorization: Bearer <agor_sk_…>" \
  --header "CF-Access-Client-Id: <client-id>.access" \
  --header "CF-Access-Client-Secret: <client-secret>"
```

### c. Verify

```bash
claude mcp list
# quadra_central_agor_mcp: https://agor.quadraplatform.com/mcp (HTTP) - ✔ Connected
```

### d. Install the skill (teaches Claude _when_ to log)

Copy this folder into your Claude Code skills:

```bash
cp -r skills/agor-logback ~/.claude/skills/
```

Now every Claude Code session knows the log-back flow. (Without the skill the
tools still work — you just have to ask Claude to use them.)

> Windows note: a quick connectivity check from PowerShell —
>
> ```powershell
> Invoke-RestMethod -Method Post -Uri https://agor.quadraplatform.com/mcp -ContentType "application/json" `
>   -Headers @{ "Authorization"="Bearer <agor_sk_…>"; "CF-Access-Client-Id"="<id>.access"; "CF-Access-Client-Secret"="<secret>"; "Accept"="application/json, text/event-stream" } `
>   -Body '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"agor_search_tools","arguments":{"query":"external run"}}}'
> ```
>
> Returns the `external-runs` domain + 8 tools = you're wired up.

---

## 2. The demo (5 minutes)

Pick any small real task in a repo you have open (e.g. "add a `--version` flag",
"fix this typo across the docs"). Then in your VSCode Claude Code session:

> **You:** "Start an Agor external run for this task, log a checkpoint at each
> meaningful step, link the PR when I open one, and publish a summary when done."

Claude will drive the tools as it works:

| Step          | What Claude does                                        | Tool                                                                               |
| ------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Kickoff       | Opens the run with title + your git context             | `agor_external_run_start`                                                          |
| Milestones    | Logs a line per real checkpoint (not every turn)        | `agor_external_run_log`                                                            |
| Branch exists | Anchors the run to your branch                          | `agor_external_run_set_anchor`                                                     |
| PR opened     | Links the PR (and issues/commits)                       | `agor_external_run_link`                                                           |
| Done          | Writes a Knowledge summary, attaches it, closes the run | `agor_kb_put` → `agor_external_run_publish_summary` → `agor_external_run_complete` |

You don't run any of these by hand — the skill paces them. You can also nudge:
"log that as a checkpoint", "link PR #123", "wrap up and publish the summary".

### Two ways to drive it

**Minimal** — just trace the work:

> start run → "checkpoint that" at each milestone → (PR opens) "link the PR and
> the commit, then complete the run"

No Knowledge doc, no branch anchor — a clean event trail + links. Good for small
tasks.

**Full** — trace + anchor + durable writeup:

> start run → "checkpoint that" × N → "anchor this run to branch `<name>`" →
> "link the PR and commit" → **"publish a summary"** → "complete the run"

Adds the branch anchor (`set_anchor`) and a curated Knowledge doc
(`publish_summary`). Use when the work deserves a writeup the team will read
later.

> **`complete` does NOT write Knowledge.** If you want the summary doc, say
> "publish a summary" _before_ (or as part of) completing. `complete` only flips
> the run to its terminal status.

### Publishing to Knowledge directly (no run needed)

The Knowledge base is a separate capability of the same MCP server — you don't
need a run to write to it. Any time, say:

> "save this to the Agor knowledge base" (e.g. a decision, a design note, a
> runbook)

Claude writes a KB doc via `agor_kb_put` and it lands at
https://agor.quadraplatform.com → **Knowledge** / the Home "Recent Knowledge"
card. A run's `publish_summary` is just the special case of _attaching_ a KB doc
to a run — the KB write itself stands alone.

---

## 3. Where to watch it (the payoff)

Open https://agor.quadraplatform.com — the run shows up **live** (socket-driven),
two places:

1. **Home → "External Runs" card** (right column). Recent runs with status +
   harness. Click one → a drawer with the full **event timeline**, **linked
   artefacts** (PR/issue/commit), and the **Knowledge summary** pointer.
2. **Any board → left panel → "External" tab.** Same runs in a dedicated lane,
   kept separate from native Agor sessions.

The whole team sees your native VSCode work as it happens — traced, anchored to
the branch/PR, with a durable summary — and you never left VSCode.

---

## 4. What to emphasise when demoing

- **No local daemon.** Talks straight to the central VM over HTTPS. Nothing to
  install or run besides the MCP registration.
- **Own lane, not a fake session.** External work is a first-class record in its
  own lane — it doesn't masquerade as an Agor-hosted session.
- **Structured, not your transcript.** It logs events + a curated summary, never
  your raw chat. Privacy-safe by design.
- **Live.** Events stream into the UI as they happen.
- **Traceable.** One primary anchor (the branch) + secondary links (PR, issue,
  commit, KB doc).

---

## 5. Troubleshooting

| Symptom                                        | Cause / fix                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude mcp list` shows agor **not connected** | Bad/expired `agor_sk_` key, or missing CF headers. Re-check the three `--header` values.                                                        |
| MCP call returns **HTML / login page**         | The Cloudflare service token isn't accepted — the admin needs a **Service Auth** policy on the `agor` Access app allowing the token.            |
| `401` / not authorised                         | The `agor_sk_` key is wrong or revoked. Mint a new one in the Agor UI.                                                                          |
| Run doesn't appear in the UI                   | Confirm the run actually started (ask Claude for the `run_id`); check you're looking at https://agor.quadraplatform.com (not a local instance). |
| Tools missing from `agor_search_tools`         | The central instance is on an old image — the `external-runs` domain ships from quadra-org/quadra-agor (PR #4). Ping the admin.                 |

---

## 6. The tools (reference)

`agor_external_run_start` · `_log` · `_set_anchor` · `_link` ·
`_publish_summary` · `_complete` · `agor_external_runs_list` ·
`agor_external_run_get`. Schemas via `agor_get_tool_details({ tool_name })`.

Codex support is a later phase — same `/mcp` endpoint, registered via Codex's
`mcp_servers` config once validated with Claude.

See also: `SKILL.md` (the agent-facing instructions) and `references/setup.md`
(the credential/registration detail).
