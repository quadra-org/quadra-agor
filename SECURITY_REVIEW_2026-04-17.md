# Agor Security Review — 2026-04-17

Consolidated findings from 8 parallel domain reviews of the Agor monorepo
on branch `security-review-coordinator` (against `main` @ `5e6f7a3a`).
Each domain was reviewed by a dedicated subsession; source reports are
summarised here under Appendix A.

Domains reviewed:

1. Docker & container posture
2. Web security (CORS / CSRF / sockets / UI)
3. AuthN / AuthZ / RBAC
4. MCP surface & executor boundary
5. Dependency supply chain
6. Secrets management
7. Unix isolation & filesystem
8. Injection / command execution / input validation

---

## 1. Executive summary

### Headline counts

| Severity      | Count | Notes |
|---------------|-------|-------|
| CATASTROPHIC  | **~15** | 3 web, 3 authz, 1 MCP, 1 dep, 2 secrets, 5 unix |
| CRITICAL      | ~15   | plus everything marked CATASTROPHIC above (same tier in some reports) |
| HIGH          | ~70   | spread across all 8 domains |
| MEDIUM        | ~60   | |
| LOW / INFO    | ~40   | includes positive confirmations (e.g. PR #1008 verified) |

### Headline risks (single worst exploit chains)

**Chain A — "Default-deploy takeover" (network-reachable, no user required):**

1. Default Docker prod compose binds daemon on `0.0.0.0` with
   `CORS_ORIGIN=*` and admin/admin credentials echoed to stdout.
2. Attacker logs in as admin → socket connects → `terminal:input`
   events accepted with any `userId` (no authz on socket channel).
3. PTY receives shell input as the chosen victim → commands run as
   daemon user (or in strict mode, as victim's Unix user).
4. Base Dockerfile grants `agor ALL=(ALL) NOPASSWD:ALL`, so
   container-internal RCE becomes container root → host SSH key read
   (host `~/.ssh` bind-mounted `:ro` into `/home/agor/.ssh`, exfil is
   not prevented by `:ro`).

**Chain B — "Sudoers wildcard → real-host root" (post-auth, any
authenticated user):**

1. Attacker sets their `unix_username` to e.g. `; useradd -o -u 0 evil`.
2. Any executor path hits `packages/executor/src/commands/unix.ts:614`
   etc. (or `runAsUser` at `packages/core/src/unix/run-as-user.ts:94`),
   shelling out unquoted.
3. Lands arbitrary sudo commands; sudoers file permits
   `useradd *`, `usermod *`, `gpasswd *`, `chpasswd`, and `find *`
   (the last gives an unrestricted root shell via `-exec`).

**Chain C — "Cross-tenant read":**

1. Any authenticated MCP client calls `agor_messages_list` with a
   broad `search` string (no sessionId).
2. Handler runs raw Drizzle `select(ctx.db).from(messagesTable)`
   bypassing Feathers RBAC hooks entirely → full conversation
   history across all users, worktrees, and sessions.
3. Separately, `tasks.find` and `messages.find` have no scoping
   hooks even with `worktree_rbac=true`.

**Chain D — "Identity borrowing via spawn":**

1. User with `prompt` tier on another user's worktree calls
   `agor_sessions_spawn`/`_prompt(mode:"fork"|"subsession")`.
2. Child session inherits `created_by` and `unix_username` of the
   parent's creator.
3. Executor runs as the original creator's Unix user, with their
   credentials, API keys, SDK tokens, and MCP identities.

**Chain E — "Supply chain RCE in transitive dep":**

- `protobufjs@7.5.4` / `8.0.0` are present via
  `@google-analytics/admin → google-gax`, both vulnerable to
  GHSA-xq3m-2v4x-88gg (prototype-pollution / arbitrary code
  execution). Runtime-loaded inside the daemon.

### What is working well

- PR #1008 recursive-ACL fix is correctly applied (scoped ACLs).
- `chpasswd` password material is passed over stdin (not argv).
- Build-script (`agor-live/build.sh`) atomic dist swap is correct.
- Lockfile + `--frozen-lockfile` in CI.
- Env-resolver allowlist prevents leaking `AGOR_MASTER_SECRET`,
  `DATABASE_URL` into executor children.
- Markdown renderer sanitizes by default; mention highlighter
  HTML-escapes.
- User patch hooks use explicit field allowlist (mass-assignment
  safe); role-bootstrap path blocks self-promotion.
- Worktree find/list consolidated into SQL JOIN.

---

## 2. CATASTROPHIC findings (~15)

### Web (3)

- **Unauthenticated WebSocket terminal hijack** —
  `apps/agor-daemon/src/setup/socketio.ts:97-109,220-275`. Anonymous
  sockets are allowed; `terminal:input` / `:output` / `:resize`
  broadcast to `user/${userId}/terminal` based on client-supplied
  `userId`. Any browser reaching the daemon (CORS accepts any
  localhost port + `*.codesandbox.io`) can inject shell commands
  into any user's PTY or stream their output.
- **CSRF on `/api/github/setup/callback`** —
  `apps/agor-daemon/src/services/github-app-setup.ts:117-150,289`.
  No auth, no state nonce. Victim-admin's browser can be forced
  via `<img>` / navigation to rebind the GitHub gateway to an
  attacker-controlled installation.
- **`CORS_ORIGIN=*` with `credentials: true`** —
  `apps/agor-daemon/src/setup/cors.ts:80-83` +
  `apps/agor-daemon/src/index.ts:243`. `origin:true` reflects any
  `Origin` while credentials are allowed → any origin performs
  authenticated requests for logged-in victims.

### AuthN / AuthZ (3)

- **`tasks.find` + `messages.find` unscoped** under
  `worktree_rbac=true` (`apps/agor-daemon/src/register-hooks.ts:
  1623-1682, 156-239`). Per-resource `get/create/patch` hooks
  enforce worktree scoping but `find()` bypasses them entirely →
  any authenticated member reads every task and every message in
  the system.
- **`tasks.remove` requires only MEMBER role** — same file,
  line 1680. No session/worktree RBAC even with the flag on.
- **GitHub App setup routes registered with NO authentication** —
  `apps/agor-daemon/src/services/github-app-setup.ts:279-295`.
  Install + callback hittable anonymously on a network-exposed
  daemon (dup of CSRF finding above).

### MCP (1)

- **`agor_messages_list` raw Drizzle bypasses RBAC** —
  `apps/agor-daemon/src/mcp/tools/messages.ts:108-112`. Executes
  `select(ctx.db).from(messagesTable).where(...)` directly,
  skipping the Feathers service layer. Called with just a
  `search` string this dumps every message across every tenant.

### Dependencies (1)

- **`protobufjs` RCE GHSA-xq3m-2v4x-88gg** — versions `7.5.4` and
  `8.0.0` present via `@google-analytics/admin` → `google-gax`.
  Patched in `>=7.5.5` / `>=8.0.1`. Currently not covered by
  `pnpm.overrides`.

### Secrets (2)

- **API keys placed in sudo argv and logged** — when
  `asUser` is set, `buildSpawnArgs`
  (`packages/core/src/unix/run-as-user.ts:193-211`) serialises
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` into a
  `bash -c` string. `apps/agor-daemon/src/utils/spawn-executor.ts:
  260-289` then `console.log`s the full command. Credentials are
  visible to local users via `/proc/*/cmdline` + `ps` and captured
  by any log aggregator.
- **JWT secret prefix logged at startup** —
  `apps/agor-daemon/src/index.ts:337` prints
  `${jwtSecret.substring(0,16)}...` which leaks 64 bits of the
  HS256 signing key on every boot.

### Unix / sudoers (5) — all in `docker/sudoers/agor-daemon.sudoers`

- **`useradd *`** (line 57): `sudo -n useradd -o -u 0 -G root,sudo,docker evil` creates a second UID-0.
- **`usermod *`** (line 59): takes over an existing account via `-u 0 -o`, `-G root`, or `-p <hash>`.
- **`gpasswd *` / `groupadd *`** (lines 69-71): adds the daemon user to `root`/`sudo`/`docker`.
- **`chpasswd`** (line 60): with no caller-side filter on stdin, resets `root`'s password.
- **`find *`** (line 130): `-exec /bin/sh {} \;` yields a root shell. The sudoers comment acknowledges the risk.

A wrapper script (e.g. `/usr/local/sbin/agor-user-admin <verb> <arg>`) collapses all five.

---

## 3. CRITICAL findings (post-auth high blast radius)

### Injection (CRITICAL class)

- **`unixUsername` shell injection** in executor —
  `packages/executor/src/commands/unix.ts:614,637,674,685`. Unquoted
  interpolation into `id ${unixUsername}` and `sudo -u ${unixUsername}
  git config --global --add safe.directory '${trustAllPattern}'`.
- **`asUser` shell injection** in `runAsUser` —
  `packages/core/src/unix/run-as-user.ts:94`. Username is not passed
  through `isValidUnixUsername`; backticks/`$()`/whitespace allowed.

### MCP (CRITICAL class)

- **MCP JWTs deterministic, non-expiring, unrevocable** —
  `apps/agor-daemon/src/mcp/tokens.ts:35-58,140-146`. HS256 signed
  with `noTimestamp:true`; no `iat`, no `exp`. `revokeSessionToken`
  and `cleanupExpiredTokens` are no-ops. A leaked token is permanent
  until the daemon secret rotates.
- **`agor_execute_tool` has no allowlist** —
  `apps/agor-daemon/src/mcp/tools/search.ts:142-203`. `readOnlyProxy`
  filters the SDK-level tool list but the real server keeps write
  tools. `agor_execute_tool` resolves `_registeredTools[toolName]`
  for ANY name → bypass of tier/visibility filters; self-recursion.
- **MCP session token accepted via URL query string** —
  `apps/agor-daemon/src/mcp/server.ts:407-414`. `?sessionToken=`
  leaks to referers, browser history, proxy logs. Combined with the
  never-expiring tokens above, exposure is permanent.
- **Spawn/fork run under parent's `created_by`** —
  `apps/agor-daemon/src/services/sessions.ts:205,383`. Identity
  borrowing via the `prompt` tier.
- **Subagents inherit parent's MCP token / credential reach** —
  `apps/agor-daemon/src/mcp/tools/sessions.ts:417-451`. Child
  session's deterministic JWT still grants admin-only tools if the
  parent was admin.
- **Global-scope shared OAuth tokens returned to every session**
  regardless of user —
  `packages/executor/src/sdk-handlers/base/mcp-scoping.ts:69-113`.
  Explicit comment: "owner_user_id is NOT used for filtering".

### Docker

- **`NOPASSWD:ALL` in base image** — `docker/Dockerfile:78`. Eclipses
  the carefully-scoped `agor-daemon.sudoers`. Any RCE in daemon / UI /
  agent becomes container root.
- **Host `~/.ssh` bind-mounted into container** — `docker-compose.yml:
  157`. The entire point of this tool is to run untrusted agent code;
  `:ro` does not prevent exfiltration.
- **Default admin@agor.live / admin auto-created and printed** —
  `docker/docker-entrypoint-prod.sh:22-34`. No rotation enforcement.

---

## 4. HIGH findings

Grouped by domain. See Appendix A for full per-line detail.

### Web / transport

- CORS allows every localhost port with credentials
  (`apps/agor-daemon/src/setup/cors.ts:88-89,141`).
- Sandpack `*.codesandbox.io` allowed credentialed
  (`apps/agor-daemon/src/setup/cors.ts:35,92-94`).
- Private-Network-Access header echoed unconditionally
  (`apps/agor-daemon/src/index.ts:237-242`).
- JWT access + refresh tokens stored in `localStorage`
  (`apps/agor-ui/src/App.tsx:317`, `ArtifactNode.tsx:71`).
- No CSP / `X-Frame-Options` on UI (`apps/agor-ui/index.html` +
  `apps/agor-daemon/src/index.ts:265-286`).
- Stored-HTML XSS via uploads (`apps/agor-daemon/src/utils/upload.ts:
  140-148`) — no MIME allowlist, no `Content-Disposition`.
- XSS in GitHub setup callback via unescaped channel name
  (`apps/agor-daemon/src/services/github-app-setup.ts:168`).

### AuthN / AuthZ

- Service-account `_isServiceAccount=true` is a global RBAC bypass
  (`apps/agor-daemon/src/utils/authorization.ts:33`).
- Session-token ledger is in-memory (`apps/agor-daemon/src/services/
  session-token-service.ts:31`) → replay after daemon restart.
- Session tokens not bound to worktree or operation.
- `FilesService.find(sessionId)` IDOR — no worktree check
  (`apps/agor-daemon/src/services/files.ts:48-61`).
- `/file` singular service has no worktree RBAC
  (`apps/agor-daemon/src/services/file.ts:143-181`).
- `session-mcp-servers.find`, `mcp-servers.find`, `boards.find`,
  `board-objects.find` all unscoped on find
  (`apps/agor-daemon/src/register-hooks.ts:721-742, 1688-1912, 245-324`).
- Terminal RBAC and upload RBAC are flag-gated on `worktree_rbac`
  (`apps/agor-daemon/src/services/terminals.ts:194-218`;
  `apps/agor-daemon/src/register-routes.ts:1099-1127`).
- Web terminal enabled by default in `unix_user_mode: simple` →
  members get a shell as the daemon user.
- `worktree_rbac` default is OFF.

### MCP / executor

- `agor_user_create` / `agor_users_update` callable from any MCP
  session inheriting admin context
  (`apps/agor-daemon/src/mcp/tools/users.ts:88-145,147-196`).
- `agor_worktrees_create` accepts caller-chosen `othersCan` /
  `othersFsAccess` without role clamp
  (`apps/agor-daemon/src/mcp/tools/worktrees.ts:273-293`).
- Repo lookup in `agor_worktrees_create` skips RBAC params
  (`apps/agor-daemon/src/mcp/tools/worktrees.ts:214-220`).
- **Executor blindly applies attacker-controlled env vars** —
  `packages/executor/src/cli.ts:139-144`. `NODE_OPTIONS=--require=
  /tmp/x.js`, `LD_PRELOAD`, `PYTHONSTARTUP` → RCE in executor.
- Handlebars rendering of repo-supplied `.agor.yml` produces shell
  commands (`packages/executor/src/commands/git.ts:321-352`).
- Zellij PTY injection via `envFile` (`packages/executor/src/commands/
  zellij.ts:273`) and unvalidated `cwd`/`tabName`/`sessionName`
  (same file lines 57,179-192,457).
- MCP server URLs not vetted for SSRF (loopback / link-local allowed).
- External MCP tool outputs forwarded to agents without sanitisation
  (prompt injection + UI XSS vector).

### Injection / data integrity

- `UnixUserCommands` helpers at `packages/core/src/unix/user-manager.ts`
  (lines 113,127,147,156,198,206,214,222,230,238,261-263,279-281,306)
  interpolate `${username}`/`${homeBase}` inside double-quoted shell
  strings.
- chown injection via `unix_username` in terminals
  (`apps/agor-daemon/src/services/terminals.ts:112`).
- Git credential-helper token injection
  (`packages/core/src/git/index.ts:62,67`).
- Git ref option-injection — no `--` separator
  (`packages/core/src/git/index.ts:386,429,452,455`).
- chmod injection via worktreeName
  (`packages/executor/src/commands/unix.ts:929`).
- `chpasswd` line injection via `:` / newline
  (`packages/executor/src/commands/unix.ts:707`).

### Secrets

- API keys fall back to plaintext DB storage when
  `AGOR_MASTER_SECRET` is unset (`packages/core/src/db/encryption.ts:
  12-24,40-46`).
- MCP OAuth access + refresh tokens stored unencrypted
  (`packages/core/src/db/schema.postgres.ts:1057-1059` and :827-829).
- MCP bearer/API tokens in `mcpServers.data` JSON without guaranteed
  encryption.
- JWT secret + master secret persisted to `~/.agor/config.yaml` with
  no explicit `0600` (`apps/agor-daemon/src/index.ts:328-338`).
- `agor.db` created with SQLite default file mode.
- Anonymous access defaults to enabled
  (`packages/core/src/config/config-manager.ts:131`;
  `apps/agor-daemon/src/strategies/anonymous.ts:32-36`).
- `/config` service returns full config tree to any authenticated
  principal; patch propagates credentials into `process.env`
  (`apps/agor-daemon/src/services/config.ts:31-44,61-64,136-235`).
- Session-token strategy logs token previews
  (`apps/agor-daemon/src/auth/session-token-strategy.ts:44-51,80,88,
  114,141,153-154,162,166,186`).
- Hardcoded test secrets in committed files
  (`apps/agor-daemon/src/auth-jwt-integration.test.ts:63,189,588`).

### Unix isolation

- Shell injection in `group-manager.ts` `addUserToGroup` /
  `removeUserFromGroup` / `createGroup` / `isUserInGroup`.
- TOCTOU on predictable `/tmp/agor-env-<shortId>.sh`
  (`apps/agor-daemon/src/services/terminals.ts:~100`) — local attacker
  can pre-create a symlink; daemon follows.

### Docker

- Default `CORS_ORIGIN=*` in both dev and prod compose.
- Daemon binds `0.0.0.0` by default in prod; combined with admin/admin
  this ships remotely-reachable default creds.
- SSH server with `PasswordAuthentication yes` baked into base image.
- Hardcoded dev passwords (`alice:admin`, `bob:admin`).
- Floating base image tags (`node:22-slim`, `postgres:16-alpine`)
  without digest pinning.
- `npm install -g agor-live@latest` in prod stage.
- `gh` CLI and Zellij pulled via `curl | tar` without checksum.
- Postgres user granted `SUPERUSER` in init script.
- Default Postgres password `agor_dev_secret` hardcoded.
- Entire repo bind-mounted RW at `/app` (dev).
- `extra_hosts: host-gateway` grants direct route to host services.
- `sudoers` wildcards on `find *`, `useradd *`, `tee /home/*/.agor/*`.

### Dependencies (selected HIGH — 36 total)

- `handlebars@4.7.8` (direct) — AST injection.
- `systeminformation` cmd injection in `wifi.js` + `versions()`.
- `next@14.2.35` DoS (RSC + Server Components).
- `rollup<4.59.0` via `tsup` — path traversal file write.
- `hono@4.11.9` — serveStatic path traversal (+ 10 moderate).
- `@hono/node-server<1.19.10` — encoded-slash authz bypass.
- `express-rate-limit@8.2.0-8.2.1` — IPv4-mapped IPv6 bypass.
- `undici@7.21.0` — WebSocket unbounded memory (3 HIGH).
- `socket.io-parser<4.2.6` — unbounded binary attachments.
- `fast-xml-parser` DoS (via cloudfront SDK).
- `path-to-regexp` ReDoS (via express 5 router).
- `picomatch` / `minimatch` ReDoS.
- `lodash(-es)` — `_.template` injection.
- `vite` dev server WebSocket file read + `server.fs.deny` bypass.
- `@xmldom/xmldom<0.9.9` — CDATA injection.

---

## 5. MEDIUM / LOW / INFO

Rolled up with full detail in Appendix A. Highlights:

### Defence-in-depth gaps (MEDIUM)

- JWT access token TTL = 7 days.
- bcrypt rounds = 10 (below OWASP's 12+).
- API-key strategy has no rate limit.
- `X-Forwarded-For` trusted without `trust proxy` config.
- CSS sanitiser `sanitizeCss.ts` bypassable via CSS escape sequences.
- Artifact publish-path TOCTOU
  (`apps/agor-daemon/src/services/artifacts.ts:482-501`) — lacks
  per-component `fs.realpath`.
- `JSON.parse` of artifact manifest without zod schema.
- GitHub App private key not required to be `0600` / encrypted.
- OAuth in-memory token cache lacks strict expiry / tenant scoping.
- Default Feathers error handler returns stack traces.
- Admin credentials echoed to container logs.
- `apt` packages unpinned; dev tooling shipped in prod stage.
- API keys passed via `environment:` section (`docker inspect`).
- `pnpm install` runs `postinstall` scripts during build (no
  `--ignore-scripts`).
- `rm -f /home/*/agor/worktrees/*` in sudoers — daemon bug can wipe
  any user's data.
- `.git` chmod'd world-readable in simple mode
  (`packages/executor/src/commands/unix.ts:929`).
- `files.ts` adds worktree path to daemon's GLOBAL `safe.directory`
  (`apps/agor-daemon/src/services/files.ts:79`).

### Positive confirmations (INFO)

- PR #1008 recursive-ACL fix correctly applied; ACL now shallow on
  repo root + recursive on `.git`.
- Daemon supplementary-group staleness handled via per-user ACLs
  (`packages/core/src/unix/group-manager.ts` `setUserAcl`).
- chpasswd stdin transmission verified free of argv/`ps` leakage.
- `agor-live/build.sh` performs atomic dist swap under `set -e`.
- Lockfile committed and `--frozen-lockfile` enforced in CI.
- No committed npm secrets, no typosquatted dep, no malicious
  postinstall (only benign `agor-live/scripts/postinstall.js`).

---

## 6. Cross-domain patterns

1. **Flag-gated RBAC (generalisation of PR #1010).** Worktree RBAC
   is only enforced when `execution.worktree_rbac === true`, and the
   default is `false`. The same anti-pattern recurs in terminals
   (`services/terminals.ts:194-218`), uploads
   (`register-routes.ts:1099-1127`), `/file`, `FilesService.find`,
   and implicitly in the `messages.find` / `tasks.find` gap. PR #1010
   fixed this for uploads on the `created_by` side; the underlying
   pattern is still present. Recommendation: enforce worktree RBAC
   unconditionally when a `worktreeId` is in scope; treat
   `worktree_rbac=false` as "grant all members every tier", not "skip
   hooks".

2. **`unix_username` → shell-injection chain.** `unix_username` is a
   user-supplied identifier that flows straight into sudo invocations
   across the executor, run-as-user, terminals, group-manager, and
   chown paths. `isValidUnixUsername` exists but is not consistently
   enforced at every call site. Result: one weak validator → root.

3. **Deterministic / non-expiring tokens.** MCP tokens have no
   `exp`, `iat`, or revocation; session tokens are in-memory only.
   Leaked tokens are effectively permanent. Solve by adding `jti` +
   `exp` and a persisted allowlist/revocation ledger.

4. **Secrets in argv / stdout.** Recurs across domains: API keys in
   `bash -c` argv + `console.log` (Secrets), JWT-secret prefix
   logged at startup (Secrets + Web), session-token previews in auth
   strategy logs (AuthN), admin password in container stdout
   (Docker), token-name list logged for impersonated spawns (MCP).

5. **Sudoers wildcards.** Five catastrophic wildcards cluster in one
   file. A single constrained wrapper script closes all of them.

6. **Default-insecure configuration compounding.** `allowAnonymous`
   defaults to true, `worktree_rbac` defaults to false, web terminal
   defaults to enabled, `AGOR_MASTER_SECRET` is optional
   (silent plaintext fallback), `CORS_ORIGIN=*` is the shipped
   default. In combination these produce the "Default-deploy
   takeover" chain. Each individual default has a rationale
   (local-dev UX); collectively they are not a defensible production
   posture.

7. **Network-exposed admin bootstrap.** Daemon on `0.0.0.0` +
   admin/admin + wildcard CORS is the single largest deployment
   hazard; hardening `docker-compose.prod.yml` and the entrypoint to
   refuse to start under those conditions would close it at one
   choke-point.

8. **Raw SQL / unscoped service queries.** `agor_messages_list` is
   the acute example, but `boards.find`, `mcp-servers.find`,
   `artifacts.find` all return unfiltered rows. Move visibility
   filtering into `before:find` (SQL-level) rather than client-side
   post-filter.

9. **`sessions.created_by` used as authorisation anchor.** The
   spawn/fork identity-borrowing path, the upload path (pre-#1010),
   and the MCP token-minting path all treat `parent.created_by` as
   the executing principal. Identity should be the requesting
   principal unless admin/owner explicitly delegates.

10. **Supply-chain hardening is right mechanism, wrong state.**
    `pnpm.overrides` exists in `package.json:56-87` but is missing
    patches for protobufjs, hono 4.12.14, undici 7.25.0, axios,
    path-to-regexp, ajv, diff, follow-redirects, systeminformation,
    etc. Additionally, `pnpm audit --audit-level=high` is not in CI
    and GitHub Actions are pinned by major tag, not 40-char SHA.

---

## 7. Recommended next steps

### Fix immediately (catastrophic, low-effort)

1. **Remove `NOPASSWD:ALL` from `docker/Dockerfile:78`**; let the
   scoped `agor-daemon.sudoers` be the entire policy.
2. **Stop bind-mounting host `~/.ssh`** in
   `docker-compose.yml:157`; make it explicit opt-in.
3. **Refuse to boot with default admin/admin** and stop echoing
   creds to stdout (`docker/docker-entrypoint-prod.sh:22-34`).
4. **Disallow `CORS_ORIGIN=*` with `credentials:true`**
   (`apps/agor-daemon/src/setup/cors.ts:80-83`,
   `apps/agor-daemon/src/index.ts:243`). Require explicit origin
   list in production.
5. **Require `Authorization: Bearer` for socket.io + MCP**; reject
   `?sessionToken=` query (`apps/agor-daemon/src/mcp/server.ts:
   407-414`). Authenticate socket connection and validate
   `socket.feathers.user.user_id` matches every `terminal:*`
   channel join/emit (`apps/agor-daemon/src/setup/socketio.ts:
   97-109,220-275`).
6. **Require auth + state nonce on `/api/github/setup/callback`**
   (`apps/agor-daemon/src/services/github-app-setup.ts:117-150`).
7. **Add scoped `before:find` hooks to `tasks`, `messages`,
   `boards`, `mcp-servers`, `board-objects`, `artifacts`, `files`,
   `terminals`**. `find` without scope is the single biggest IDOR
   class in the codebase.
8. **Route `agor_messages_list` through `app.service('messages').
   find(...)`** with `ctx.baseServiceParams`
   (`apps/agor-daemon/src/mcp/tools/messages.ts:108-112`).
9. **Collapse sudoers wildcards** with a wrapper script
   (`/usr/local/sbin/agor-user-admin <verb> <arg>`) rejecting
   `-u 0`, `-o`, `-G root`, `-exec`, etc. Targets
   `docker/sudoers/agor-daemon.sudoers:57-71,130`.
10. **Extend `pnpm.overrides`**: `protobufjs>=7.5.5`,
    `handlebars>=4.7.9`, `hono>=4.12.14`, `@hono/node-server>=1.19.14`,
    `undici>=7.25.0`, `path-to-regexp>=8.4.2`,
    `systeminformation>=5.31.0`, `ajv>=8.18.0`,
    `brace-expansion>=5.0.5`, `diff>=8.0.3`,
    `follow-redirects>=1.16.0`, `axios>=1.15.0`,
    `express-rate-limit>=8.2.2`, `lodash>=4.18.1`,
    `socket.io-parser>=4.2.6`, `picomatch>=4.0.4`,
    `@xmldom/xmldom>=0.9.9`.

### Fix soon (critical post-auth chains)

11. Validate `unixUsername`, `worktreeName`, `branchRef`, `asUser`,
    `cwd` at every call site; convert every `execSync`/`exec`
    shell-string to `execFile`/`spawn` argv. Highest-priority files:
    `packages/executor/src/commands/unix.ts`,
    `packages/core/src/unix/run-as-user.ts`,
    `packages/core/src/unix/user-manager.ts`,
    `packages/core/src/unix/group-manager.ts`,
    `packages/core/src/git/index.ts`,
    `packages/executor/src/commands/zellij.ts`,
    `apps/agor-daemon/src/services/terminals.ts`.
12. Whitelist env keys in `packages/executor/src/cli.ts:139-144`;
    explicitly reject `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `PYTHON*`.
13. Stop forwarding API keys via sudo argv — pipe via stdin or
    0600-mode env file owned by target user
    (`packages/core/src/unix/run-as-user.ts:193-211`,
    `apps/agor-daemon/src/utils/spawn-executor.ts:260-289`); remove
    all `console.log` of secrets + secret-name enumerations.
14. Mint child MCP JWTs with reduced-privilege scope + short TTL;
    add `jti`/`exp` and a persisted revocation list
    (`apps/agor-daemon/src/mcp/tokens.ts:35-58,140-146`).
15. Stamp spawn/fork child sessions with the requesting user's
    identity, not `parent.created_by`
    (`apps/agor-daemon/src/services/sessions.ts:205,383`).
16. Make `worktree_rbac: true` the default;
    `unix_user_mode: simple` + `allow_web_terminal: true` refuse
    to start without explicit `acknowledge_insecure`.
17. Make `AGOR_MASTER_SECRET` mandatory in production; encrypt
    OAuth access/refresh tokens and all MCP bearer fields.

### Deeper investigation

18. Audit the full list of Feathers service hooks for other
    unscoped `find` endpoints and `created_by`-only gating.
19. Threat-model the web terminal + upload + artifacts path end-to-end
    under `worktree_rbac=false` to establish whether a "soft" mode is
    defensible at all or should be removed.
20. Inventory every `execSync`/`exec` shell-string in the monorepo;
    migrate to argv-form `spawn`/`execFile` with a central helper.
21. Decide on CSP / `X-Frame-Options` / `helmet()` rollout for the UI
    + daemon; tokens in `localStorage` are only safe behind strict
    CSP, and moving to HttpOnly+SameSite cookies is preferable.
22. Add `pnpm audit --audit-level=high` as a required CI step;
    pin all third-party GitHub Actions by 40-char SHA; add Dependabot
    / Renovate config.
23. Review the Handlebars-rendered `.agor.yml` shell-command surface
    (`packages/executor/src/commands/git.ts:321-352`). Repo-level
    `start_command`/`stop_command`/`logs_command`/`nuke_command`
    fields are effectively "commit-to-RCE" — static admin-side
    config or heavy sanitisation is required.
24. Assess whether external MCP server URLs should be validated
    against a private-address / loopback / link-local blocklist and
    an admin allowlist for non-public hosts.

### Non-findings re-verified (no change needed)

- PR #1008 recursive-ACL fix is correct.
- `chpasswd` password material via stdin is correct (no argv/`ps`
  leakage).
- `build.sh` atomic dist swap is correct.
- No malicious postinstall scripts; only benign
  `packages/agor-live/scripts/postinstall.js`.

---

## Appendix A — Per-domain source reports

The 8 subsession reports, reproduced as a quick-reference block. Each
report lists line-level detail. If a finding references a file / line
not reproduced above, see the corresponding domain source.

- **Docker & container:** `docker/Dockerfile`, `docker-compose*.yml`,
  `docker/docker-entrypoint*.sh`, `docker/sudoers/agor-daemon.sudoers`,
  `docker/postgres-init.sql`, `.dockerignore`, `.env.postgres`.
  (Session `dd55886e`.)
- **Web security:** `apps/agor-daemon/src/setup/{cors,socketio}.ts`,
  `apps/agor-daemon/src/services/github-app-setup.ts`,
  `apps/agor-daemon/src/register-{routes,services}.ts`,
  `apps/agor-daemon/src/utils/upload.ts`,
  `apps/agor-daemon/src/mcp/server.ts`, `apps/agor-ui/index.html`,
  `apps/agor-ui/src/App.tsx`,
  `apps/agor-ui/src/components/SessionCanvas/canvas/ArtifactNode.tsx`.
  (Session `03602721`.)
- **Injection / input validation:**
  `packages/executor/src/commands/{unix,zellij}.ts`,
  `packages/core/src/unix/{run-as-user,user-manager}.ts`,
  `packages/core/src/git/index.ts`,
  `apps/agor-daemon/src/services/{terminals,artifacts}.ts`,
  `apps/agor-ui/src/utils/sanitizeCss.ts`,
  `packages/core/src/db/database-wrapper.ts`,
  `apps/agor-daemon/src/utils/spawn-executor.ts`,
  `packages/core/src/config/{agor-yml,env-resolver}.ts`.
  (Session `b6e4b1bc`.)
- **AuthN/AuthZ & RBAC:** `apps/agor-daemon/src/register-hooks.ts`,
  `apps/agor-daemon/src/utils/{authorization,worktree-authorization}.ts`,
  `apps/agor-daemon/src/services/{files,file,terminals,
  session-token-service}.ts`,
  `apps/agor-daemon/src/auth/{api-key,session-token}-strategy.ts`,
  `apps/agor-daemon/src/strategies/anonymous.ts`,
  `apps/agor-daemon/src/mcp/tokens.ts`,
  `apps/agor-daemon/src/register-routes.ts`,
  `packages/core/src/db/repositories/user-api-keys.ts`. (Session
  `90061d8b`.)
- **MCP & executor boundary:**
  `apps/agor-daemon/src/mcp/tools/{messages,search,users,worktrees,
  cards,boards,sessions,artifacts,mcp-servers}.ts`,
  `apps/agor-daemon/src/mcp/{server,tokens}.ts`,
  `apps/agor-daemon/src/services/{sessions,mcp-servers}.ts`,
  `packages/executor/src/cli.ts`,
  `packages/executor/src/commands/{git,zellij}.ts`,
  `packages/executor/src/sdk-handlers/base/mcp-scoping.ts`,
  `packages/core/src/db/{encryption,repositories/
  user-mcp-oauth-tokens}.ts`,
  `packages/core/src/tools/mcp/oauth-mcp-transport.ts`. (Session
  `54f27dcd`.)
- **Dependencies:** `package.json`, `pnpm-lock.yaml`, `pnpm.overrides`,
  `.github/workflows/*.yml`,
  `packages/agor-live/scripts/postinstall.js`. (Session `597fab60`.)
- **Secrets management:**
  `apps/agor-daemon/src/utils/spawn-executor.ts`,
  `packages/core/src/unix/run-as-user.ts`,
  `apps/agor-daemon/src/{index,startup,register-routes,
  register-services}.ts`,
  `packages/core/src/{db/encryption,config/config-manager,
  db/schema.postgres}.ts`,
  `apps/agor-daemon/src/services/config.ts`,
  `apps/agor-daemon/src/auth/{api-key,session-token}-strategy.ts`,
  `apps/agor-daemon/src/mcp/tokens.ts`,
  `apps/agor-daemon/src/auth-jwt-integration.test.ts`,
  `packages/executor/src/commands/git.ts`,
  `packages/core/src/gateway/connectors/github.ts`,
  `packages/core/src/tools/mcp/oauth-mcp-transport.ts`. (Session
  `5391ba0a`.)
- **Unix isolation & filesystem:**
  `docker/sudoers/agor-daemon.sudoers`,
  `packages/core/src/unix/{group-manager,run-as-user,user-manager,
  command-executor,id-lookups,unix-integration-service}.ts`,
  `apps/agor-daemon/src/services/{terminals,files}.ts`,
  `packages/core/src/config/config-manager.ts`,
  `packages/executor/src/commands/unix.ts`,
  `apps/agor-cli/src/commands/admin/sync-unix.ts`,
  `packages/agor-live/build.sh`. (Session `dc7c110b`.)

---

_Analysis only. No code changes made by this review. Report produced
by the security-review orchestrator session on branch
`security-review-coordinator`._
