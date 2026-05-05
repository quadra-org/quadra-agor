---
visibility: internal
---

# Adding a New Agent Bot

> Step-by-step process for deploying a new AI agent as a Teams bot connected through the Agor Gateway.

---

## Prerequisites

- Admin access to the [Azure Portal](https://portal.azure.com) (Quadra tenant)
- Access to Cloudflare Tunnel configuration for `quadraplatform.com`
- SSH access to the Agor VM
- Teams admin permissions (for sideloading custom apps)

---

## Steps

### 1. Create the Azure Bot Registration

1. Azure Portal > **Bot Services** > **Create Azure Bot**
2. Choose **Single-Tenant** (recommended) or Multi-Tenant
3. Note three values from the registration:
   - **App ID** (GUID) — from the overview page
   - **App Password** — Certificates & Secrets > New client secret > copy the **Value** column (not the Secret ID). This is only shown once
   - **Tenant ID** — from the App Registration overview page
4. Set the messaging endpoint (you'll fill in the hostname after step 2):
   ```
   https://<your-bot-hostname>.quadraplatform.com/api/messages
   ```
5. Under **Channels**, enable **Microsoft Teams** — required before sideloading

### 2. Add a Cloudflare Tunnel Hostname

Add a new public hostname in the Cloudflare Tunnel config:

| Field | Value |
|-------|-------|
| Hostname | `quadra-bot-<name>.quadraplatform.com` |
| Service | `http://agor:<port>` (pick next available: 3981, 3982, ...) |
| Access Policy | **None** (Bot Framework JWT is the auth layer) |

### 3. Expose the Port in Docker

In `docker-compose.yml`, add the new port to the agor service's `ports` list:

```yaml
ports:
  - "3978:3978"   # Roma
  - "3979:3979"   # Dex
  - "3980:3980"   # PM Assistant
  - "<port>:<port>"  # New bot
```

### 4. Create a Worktree on the VM

SSH into the VM and create a git worktree for the new agent:

```bash
cd ~/.agor/worktrees/quadraplatform/quadra-assistants/
git worktree add private-<agent-name> -b <agent-name>
```

Set up the agent's system prompt and any reference files in the worktree.

### 5. Create the Gateway Channel in Agor

Via the Agor UI or API, create a new gateway channel:

| Field | Value |
|-------|-------|
| `channel_type` | `teams` |
| `name` | Descriptive name (e.g., "Teams - Agent Name") |
| `target_worktree_id` | The worktree ID from step 4 |
| `config.app_id` | App ID from step 1 |
| `config.app_password` | App Password from step 1 |
| `config.tenant_id` | Tenant ID from step 1 |
| `config.webhook_port` | The port from step 2 |

Configure the agentic settings:

| Field | Value |
|-------|-------|
| `agentic_config.agent` | `claude-code` |
| `agentic_config.modelConfig` | Model preferences |
| `agentic_config.permissionMode` | Agent permissions |
| `agentic_config.mcpServerIds` | MCP servers to attach |

Set the "Post messages as" user to `agent@quadraplatform.com`.

### 6. Build and Sideload the Teams App

Create a `.zip` containing three files:

**`manifest.json`:**
```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
  "manifestVersion": "1.17",
  "version": "1.0.0",
  "id": "<APP_ID>",
  "developer": {
    "name": "Quadra",
    "websiteUrl": "https://quadraplatform.com",
    "privacyUrl": "https://quadraplatform.com/privacy",
    "termsOfUseUrl": "https://quadraplatform.com/terms"
  },
  "name": {
    "short": "<Agent Name>",
    "full": "<Agent Name> - AI Assistant"
  },
  "description": {
    "short": "AI assistant powered by Agor",
    "full": "Mention @<Agent Name> in any channel or DM to interact."
  },
  "icons": { "color": "color.png", "outline": "outline.png" },
  "accentColor": "#4F46E5",
  "bots": [{
    "botId": "<APP_ID>",
    "scopes": ["personal", "team", "groupChat"],
    "supportsFiles": false,
    "isNotificationOnly": false
  }],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": ["quadra-bot-<name>.quadraplatform.com"]
}
```

**`color.png`:** 192x192 colour icon for the bot.

**`outline.png`:** 32x32 outline icon for the bot.

Upload via: **Teams Admin Center** > Manage apps > Upload custom app.

### 7. Restart and Verify

1. Restart the Agor daemon (or Docker container) to pick up the new port
2. Verify the gateway channel listener starts (check daemon logs)
3. DM the new bot in Teams — you should get a response within a few seconds
4. Test in a channel with `@BotName` to confirm mention handling works

---

## Checklist

- [ ] Azure Bot Registration created with Teams channel enabled
- [ ] Cloudflare Tunnel hostname configured (no Access policy)
- [ ] Docker port exposed
- [ ] Git worktree created with system prompt
- [ ] Gateway channel configured in Agor
- [ ] Teams app manifest built and sideloaded
- [ ] End-to-end test: DM and channel @mention both work

---

## Common Pitfalls

| Mistake | Fix |
|---------|-----|
| Copied the **Secret ID** instead of the **Secret Value** from Azure | Go back to Certificates & Secrets, create a new secret, copy the Value |
| Forgot to enable Teams channel on the Azure Bot Registration | Azure Portal > Bot Registration > Channels > Add Microsoft Teams |
| Worktree path doesn't exist on disk | The `target_worktree_id` must point to a worktree whose path exists on the VM's filesystem |
| Webhook port conflict | Each bot needs a unique port. Check existing ports before picking one |
| `AddAppBotToChatRosterFailed` when sideloading | Enable Teams channel on the Azure Bot Registration first |
