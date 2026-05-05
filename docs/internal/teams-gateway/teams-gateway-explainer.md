---
visibility: internal
---

# Teams Gateway Explainer

> **Status:** Deployed and operational (multi-bot)
>
> **Instance:** `agor.quadraplatform.com`
>
> **Last updated:** 2026-05-04

---

## What It Is

The Teams Gateway connects Microsoft Teams directly to our Agor AI agent platform. Team members message a bot in Teams — in a channel, group chat, or DM — and that message is routed to an AI agent session running on our Agor instance. The agent processes the request and replies back into the same Teams thread.

No context switching. No separate AI tool to log into. You talk to the bot where you already work.

```
Teams message  ──►  Agor Gateway  ──►  Agent Session (Claude Code)  ──►  Reply in Teams
```

Each bot maps to a dedicated agent with its own worktree, system prompt, tools, and personality. The gateway handles all the plumbing: authentication, thread tracking, session creation, and message routing.

---

## Our Deployed Agents

We currently run three AI agent bots, each purpose-built for a different function within Quadra.

### Roma (Go-to-Market Assistant)

| | |
|---|---|
| **What it does** | Quadra's commercial operations agent. Manages the sales pipeline in HubSpot, researches leads and scores them against our ICP, prepares meeting briefing packs, generates legal contracts from SharePoint templates, and monitors pipeline health proactively. |
| **Best for** | Pipeline and deal management, lead research, meeting prep, contract generation, competitive positioning, document lifecycle management. |
| **Tools** | HubSpot (CRM via OAuth), SharePoint (document management via Graph API), Word doc tracked-changes tooling. |
| **How to reach it** | `@Roma` in any Teams channel or DM the Roma bot directly. |
| **Worktree** | `private-roma` (on `quadra-assistants` repo) |

Roma is commercially sharp — it leads with insight, not features. Use it for anything GTM: prepping for a prospect call, checking deal status, drafting a proposal, or pulling competitive intel.

### Sleuth (Data Analyst Assistant)

| | |
|---|---|
| **What it does** | Quadra's data investigation agent. Queries PostgreSQL and MSSQL databases directly, builds and maintains Metabase dashboards, investigates data anomalies and reconciliation issues, and monitors pipeline health in Dagster. Deep domain expertise in investment data — positions, transactions, instruments, portfolios, and NAV. |
| **Best for** | SQL queries, data anomaly investigation, dashboard creation, pipeline health checks, schema inspection, reconciliation issues, ad-hoc data analysis. |
| **Tools** | Neon PostgreSQL (MCP), MSSQL/SQL Server (MCP), Metabase dashboards (MCP), Dagster pipeline orchestration (GraphQL). |
| **How to reach it** | `@Dex` in any Teams channel or DM the Dex bot directly. (Internal name: Sleuth) |
| **Worktree** | `private-data-analyst-assistant` (on `quadra-assistants` repo) |

Sleuth is evidence-first — every claim is backed by data. It treats anomalies as signals worth investigating, leads with findings rather than methodology, and defaults to tables over paragraphs. Use it when your question has a data answer.

### PM Assistant (Program Manager)

| | |
|---|---|
| **What it does** | Quadra's process enforcement and program management agent. Enforces the CRISPY workflow (iteration limits, wall-clock time, commits-without-PR), tracks cross-repo dependencies, owns the GitHub Projects roadmap, runs sprint planning, maintains board hygiene (cleaning stale sessions, archiving completed work), and generates weekly status reports. |
| **Best for** | Sprint planning, status reports, dependency tracking, board hygiene, issue triage, roadmap updates, workflow enforcement. |
| **Tools** | GitHub Projects (roadmap), Agor boards (Alignment + Execution + Roma boards), issue monitoring. |
| **How to reach it** | `@PM Assistant` in any Teams channel or DM the PM Assistant bot directly. |
| **Worktree** | `private-pm-assistant` (on `quadra-assistants` repo) |

PM Assistant is the system's immune system — it detects process problems early and enforces limits relentlessly but not annoyingly. It monitors iteration cycles (max 3 review→implement rounds), verification failures (max 2), wall-clock time per slice (max 60 min), and commits without a PR (max 10). Lead with status and blockers, no filler.

---

## Use Cases

### Day-to-Day Team Use

**Pipeline and deal prep without leaving Teams**
You're about to jump on a prospect call. `@Roma` in the channel and ask for a briefing pack — it pulls the deal from HubSpot, researches the company, scores against ICP, and gives you a prep summary. No tab-switching to CRM.

**Data questions answered with evidence**
A stakeholder asks "what's the NAV reconciliation status for Fund X?" in a channel. `@Dex` (Sleuth) queries the database directly, surfaces anomalies, and replies with a formatted table — no need to open Metabase or write SQL yourself.

**Sprint status and blocker surfacing**
During standup, `@PM Assistant` can report what shipped, what's blocked, which PRs are stuck in review cycles, and whether any work items have exceeded iteration limits — all inline in the planning channel.

**Shared context, shared answers**
When a bot answers in a channel, the whole team benefits. Someone else with the same question finds it in the thread history. This turns individual AI interactions into team knowledge.

### Power User Patterns

**Threaded deep dives**
Start a conversation with a bot in a thread. Each reply in the same thread continues the same Agor session — the agent remembers everything discussed earlier in the thread. This enables multi-turn reasoning, iterative refinement, and complex problem-solving without losing context.

**Channel-specific agents**
Gateway channels can be configured to target specific worktrees with specific tool sets. A bot in a `#data-engineering` channel could have different MCP servers and permissions than the same bot in `#general`.

**DM for private work**
DM a bot for conversations you don't need to share. The same agents, same capabilities — just private to you. No @mention required in DMs; every message is automatically routed.

**Multi-agent workflows**
Ask Roma to research a prospect and pull the deal context, then ask Sleuth to pull the relevant usage data, then ask PM Assistant to create the roadmap items. Each agent handles its part in its own session with its own tools.

---

## How It Works (Simplified)

You don't need to understand the full architecture to use the bots, but knowing the basics helps when things behave unexpectedly.

### The Gateway Layer

Each bot has a **gateway channel** configured in Agor. The gateway channel defines:

- **Which bot** (Azure credentials) listens for messages
- **Which worktree** new sessions are created in
- **Which agent tool** runs the session (currently Claude Code for all bots)
- **What model and permissions** the agent gets

### Thread = Session

Every Teams thread maps 1:1 to an Agor session. When you first message a bot (or @mention it in a new thread), the gateway:

1. Creates a new Agor session in the bot's worktree
2. Maps the Teams thread ID to that session
3. Routes your message as the first prompt

Subsequent messages in the same thread go to the same session — the agent has full context of the conversation.

### Message Flow

```
You @mention the bot in Teams
        │
        ▼
Microsoft sends the message to our webhook
        │
        ▼
Agor Gateway receives it, finds (or creates) a session
        │
        ▼
The agent (Claude Code) processes your prompt
        │
        ▼
The agent's response is sent back to your Teams thread
```

### What the Agent Can Do

Each agent session has access to:

- **The worktree's files** — system prompts, reference docs, any repo content
- **MCP servers** — connected tools like databases, APIs, search
- **Claude Code capabilities** — file reading, code execution, web search, etc.
- **Session memory** — everything said earlier in the thread

The specific capabilities depend on how the gateway channel is configured (model, MCP servers, environment variables, permission mode).

---

## Interacting With the Bots

### In Channels and Group Chats

- **@mention required** — the bot only responds when you `@BotName` in the message
- **Thread replies are free** — once a thread is started with a bot, you can reply in that thread without @mentioning again
- **Everyone can see** — bot responses in channels are visible to all channel members

### In DMs (1:1)

- **No @mention needed** — every message you send in a DM is routed to the bot
- **Private** — only you see the conversation
- **Same capabilities** — DM sessions have the same tools and context as channel sessions

### Tips

- **Be specific** — the agents work best with clear, specific questions. "What were our top 5 customers by revenue last quarter?" beats "tell me about customers"
- **Use threads** — keep related follow-ups in the same thread so the agent retains context
- **One bot per task** — each bot has a focused role. Use the right one for the job
- **Long tasks are fine** — agents can take a minute or more for complex work. The reply will appear when it's ready

### What Happens When Something Goes Wrong

| Symptom | Likely cause |
|---------|-------------|
| Bot doesn't respond at all | Agor daemon may be down, or the gateway channel listener isn't running |
| Bot responds with an error | Usually a session creation failure — check that the target worktree path exists on disk |
| Response is cut off | Token limit reached in the agent's response — try asking for a shorter summary |
| Bot responds to wrong thread | Shouldn't happen — thread→session mapping is 1:1. Report this if you see it |

For infrastructure issues, check the Agor dashboard at `agor.quadraplatform.com` or the daemon logs on the VM.

---

## Security Model

The bots are secured at multiple layers:

| Layer | What it does |
|-------|-------------|
| **Cloudflare Tunnel** | No inbound ports exposed on the VM. All traffic flows through Cloudflare's network. |
| **Bot Framework JWT** | Every message from Microsoft is cryptographically signed. The gateway validates the signature before processing. |
| **Tenant restriction** | Bots are configured with our Azure AD tenant ID — only Quadra users can interact with them. |
| **Gateway channel key** | Application-level authentication between the webhook and Agor's gateway service. |
| **Agor session isolation** | Each bot's sessions run in a dedicated worktree with configured permissions. |

External users, other Microsoft tenants, and unauthenticated requests are all rejected before reaching the agent.

---

## Infrastructure Overview

For those who need to know where things run:

| Component | Location |
|-----------|----------|
| **Agor daemon** | Azure B2ms VM, behind Cloudflare Tunnel (`agor.quadraplatform.com`) |
| **Database** | Neon Postgres (shared) |
| **Bot webhooks** | Three Cloudflare Tunnel hostnames, one per bot (ports 3978/3979/3980) |
| **Azure Bot Registrations** | Three registrations in Azure Portal (one per agent) |
| **Teams Apps** | Three custom apps sideloaded into the Quadra tenant |
| **Agent worktrees** | Three git worktrees on the VM, each on its own branch |

All bots run under a shared Agor user (`agent@quadraplatform.com`).

---

## Adding or Modifying Agents

See **[Adding a New Agent Bot](./adding-a-new-agent-bot)** for the full setup process. The short version:

1. Create an Azure Bot Registration with a new App ID and secret
2. Add a Cloudflare Tunnel hostname pointing to a new port
3. Create a gateway channel in Agor with the credentials and target worktree
4. Build and sideload a Teams app manifest
5. Enable the Teams channel on the Azure Bot Registration

Each new agent needs its own unique port, hostname, Azure registration, and worktree.

---

## Related Documentation

- [Architecture Spec](https://github.com/quadra-org/quadra-q/blob/main/specs/teams-connector-architecture.md) — Full technical architecture, message flow, config reference, and deployment history.
- [Why We Use Agor](https://github.com/quadra-org/quadra-hub/blob/main/internal/agentic-ai/why-we-use-agor.md) — Strategic rationale for the Agor platform.
- [Agent Harness Architecture](https://github.com/quadra-org/quadra-hub/blob/main/internal/agentic-ai/agent-harness-architecture.md) — How agent harnesses work in general.
