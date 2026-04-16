# Daemon Supplementary-Group Staleness — Analysis

## Problem Statement

The Agor daemon runs as the long-lived `agorpg` user. Every time a new repo or
worktree is registered, the executor calls `usermod -aG agor_rp_*` /
`usermod -aG agor_wt_*` to add `agorpg` to a fresh per-resource Unix group.
Those changes land in `/etc/group` immediately, but the **already-running
daemon process** never sees them: a process's supplementary group list is
loaded once via `initgroups(2)` at the time the parent shell created it, and
nothing in the kernel re-reads `/etc/group` for a live PID.

In normal operation the daemon does not feel this because almost every file
inside `~/.agor/repos/` and `~/.agor/worktrees/` is owned by `agorpg`
(user-bit access wins), and the executor sets a default POSIX ACL granting
`agorpg` explicit `rwX` on every directory it creates
(`packages/core/src/unix/group-manager.ts:256` `setUserAcl`). The user
incident today exposed an edge case: a loose object inside a repo's
`.git/objects/` directory was owned by user `max`, group
`agor_rp_5e4aa6a8`, mode `0770`. The directory's default ACL evidently did
not propagate to that file (could be a fresh fetch into a path created
before the ACL was put in place, or an external `git fetch` performed by
`max` outside Agor). With no daemon-user ACL and stale supplementary
groups, the daemon dropped to the `other` permission bits (`---`),
`open(2)` returned `EACCES`, and `git rev-parse HEAD` reported the object
as "loose object … is corrupt" — the misleading error path git takes for
permission failures on the object DB.

The fix surface is therefore:

1. Stop the daemon from doing any **in-process** git/filesystem read on
   paths whose ACL might require a recently-added group, OR
2. Make sure the daemon's in-process group list is always current, OR
3. Make sure ACLs always grant the daemon user explicit access (already
   intended, but evidently incomplete in practice).

## Call-Site Inventory — In-Process Git/FS in the Daemon

These all execute inside the daemon's PID, with whatever supplementary
groups it had at startup.

### Critical (root-cause site)

| Path | Operation | Notes |
|------|-----------|-------|
| `apps/agor-daemon/src/services/repos.ts:377` | `simpleGit(repo.local_path)` | Pre-flight in `createWorktree`. |
| `apps/agor-daemon/src/services/repos.ts:383` | `git.fetch(['origin'])` | Pre-flight, talks to remote and writes `.git/objects/`. |
| `apps/agor-daemon/src/services/repos.ts:384,388` | `git.branch(['-r'])`, `git.branch()` | Reads `.git/refs`/packed-refs. |
| `apps/agor-daemon/src/services/repos.ts:414` | `git.branch()` | Same as above on the second pre-flight branch. |
| `apps/agor-daemon/src/services/repos.ts:419,491` | `listWorktrees(repo.local_path)` | `git worktree list --porcelain`, hits `.git/worktrees/`. |

This block is the one that produced today's "loose object … corrupt"
failure: any of `git.fetch` / `git.branch` will read or write under
`.git/objects/` and fail with EACCES if the daemon lacks the repo group
and an explicit ACL.

### Secondary (in-process git that can hit the same class of bug)

| Path | Operation | Trigger |
|------|-----------|---------|
| `apps/agor-daemon/src/services/repos.ts:88,303` | `getRemoteUrl(path)` | `agor repo add`. |
| `apps/agor-daemon/src/services/repos.ts:271` | `isValidGitRepo(repoPath)` | `agor repo add`. |
| `apps/agor-daemon/src/services/repos.ts:285` | `getDefaultBranch(repoPath)` | `agor repo add`. |
| `apps/agor-daemon/src/services/repos.ts:826,835,860` | `deleteWorktreeDirectory`, `deleteRepoDirectory` | Repo delete with cleanup. Walks the tree as the daemon process. |
| `apps/agor-daemon/src/services/files.ts:70` | `simpleGit(worktree.path).raw(['ls-files', '-z'])` | File-autocomplete service. Hot path. |
| `apps/agor-daemon/src/mcp/tools/sessions.ts:677-679` | `getGitState(worktree.path)`, `getCurrentBranch(worktree.path)` | MCP `agor_sessions_create`. |
| `apps/agor-daemon/src/mcp/tools/worktrees.ts:773-775` | `getGitState(worktree.path)`, `getCurrentBranch(worktree.path)` | MCP zone-trigger spawn path. |

### Already mitigated (sudo wrapper exists)

| Path | Operation | Notes |
|------|-----------|-------|
| `apps/agor-daemon/src/utils/git-shell-capture.ts` | `sudo -n -u agorpg git -C … rev-parse / status` | The dedicated workaround. Wraps git in `sudo -u` so each call gets a fresh `initgroups()`. |
| `apps/agor-daemon/src/register-routes.ts:845-862` | Uses `captureGitStateViaShell` for task git-state at prompt start. |
| `apps/agor-daemon/src/register-hooks.ts:1311-1326` | Uses `captureGitStateViaShell` for callback session git-state. |

The shell-capture utility's docblock literally explains the bug:
"the daemon process has stale Unix group memberships from startup… in-process
simple-git calls fail for repos whose ACLs rely on recently-added groups."
This is a partial, ad-hoc mitigation — it covers SHA capture, nothing else.

## Executor Boundary — Verified

`spawnExecutor` in `apps/agor-daemon/src/utils/spawn-executor.ts` builds the
spawn command via `buildSpawnArgs` (`packages/core/src/unix/run-as-user.ts:174-213`).
When `asUser` is set, `buildSpawnArgs` returns:

```
sudo -n -u <asUser> bash -c "env … node executor/cli.js --stdin"
```

`sudo -u` calls `initgroups(2)` for the target user before running the
command, which re-reads `/etc/group` from disk. The docblock at
`run-as-user.ts:8-13` explicitly relies on this.

So: **executor invocations launched with `asUser` always start with fresh
groups.** Verified for the git paths via:

- `apps/agor-daemon/src/services/repos.ts:702-731` (`createWorktree` → `git.worktree.add`,
  `asUser` is resolved via `resolveGitImpersonationForUser`, which always
  returns the daemon user — `apps/agor-daemon/src/utils/git-impersonation.ts:30-45`).
- `apps/agor-daemon/src/services/worktrees.ts:374-406` (`remove` → `git.worktree.remove`,
  same impersonation helper).

Two important caveats that I verified by reading the call sites:

1. **`asUser` is conditional.** In `repos.ts:702`,
   `asUser = userId ? await resolveGitImpersonationForUser(this.db, userId) : undefined;`.
   For an anonymous request (no `userId`) the executor is spawned as a
   **direct child of the daemon, inheriting the daemon's stale groups**.
   That window is small in practice (most calls come from authenticated
   users) but it is real.
2. **Some executor spawns deliberately omit `asUser`.** In
   `apps/agor-daemon/src/services/worktrees.ts` the `clean`
   (line 472), `delete` (line 502), and `unarchive` (line 641) paths spawn
   the executor without any `asUser`, with the comment "No user
   impersonation for infrastructure operations". These also inherit stale
   groups. They are mostly fine because they target paths the daemon
   user owns (and that have the daemon-user ACL), but they share the
   same vulnerability class.
3. **Prompt sessions inherit stale groups in `simple` mode.**
   `apps/agor-daemon/src/register-services.ts:660-698` spawns the prompt
   executor with `asUser: executorUnixUser || undefined`. In `simple`
   mode `executorUnixUser` is empty, so the executor inherits whatever
   groups the daemon had at startup. In `insulated`/`strict` it gets
   fresh groups via `sudo -u`.

So the executor-boundary hypothesis is correct in the **typical** RBAC
configuration (insulated/strict + authenticated git ops), and is the
existing reason today's incident did not manifest in `git.worktree.add`
itself. It just doesn't help the in-process pre-flight before that spawn.

## Existing Defensive Layer Worth Knowing

`packages/core/src/unix/group-manager.ts:256-261` defines `setUserAcl`:

```
sudo -n setfacl -R -m u:<daemonUser>:rwX <path>
sudo -n setfacl -R -d -m u:<daemonUser>:rwX <path>
```

The default-ACL line is meant to make the daemon user immune to group
staleness for any file inside that tree. The executor calls it for every
new worktree (`packages/executor/src/commands/unix.ts:843`) and every
synced repo (`unix.ts:779`). Today's incident implies one of:

- The repo tree was provisioned before `setUserAcl` was wired in, or
  before the file in question was created underneath a path with the
  default ACL, OR
- The filesystem doesn't honor default ACLs for that subdirectory (e.g.,
  `.git/objects/<xx>/` was created by an external git-as-user invocation
  on a parent that lost its default ACL), OR
- A `chmod` somewhere stripped it.

I couldn't verify which of these applied to the user's machine without
inspecting `getfacl` on the affected object directory — flagging as
uncertainty.

## Options

### A. Move group-sensitive git reads into the executor

Replace each in-process `simpleGit(...)` and `getGitState(...)` call with a
fire-and-forget (or short-lived synchronous) executor invocation.

- **Pros:** Single, already-existing trust boundary. Executor is already
  the canonical place for filesystem ops. No new sudo wrapper. Naturally
  composes with future remote-executor (k8s) modes.
- **Cons:** The pre-flight reads in `repos.ts:377-510` are *synchronous
  and block the API response* (the user gets immediate feedback if the
  source branch doesn't exist). Routing them through executor means a
  per-call process spawn (~50–200ms cold), which is significant on the
  hot path. Also `files.ts` runs on every keystroke of file
  autocomplete — spawning an executor per keystroke is a non-starter
  unless we add a long-lived helper.

### B. `sudo -n -u <daemonUser>` shell-out for in-process git reads

Generalize `git-shell-capture.ts` from "SHA + branch + dirty" to "any read
that looks at a path that might depend on a recently-added group".

- **Pros:** This is the pattern that already exists, the daemon is already
  set up for it (sudoers entry covers `agorpg ALL=(%agor_users) NOPASSWD: ALL`),
  and per-call cost is low (~10–30ms).
- **Cons:** Loses the ergonomics of `simple-git` (parsed objects, typed
  return values). Each new use-case needs hand-rolled command + parsing
  (`git branch --list --porcelain`, `git worktree list --porcelain`,
  `git ls-files -z`, etc.). Surface area for shell-injection bugs grows
  if not centralized. Doesn't help non-git in-process file reads
  (`file.ts`, `context.ts`, `artifacts.ts`).

### C. Re-exec the daemon when a new `agor_rp_*` / `agor_wt_*` group is created

The daemon already triggers `usermod -aG` (via the `unix.sync-*` executor
commands). After a successful sync, signal the daemon to `process.exit(0)`
under a supervisor that restarts it (systemd `Restart=on-success`,
docker-compose `restart: unless-stopped`).

- **Pros:** Cures the disease at the source. Future code paths get fresh
  groups without any per-callsite work. Conceptually minimal (~50 LoC).
- **Cons:** Disruptive: every WebSocket reconnects, in-flight requests
  fail, executor processes are orphaned (or reparent to init), running
  prompt sessions lose their daemon-side bookkeeping. Race-y: a
  `git.worktree.add` arriving between the `usermod` and the daemon
  restart still has stale groups for its pre-flight. Operationally not
  great for a "multiplayer" UX where tabs disconnect on every new
  worktree.

### D. `CAP_SETGID` + periodic `setgroups()` self-refresh

Run the daemon with the Linux capability to call `setgroups(2)`, parse
`/etc/group` on a timer or in response to a fs notify, and reset the
process group list to match.

- **Pros:** Self-healing; no per-callsite work; no restart.
- **Cons:**
  - `setgroups()` is not exposed by the Node stdlib. Requires a native
    addon (e.g., `posix` package, which is unmaintained) or `child_process.exec('id')`-equivalent gymnastics.
  - `AmbientCapabilities=CAP_SETGID` requires `NoNewPrivileges=false` in
    the systemd unit, which loosens the security posture.
  - Doesn't compose with the docker / docker-compose deployment unless
    we add `cap_add: [SETGID]`.
  - We've also got to be careful not to drop a group the daemon needs
    *while a request is in flight*; if a request thread is mid-syscall
    when `setgroups()` runs, behavior is well-defined (kernel reads
    creds at syscall entry) but worth verifying.

### E. Always write loose objects as the daemon user

Make sure every git op runs through code paths that produce daemon-owned
files. We mostly already do this — the executor runs as the daemon user
(via `sudo -u agorpg`), and git operations that write objects happen via
the executor — but the failure mode is exactly when *another* user
writes objects (e.g., a developer running `git fetch` in the worktree
directly as themselves outside Agor, or a session executor running as a
different Unix user under `strict` mode).

- **Pros:** Reinforces the "daemon-owned files only" assumption that
  the user-bit fast path relies on.
- **Cons:** Doesn't help when external tooling (humans, CI, other
  services) touch the worktree. Actively conflicts with `strict` mode
  where session executors *deliberately* run as the user, not the
  daemon, and therefore write user-owned objects.

### F. Startup warning ("stale-shell detection")

At daemon boot, read `/etc/group` membership for the daemon user, compare
to `process.getgroups()`, and log a loud warning + structured event if the
process is missing groups it should have. Optionally fail-fast in
production.

- **Pros:** Trivial. Catches the developer-style "started daemon from a
  shell that pre-dates a new group" foot-gun. Useful telemetry.
- **Cons:** Pure detection, no cure. Doesn't help when the gap opens
  *during* the daemon's lifetime (which is the common production case
  — every `agor repo add` widens the gap).

## Recommendation

**A short-term fix layered into a medium-term restructure:**

1. **Short term (low-risk patch):** extend the existing
   `git-shell-capture.ts` pattern (Option B) to cover the specific
   `repos.ts createWorktree` pre-flight (lines 377-510) plus
   `listWorktrees`. Concretely:
   - Wrap `git.fetch`, `git.branch`, `listWorktrees` for that block in a
     `runGitAsDaemon(repoPath, ['fetch', 'origin'])` helper that uses
     `sudo -n -u <daemonUser> git -C <path> …` and parses output.
   - Keep the helper colocated with `git-shell-capture.ts` so we have one
     "stale-groups-safe git wrapper" file. Rename it to something like
     `git-shell.ts`.
   - Add the same wrapper for `files.ts:70` (`git ls-files -z`) — this
     is a hot autocomplete path and is also vulnerable.
   - Per-call sudo overhead is acceptable here (~10–30ms vs. typical
     git-fetch cost of seconds).

2. **Concurrent (cheap, useful):** add Option F as a startup check.
   `console.warn` + structured event when the daemon's
   `process.getgroups()` is missing any `agor_rp_*` or `agor_wt_*` group
   that `/etc/group` says `agorpg` belongs to. This makes it loudly
   obvious when an admin should restart the daemon.

3. **Medium term (the right architectural move):** Option A — drive all
   group-sensitive reads through the executor. Hold this until we have
   either a long-lived "daemon-helper" executor (so we don't pay
   process-spawn cost per autocomplete keystroke), or until autocomplete
   moves to a different ingestion model (e.g., precomputed file index).
   That refactor is bigger than this ticket and shouldn't block the
   short-term fix.

I would **not** pick C (re-exec) for the headline issue: the
multiplayer-UX cost of reconnecting every websocket each time someone
clicks "new worktree" is too high, and the race window between
`usermod` and restart still leaves the immediate request broken.

I would **not** pick D (CAP_SETGID) unless the long-running
process problem becomes endemic across many subsystems. The blast
radius of giving the daemon ambient capabilities + a non-stdlib native
binding outweighs the elegance.

E is already partially in place (executor runs as daemon user via
sudo); explicitly chasing it further mostly amounts to "tell users not
to run external git commands as themselves in worktrees", which is not
enforceable.

### Why B → A and not directly A

A is the right end state, but the current pre-flight in
`createWorktree` is *synchronous and user-facing* — its whole purpose
is to give an immediate error before the fire-and-forget executor
spawn. Moving it to the executor changes the failure UX (errors come
back over WebSocket, asynchronously) and that's a separate product
decision. B is a localized, reversible patch that keeps the current
UX, fixes the bug now, and doesn't paint A into a corner.

## Related Operations Worth Auditing

These read worktree files in-process, with the daemon's group list,
without a sudo workaround. They aren't the cause of today's incident,
but they belong on the same audit checklist:

- `apps/agor-daemon/src/services/file.ts` — `readFile`, `readdir`,
  `lstat`, `realpath` of arbitrary worktree paths (file-tree browser /
  preview). Reads files that may have been written by session
  executors running as the user.
- `apps/agor-daemon/src/services/context.ts` — recursively reads
  `<worktree>/context/**/*.md`. Same risk as `file.ts`.
- `apps/agor-daemon/src/services/artifacts.ts` — `fs.readFileSync`,
  `fs.readdirSync` over a `folderPath` resolved from user input
  (validated to be inside a worktree or `/tmp`). Same risk class.
- `packages/core/src/git/index.ts deleteRepoDirectory` /
  `deleteWorktreeDirectory` invoked from `repos.ts:826-872`: walks
  trees as the daemon process. Group-staleness here causes EACCES
  during cleanup, which then becomes a partial-deletion failure mode.

For each of these, the failure surface is "user-owned file inside an
ACL-protected directory that the daemon cannot reach via group". The
existing `setUserAcl` defense should cover them in principle — but the
fact that today's incident hit means we cannot rely on it being
universally present, and either:
(a) audit `setUserAcl` coverage and make it bulletproof, or
(b) route these reads through the executor too (Option A applied
broadly).

I lean toward (a) for these read-only paths because they're hot and
synchronous — losing the in-process `readFile` is a real ergonomic
hit. Confirm via `getfacl` on a few representative worktree directories
that the default ACL is in place; if it isn't, fix the executor's
provisioning to set it everywhere it should.

### Uncertainty I couldn't resolve from the code alone

- Whether the user's incident-affected loose object lacked the
  daemon-user default ACL because the ACL was never set, or because
  something stripped it. Would need `getfacl ~/.agor/repos/<slug>/.git`
  + the affected object's parent directory on the user's machine.
- Whether `process.getgroups()` in Node returns the cached or live
  list. Reading the libuv source it's the cached list (it just calls
  `getgroups(2)`, which returns the kernel's per-process credentials);
  this is fine for the proposed startup check but worth re-verifying
  before relying on it.
- Whether the `clean`/`delete`/`unarchive` no-`asUser` executor spawns
  in `worktrees.ts` have ever caused a real failure, or whether the ACL
  defense has covered them so far. They are a latent risk regardless.
