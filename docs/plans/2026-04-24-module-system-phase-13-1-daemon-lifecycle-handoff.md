# Phase 13.1 Handoff — Daemon Lifecycle Primitives

**Shipped**: 2026-04-24 via
[PR #15](https://github.com/utopyk/rn-dev-cli/pull/15). Squash-merged
to `main` as `2a3c671`.

## Context

Phase 13.1 opens the daemon-refactor arc. The overall goal (design spec:
[`design/daemon-refactor:docs/superpowers/specs/2026-04-24-daemon-refactor-design.md`](../superpowers/specs/2026-04-24-daemon-refactor-design.md))
is to unify service orchestration under a per-worktree daemon so that
GUI (Electron), TUI, and MCP are all equal clients over one
Unix-domain socket — instead of today's split where the TUI path talks
to `<wt>/.rn-dev/sock` and the Electron path runs services in-process
with no socket at all.

13.1 is **empty-but-working**: a real daemon binary that boots, binds
the socket, answers two RPCs, and tears down cleanly. Nothing in the
existing tree uses the daemon yet. Services (Metro / DevTools /
ModuleHost) move in during 13.2, and clients flip to
`connectToDaemon()` in 13.3 (TUI) and 13.4 (Electron).

## What shipped

### `src/daemon/`

- **`index.ts`** — daemon entry for `rn-dev daemon <worktree>`. Without
  `--foreground`, re-spawns itself `detached: true` + `stdio: "ignore"`
  + `cwd: worktree` and exits 0 (the POSIX `fork + setsid + close
  stdio` shape Node exposes). With `--foreground`, runs the loop
  in-process: mkdir `.rn-dev/` at mode `0o700`, acquire a
  `ModuleLockfile` on `pid`, bind `IpcServer` at `sock` under
  `umask(0o177)` so the UDS is `0o600` from the first `listen()`
  byte, dispatch `daemon/ping` + `daemon/shutdown`, graceful exit on
  SIGTERM / SIGINT / SIGHUP. Shutdown unlinks both files and
  `exit(0)`s.
- **`spawn.ts`** — `connectToDaemon(worktree)` client primitive:
  honor `RN_DEV_DAEMON_SOCK` env hatch if set, else liveness-probe
  via `IpcClient.isServerRunning()`, else `unlinkStale()` **both**
  `pid` and `sock`, `spawnDetachedDaemon()`, `waitForSocket()`,
  return `IpcClient`. `isDaemonAlive` / `unlinkStale` /
  `spawnDetachedDaemon` / `waitForSocket` are individually exported
  so later phases can compose. **Not wired to any caller in 13.1.**
- **`supervisor.ts`** — `DaemonSupervisor` placeholder (renamed from
  `Supervisor` to avoid colliding with the unrelated
  `src/core/module-host/supervisor.ts`). Phase 13.2 drives the
  session state machine from here.
- **`session.ts`** — `SessionStatus` + `SessionState` + frozen
  `INITIAL_SESSION_STATE`. Phase 13.2 extends the transitions.
- **`__tests__/`** — two integration tests (merge gate):
  - `daemon-lifecycle.test.ts`: spawn → `sock` + `pid` appear →
    `daemon/ping` returns `{daemonVersion, hostRange}` → SIGTERM →
    files unlinked + exit 0.
  - `second-spawn-detection.test.ts`: spawn A, spawn B on same
    worktree, B exits non-zero with `already running, pid=N` on
    stderr; A unaffected and still answering ping.

### Wire protocol additions

- **`daemon/ping`** — returns `{daemonVersion: "0.1.0",
  hostRange: ">=0.1.0"}`. Used for liveness + version handshake.
- **`daemon/shutdown`** — acks, then triggers graceful shutdown on
  the next tick (reply drains before socket closes).
- **`daemon/error`** envelope with `{code, requestedAction}` for
  unknown actions. Clients discriminate error replies by
  `response.action === "daemon/error"`.

### CLI additions

- `rn-dev daemon <worktree> [--foreground]` — hidden from `--help`
  via commander's `{ hidden: true }` CommandOption.
- `rn-dev daemon-shutdown <worktree>` — hidden; sends
  `daemon/shutdown` over the socket.

### Shared test infra

- `test/fixtures/minimal-rn/` — stub RN worktree. Phase 13.1 never
  boots Metro against it; the daemon only uses its path.
- `test/helpers/spawnTestDaemon.ts` — spawns the CLI daemon via bun,
  waits for the socket with early-exit detection, exposes
  `getStderr()` / `getStdout()` / `waitForExit()` / `stop()` +
  `makeTestWorktree()` helper that seeds a scratch `.rn-dev/`
  under `mkdtemp()`. Five Phase-13 tests will reuse it.

### `tsconfig.json`

- `rootDir` → `"."`, `include` → `["src", "test/helpers"]`. Lets the
  shared helper typecheck without leaking fixture files into the
  compilation. No impact on the bun-based production build.

Net LoC: **`+690 / -2`** across 12 files.

## Reviewer round

Four parallel reviewers dispatched once the RED + GREEN commits were
pushed. **No P0 blockers; eight P1s applied pre-merge.**

### Applied pre-merge (security hardening + cold-path + polish)

- **Security P1#1** — TOCTOU between `listen()` and chmod. Fixed with
  `process.umask(0o177)` around `server.start()` + belt-and-suspenders
  `chmodSync(sockPath, 0o600)` after. Any local user could previously
  `connect()` and send `daemon/shutdown` during the microtask window.
- **Security P1#2** — `.rn-dev/` created at default `0755`, pid file at
  `0644`. Fixed with `mkdirSync({ mode: 0o700 })` + explicit
  `chmodSync(rnDevDir, 0o700)` for pre-existing dirs +
  `chmodSync(pidPath, 0o600)` after `ModuleLockfile.acquire` writes it
  (since `writeFileSync` inside ModuleLockfile doesn't take a mode).
- **Architecture P0#1** — `connectToDaemon` cold path now unlinks
  **both** `pid` and `sock`, not just `sock`. A dead pid whose slot
  the kernel reused to an unrelated process used to jam subsequent
  boots with `already running, pid=N`.
- **Kieran P1#1** — `test/helpers`: `waitForExit` simplified to always
  return the cached `exitPromise`; no mutable `exitInfo` branch for
  the type system to widen.
- **Kieran P1#2** — `test/helpers`: replaced `proc.pid!` non-null
  assertion with a synchronous spawn-failure guard.
- **Kieran P1#3** — default RPC arm emits
  `{action: "daemon/error", payload: {code: "E_UNKNOWN_ACTION",
  requestedAction}}` instead of echoing the unknown action back.
  Clean client-side discriminator.
- **Kieran P1#4 (partial)** — `detachAndExit` preflights entry
  existence + worktree `isDirectory()`. The harder half (Bun-vs-Node
  runtime detection) is deferred — test coverage uses
  `--foreground`, so the detach path's runtime selection isn't
  test-load-bearing until 13.4 routes Electron through it.
- **Arch P2#6 + P2#8** — SIGHUP handler added + `RN_DEV_DAEMON_SOCK`
  env escape hatch in `connectToDaemon` (matches the spec §Topology
  note and what `src/cli/module-commands` already honors).

### Also applied (lower-priority polish)

- `isDaemonAlive` drops the redundant `ModuleLockfile.peek()` — a
  stale socket file answers `ECONNREFUSED` via
  `IpcClient.isServerRunning`, so the peek was belt-and-belt.
- Bind shutdown closure directly through `setImmediate(shutdown)`
  instead of the indirect `process.kill(process.pid, "SIGTERM")`
  round-trip.
- Rename `Supervisor` → `DaemonSupervisor` to end the collision with
  `src/core/module-host/supervisor.ts`.
- `INITIAL_SESSION_STATE` is `Object.freeze`d and typed `readonly`.
- `daemon-lifecycle.test.ts` drops a contradictory
  `payload.hostRange!.length` bang.

### Intentionally deferred

| Finding | Source | Rationale |
|---|---|---|
| `daemonEntry` option threading through `ConnectToDaemonOptions` | Arch P1#4 | Electron's `process.argv[1]` points at the packaged `main.js`, not the CLI entry. Lands with Phase 13.4 when Electron IPC handlers actually call `connectToDaemon`. Comment placed in `spawn.ts` + `index.ts::detachAndExit` to flag it. |
| Shared `version.ts` constant | Kieran P2 / Arch P1#5 | Only two call sites today (commander `.version()` + `DAEMON_VERSION` literal) and neither is tested against the other. Retire the literal when 13.3 adds the client-side version-mismatch UX. |
| `IpcServer.start()` unlinks before bind (→ post-lock pre-bind race) | Arch P1#3 | Lives in `src/core/ipc.ts` and is shared with every existing caller. Fixing it means either a `skipStaleUnlink` flag on `IpcServer` or hoisting the unlink into `runDaemon`. Queue with 13.2 when the daemon starts owning the unlink timing anyway. |
| `SO_PEERCRED` / `LOCAL_PEERCRED` on `daemon/shutdown` | Security P2#5 | Owner-only filesystem perms on the socket are the gate in v1; documented at the security-posture comment at the top of `index.ts`. Revisit if/when the RPC surface widens to privileged operations. |
| UID check in `ModuleLockfile.peek()` | Security P2#4 | Host-wide follow-up — touches a file used by all `global`-scope modules, not just the daemon. Narrow fix would be daemon-local; better to address at the source in a dedicated PR. |
| `existsSync` preflight on CLI entry in `spawnDetachedDaemon` | Arch nit | Already applied in `index.ts::detachAndExit`; same preflight now lives in `spawn.ts::spawnDetachedDaemon`. |
| Simplicity reviewer's DELETE recommendations (supervisor.ts, session.ts, daemon-shutdown CLI, detachAndExit, spawn.ts trim) | Simplicity | Directly contradicts the Phase 13.1 prompt's explicit scope: "New `src/daemon/` folder with: index.ts, spawn.ts, supervisor.ts (placeholder), session.ts (placeholder)… Also optional `rn-dev daemon-shutdown`". Following the prompt — these files ship. The placeholders are minimal (13 / 18 lines) so the 13.2 land surface is already shaped. |
| Kieran's `setTimeout` via `node:timers/promises` nit | Kieran nit | Cosmetic; keep consistency with existing `src/core/ipc.ts` + `waitForSocket` call-sites until a repo-wide sweep lands. |

## Security posture

Documented at the top of `src/daemon/index.ts`:

- `<worktree>/.rn-dev/` directory is **`0o700`** (owner-only).
- `<worktree>/.rn-dev/sock` socket is **`0o600`** atomically at
  `listen()` time, via `process.umask(0o177)` gate.
- `<worktree>/.rn-dev/pid` lockfile is **`0o600`** (post-write chmod
  since `ModuleLockfile.writeFileSync` doesn't take a mode).

RPC authorization = filesystem permissions. There is no
`SO_PEERCRED` check. Relax any of these and `daemon/shutdown`
becomes a trivial local DoS — v2 can add peer-cred if the RPC
surface grows privileged operations.

## Baselines (Phase 13.1 close state)

- **vitest**: **885 / 0** (pre-13.1 was 883; +2 new integration tests)
- **tsc root**: **150** (pre-existing wizard errors, unchanged)
- **tsc electron**: 0
- **tsc per-module**: 0 / 0 / 0
- **`bun run build`**: green (bun shebang prepended)
- **`bun run typecheck`**: green (at baseline 150 errors)

Manual smoke verified:

- `.rn-dev/` → `drwx------`
- `pid` → `-rw-------`
- `sock` → `srw-------` from creation (no TOCTOU)
- `daemon/ping` returns `{daemonVersion: "0.1.0", hostRange: ">=0.1.0"}`
- `daemon/error` envelope on unknown actions
- `daemon-shutdown` + SIGTERM both round-trip cleanly

## Commits on the branch

- `e6b2498 test(daemon): Phase 13.1 — failing integration tests + fixture + helper`
- `5fda3ce feat(daemon): Phase 13.1 — daemon lifecycle primitives`
- `8119f6e fix(daemon): Phase 13.1 reviewer feedback — security hardening + cold-path + polish`

Squash-merged as `2a3c671` on `main`.

## What's next

**Phase 13.2 — services move into the daemon.** Services
(`MetroManager`, `DevToolsManager`, `ModuleHostManager`) still live
in `src/app/start-flow.ts::startServicesAsync` and
`electron/ipc/*`. 13.2 refactors `startServicesAsync` into a pure
"boot session services" function that the daemon's `DaemonSupervisor`
drives via `session/start`, `session/stop`, `session/status`, and
`events/subscribe`. TUI + Electron + MCP still use their existing
paths; no user-visible change.

- **Merge gate**: integration test **#3** (session boot end-to-end
  against `test/fixtures/minimal-rn`) passes.
- Scope prompt: `docs/plans/2026-04-24-next-session-prompt-phase-13-2.md`.

Spec success criterion #1 (`grep -rn "new MetroManager" src/ electron/`
returns matches only inside `src/daemon/`) will pass for the first
time at the end of 13.2.

Alternative next-phase candidates (unchanged from the Phase 13
top-level menu):

- **Phase 12.2** — bootstrap-surface SDK bundle. Still unblocked;
  orthogonal to the daemon arc.
- **Phase 13 D** — prototype-chain hardening (`hasOwnProperty.call`
  across SDK narrowers). Follow-up task chip already spawned.
- **Phase 12 Option A / B / C** — lint/test 3p extraction / `keepData`
  GC / npm publishing. A + B in-repo; C blocked on external setup.
