# Microsoft Teams Gateway Connector — Architecture & Configuration

This document describes the high-level architecture of the Microsoft Teams connector for the Agor Message Gateway, the message flow between Teams and Agor sessions, and the configuration required to set it up.

---

## Overview

The Teams connector enables bidirectional messaging between Microsoft Teams conversations (channels, group chats, and 1:1 DMs) and Agor AI agent sessions. Users message a Teams bot; the gateway routes those messages into Agor sessions, and agent responses are sent back to the originating Teams thread.

The connector is implemented as a plugin to Agor's **Gateway Connector** architecture — the same plugin system that powers the existing Slack and GitHub integrations.

---

## High-Level Architecture

```
┌──────────────────────┐         HTTPS POST          ┌─────────────────────────────┐
│   Microsoft Teams    │  ──────────────────────────► │  Agor Daemon (Feathers)     │
│                      │   Bot Framework Activity     │                             │
│  - Channels          │                              │  ┌───────────────────────┐  │
│  - Group Chats       │                              │  │   Gateway Service     │  │
│  - 1:1 DMs           │                              │  │                       │  │
│                      │  ◄──────────────────────────  │  │  - Auth (channel_key) │  │
│                      │   Bot Framework Response      │  │  - Thread→Session map │  │
└──────────────────────┘                              │  │  - User alignment     │  │
                                                      │  │  - Agentic config     │  │
         ▲                                            │  └──────────┬────────────┘  │
         │                                            │             │               │
         │  continueConversation()                    │  ┌──────────▼────────────┐  │
         │  (proactive outbound)                      │  │   TeamsConnector      │  │
         │                                            │  │                       │  │
         └────────────────────────────────────────────│  │  - CloudAdapter       │  │
                                                      │  │  - ConversationRefs   │  │
                                                      │  │  - HTTP Webhook Srv   │  │
                                                      │  └───────────────────────┘  │
                                                      │             │               │
                                                      │  ┌──────────▼────────────┐  │
                                                      │  │   Session Service     │  │
                                                      │  │                       │  │
                                                      │  │  - /sessions/:id/     │  │
                                                      │  │    prompt             │  │
                                                      │  └───────────────────────┘  │
                                                      └─────────────────────────────┘
```

---

## Key Components

### 1. Gateway Connector Interface (`packages/core/src/gateway/connector.ts`)

All connectors implement the `GatewayConnector` interface:

| Member | Description |
|--------|-------------|
| `channelType` | Platform identifier — `'teams'` for this connector |
| `sendMessage(opts)` | Send text to a platform thread; returns a platform message ID |
| `startListening(cb)` | Start receiving inbound messages (webhook server for Teams) |
| `stopListening()` | Tear down the webhook server |
| `formatMessage(md)` | Convert markdown to platform-native formatting |

Inbound messages are normalized into the `InboundMessage` type:
```typescript
interface InboundMessage {
  threadId: string;    // "{conversationId}|{activityId}"
  text: string;
  userId: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}
```

### 2. Teams Connector (`packages/core/src/gateway/connectors/teams.ts`)

The Teams-specific implementation using the **Bot Framework SDK v4** (`botbuilder` npm package).

**Core responsibilities:**
- Creates a `CloudAdapter` with Azure bot credentials
- Spins up a lightweight **HTTP server** to receive Bot Framework webhook POSTs
- Normalizes inbound activities into `InboundMessage`
- Stores `ConversationReference` objects per thread for **proactive outbound messaging**
- Strips `<at>BotName</at>` mention tags from incoming text
- Extracts actual user text from **quoted-reply** attachments in personal chats
- Collapses `<details>/<summary>` HTML blocks into bold headers for Teams rendering

**Thread ID format:** `"{conversationId}|{activityId}"` — uses pipe as delimiter because Teams conversation IDs can contain colons and other special characters. Parsing always splits on the **last** pipe.

### 3. Connector Registry (`packages/core/src/gateway/connector-registry.ts`)

A factory `Map<ChannelType, (config) => GatewayConnector>` that the gateway service uses to instantiate connectors. Teams is registered alongside Slack and GitHub as a built-in connector.

### 4. Gateway Service (`apps/agor-daemon/src/services/gateway.ts`)

The orchestration layer that:
- **Authenticates** inbound requests via `channel_key`
- **Resolves threads** to existing sessions or creates new ones
- **Routes inbound** messages to `/sessions/:id/prompt`
- **Routes outbound** agent responses back to the platform
- **Manages connector lifecycle** (start/stop listeners, reuse active instances)

For Teams specifically, the service:
- Checks `config.app_id && config.app_password` to determine if listening is possible
- Builds gateway context with conversation type classification (DM / Channel / Group Chat)
- Reuses the active listener instance for outbound messages (critical — conversation references are stored in-memory on the listener)

### 5. Gateway Route Hook (`apps/agor-daemon/src/hooks/gateway-route.ts`)

A Feathers **after-hook** on the messages service that fires on every new message. It calls `gatewayService.routeMessage()` in fire-and-forget mode to push assistant responses back to the originating platform.

### 6. Gateway Types (`packages/core/src/types/gateway.ts`)

Defines the data model:
- `ChannelType` — union including `'teams'`
- `GatewayChannel` — a registered channel with credentials, target worktree, and agentic config
- `ThreadSessionMap` — 1:1 mapping between a platform thread and an Agor session
- `GatewayAgenticConfig` — per-channel session settings (agent type, model, permissions, env vars)

---

## Message Flow

### Inbound (Teams -> Agor Session)

```
1. User @mentions the bot (or sends a DM) in Teams
2. Microsoft sends an HTTP POST (Bot Framework Activity) to the webhook endpoint
3. TeamsConnector receives the activity via CloudAdapter
4. Connector stores the ConversationReference for future outbound use
5. Connector strips bot mentions, extracts quoted-reply text if present
6. Connector normalizes to InboundMessage { threadId, text, userId, ... }
7. Gateway Service receives the InboundMessage via callback
8. Service authenticates via channel_key
9. Service looks up thread→session mapping
   - If mapping exists: routes to existing session
   - If no mapping: creates new session with agentic config, maps the thread
10. Service calls /sessions/:id/prompt with the user's message
11. Agent processes the prompt within the Agor session
```

### Outbound (Agor Session -> Teams)

```
1. Agent produces a response message in the Agor session
2. Gateway route hook intercepts the new message
3. Hook calls gatewayService.routeMessage() (fire-and-forget)
4. Service looks up the thread→session mapping for this session
5. Service retrieves the active TeamsConnector listener instance
   (falls back to creating a new connector if no listener is active)
6. Connector calls formatMessage() to convert markdown for Teams
7. Connector uses the stored ConversationReference to call
   adapter.continueConversation() for proactive messaging
8. Bot Framework delivers the message to the Teams thread
```

### Proactive Messaging Detail

Teams requires a `ConversationReference` to send messages outside of a direct turn context. The connector stores these references in memory as inbound messages arrive. This is why the gateway service **reuses the active listener instance** for outbound — a freshly created connector wouldn't have the stored references and couldn't send proactively.

---

## Configuration

### Azure Bot Registration

Before configuring the connector in Agor, you need a **Bot registration** in Azure:

1. Go to [Azure Portal](https://portal.azure.com) > **Bot Services** > **Create Azure Bot**
2. Choose **Multi-Tenant** for the bot type
3. Under **Configuration**, note the:
   - **Microsoft App ID** (a GUID)
   - **Microsoft App Password** (client secret — create one under Certificates & Secrets)
4. Set the **Messaging Endpoint** to your Agor daemon's public URL:
   ```
   https://<your-agor-host>/gateway/teams/webhook
   ```
5. Under **Channels**, enable the **Microsoft Teams** channel

### Agor Gateway Channel Setup

Create a gateway channel in Agor (via UI or API) with:

| Field | Value |
|-------|-------|
| `channel_type` | `teams` |
| `name` | Descriptive name (e.g., "Teams - Engineering") |
| `target_worktree_id` | The worktree where sessions will be created |
| `config.app_id` | Microsoft App ID from Azure |
| `config.app_password` | Microsoft App Password from Azure |
| `config.tenant_id` | *(Optional)* Restrict to a single Azure AD tenant |
| `config.webhook_port` | *(Optional)* Custom port for the HTTP webhook server |
| `config.webhook_path` | *(Optional)* Custom URL path for the webhook endpoint |
| `config.require_mention` | *(Optional, default: true)* Require @mention in channels |
| `config.allow_thread_replies_without_mention` | *(Optional, default: true)* Allow replies in threads without @mention |

### Agentic Configuration (Optional)

Per-channel settings for sessions created via this channel:

| Field | Description |
|-------|-------------|
| `agentic_config.agent` | Agent tool name (e.g., `claude-code`) |
| `agentic_config.modelConfig` | Default model configuration |
| `agentic_config.permissionMode` | Permission mode for agent sessions |
| `agentic_config.mcpServerIds` | MCP servers to attach to sessions |
| `agentic_config.envVars` | Gateway-level env vars with `forceOverride` control |

### Environment Variables

No global env vars are required on the Agor daemon specifically for Teams — the credentials are stored per-channel in the `config` JSON (encrypted at rest in the database). The standard Agor daemon env vars apply:

| Variable | Purpose |
|----------|---------|
| `DAEMON_PORT` | Port the Agor daemon listens on (default: `3030`) |
| `CORS_ORIGIN` | Allowed CORS origins for the API |
| `AGOR_DB_DIALECT` | Database backend (`sqlite` or `postgresql`) |

---

## Conversation Type Handling

The connector handles three Teams conversation types differently:

| Type | `teams_conversation_type` | Mention Required | Behavior |
|------|---------------------------|------------------|----------|
| **Channel** | `channel` | Yes (configurable) | Bot must be @mentioned to trigger. Thread replies optionally exempt. |
| **Group Chat** | `groupChat` | Yes (configurable) | Same mention rules as channels. |
| **1:1 DM** | `personal` | No | All messages are routed — no mention needed. |

When `require_mention` is `true` (default), messages in channels/group chats without an @mention are silently dropped. Thread replies to an existing mapped thread are exempt by default (`allow_thread_replies_without_mention: true`).

---

## Teams-Specific Message Processing

### Bot Mention Stripping
Teams wraps bot mentions in `<at>BotName</at>` tags. The connector strips these using a case-insensitive regex, including handling regex special characters in bot names (e.g., `Bot (Test)`).

### Quoted Reply Extraction
In personal (1:1) chats, Teams sends quoted replies as HTML attachments with a `<blockquote>` containing the quoted message. The connector extracts only the user's **new text** after the blockquote, preventing the quoted content from being re-processed.

### Markdown Formatting (Outbound)
The `formatMessage()` method:
- Preserves standard markdown (bold, italic, code, code blocks, headings, lists)
- Collapses `<details>/<summary>` blocks (unsupported in Teams) into `**Summary Title**` + content
- Strips remaining HTML tags

---

## File Locations

| File | Purpose |
|------|---------|
| `packages/core/src/gateway/connector.ts` | `GatewayConnector` interface + `InboundMessage` type |
| `packages/core/src/gateway/connectors/teams.ts` | Teams connector implementation |
| `packages/core/src/gateway/connectors/teams.test.ts` | Unit tests |
| `packages/core/src/gateway/connector-registry.ts` | Connector factory registry |
| `packages/core/src/gateway/context.ts` | Gateway context formatting (includes `'teams': 'Microsoft Teams'`) |
| `packages/core/src/gateway/index.ts` | Public exports |
| `packages/core/src/types/gateway.ts` | `ChannelType`, `GatewayChannel`, `ThreadSessionMap` types |
| `apps/agor-daemon/src/services/gateway.ts` | Gateway service (routing, auth, session management) |
| `apps/agor-daemon/src/hooks/gateway-route.ts` | Outbound message routing hook |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `botbuilder` | Bot Framework SDK v4 — `CloudAdapter`, `TurnContext`, activity handling |
| `botframework-connector` | Auth + token management for Azure Bot Service |

---

## Branch & PR Info

- **Branch:** `feat/teams-gateway-connector` on [JakeHarveyy/agor](https://github.com/JakeHarveyy/agor/tree/feat/teams-gateway-connector)
- **Upstream:** Fork of [preset-io/agor](https://github.com/preset-io/agor) (BSL 1.1 license)
- **Key commits:**
  - `4fbe282c` — feat: add Microsoft Teams gateway connector
  - `ddba4d84` — fix: strip all bot mention variants from Teams messages
  - `192fe986` — fix: use entity text for reliable bot mention stripping
  - `501c391e` — fix: strip quoted-reply content from Teams 1:1 chat messages
  - `014464eb` — fix: reuse active listener instance for Teams outbound messaging
