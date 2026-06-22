# Register the `agor` MCP server (central instance)

The log-back tools come from the central Agor daemon at
`https://agor.quadraplatform.com/mcp`. It sits behind **Cloudflare Access (SSO)**,
so a headless Claude Code session needs **two** credentials:

1. **Cloudflare Access service token** — `CF-Access-Client-Id` + `CF-Access-Client-Secret`.
   An admin creates this in Cloudflare Zero Trust → Access → Service Auth, and adds
   a policy on the `agor.quadraplatform.com` Access app that allows that service
   token (scope it to `/mcp` if you want it MCP-only). It lets the request skip the
   interactive SSO login.
2. **Agor API key** — a personal `agor_sk_…` key (Agor UI → Settings → API Keys, or
   `POST /api/v1/user/api-keys`). Sent as `Authorization: Bearer`.

## One-time registration (user scope → applies in every repo)

```bash
# Strip any CRLF if these came from a Windows-edited .env (libpq/headers choke on \r)
AGOR_KEY="$(printf '%s' "$AGOR_API_KEY" | tr -d '\r\n')"
CF_ID="$(printf '%s' "$CF_ACCESS_CLIENT_ID" | tr -d '\r\n')"
CF_SECRET="$(printf '%s' "$CF_ACCESS_CLIENT_SECRET" | tr -d '\r\n')"

claude mcp add --scope user --transport http agor https://agor.quadraplatform.com/mcp \
  --header "Authorization: Bearer ${AGOR_KEY}" \
  --header "CF-Access-Client-Id: ${CF_ID}" \
  --header "CF-Access-Client-Secret: ${CF_SECRET}"
```

Verify:

```bash
claude mcp list   # → agor: https://agor.quadraplatform.com/mcp (HTTP) - ✔ Connected
```

Quick direct check (no Claude needed):

```bash
curl -s -X POST https://agor.quadraplatform.com/mcp \
  -H "Authorization: Bearer ${AGOR_KEY}" \
  -H "CF-Access-Client-Id: ${CF_ID}" -H "CF-Access-Client-Secret: ${CF_SECRET}" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400
```

## Notes

- Keep the secrets out of git — read them from the environment / a gitignored
  `.env`, or generate the config at machine setup.
- The tools are wrapped behind Agor's two-tier discovery: the agent calls
  `agor_search_tools` → `agor_get_tool_details` → `agor_execute_tool`, so when
  scripting `claude -p --allowedTools`, allow `mcp__agor` (the server), not a bare
  tool name.
- Codex support is a later phase — the same MCP endpoint, registered via Codex's
  `mcp_servers` config once the contract is proven with Claude.
