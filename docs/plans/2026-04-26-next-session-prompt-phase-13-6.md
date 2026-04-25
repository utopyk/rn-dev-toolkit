# Next-Session Prompt — Phase 13.6

**Paste the block below at the start of the next session.**

---

We're continuing the rn-dev-cli daemon refactor. Phase 13.5 partially
shipped 2026-04-25 in an autonomous overnight session:

- PR-A ([#21](https://github.com/utopyk/rn-dev-cli/pull/21), `d2f1890`)
  — ref-counted session attach/release. Wire-protocol changes:
  refcount on long-lived events/subscribe socket;
  `events/subscribe { profile }` is the canonical attacher path;
  `session/start` retained as no-refcount back-compat;
  `session/release` wire action **removed** (Sec P1-1 fix). 17 new
  tests.
- PR-B ([#22](https://github.com/utopyk/rn-dev-cli/pull/22),
  `a480425`) — active-daemon registry at
  `~/.rn-dev/registry.json`. O_EXCL RMW lock; tightened shape
  validation. 13 new tests.
- PR-D ([#23](https://github.com/utopyk/rn-dev-cli/pull/23), `e448920`)
  — per-conn sender bindings for `modules/host-call`. Shipped
  **default-off** via `RN_DEV_HOSTCALL_BIND_GATE=1` env flag (Sec +
  Kieran P0: gate-on-by-default would break Electron's host-call
  bridge). 11 new tests, including a load-bearing default-off check.

Read the Phase 13.5 handoff doc:
[`docs/plans/2026-04-25-module-system-phase-13-5-handoff.md`](2026-04-25-module-system-phase-13-5-handoff.md).

## This session: Phase 13.6

### 1. PR-C — flip MCP server to daemon-client (the keystone remaining)

Today `src/mcp/server.ts` builds its own `McpContext` whose
`ipcClient` field talks to the daemon for module-tool discovery
only. It does NOT own a `DaemonSession`.

**Blocking sub-issue:** PR-D's per-socket-binding limitation. Each
`IpcClient.send()` opens a new socket → different `connectionId` →
binding from a previous send doesn't apply. MCP needs both
`bind-sender` and `host-call` to ride the **same** long-lived
connection.

**Architectural decision required (consider before coding):**

- Option A: Add per-RPC support to the events/subscribe socket. The
  daemon-side `handleEventsSubscribe` already opens a long-lived
  socket; extending the IpcServer to dispatch arbitrary
  request/response RPCs over it (in addition to the event push
  stream) means the subscribe-conn's `connectionId` carries
  through to host-call. **Larger surface change; cleaner long-term.**
- Option B: Add a separate "RPC channel" long-lived socket per
  client, sibling to events/subscribe. `connectToDaemonSession`
  opens both at boot; host-call goes over the RPC channel.
  **Doubles the socket count per client but minimal IpcServer
  surface change.**
- Option C: Bind a moduleId at attach time (events/subscribe
  payload extension). Then any host-call from any send-conn from
  this CLIENT (somehow identified — UID? cookie?) inherits. **Loses
  the per-conn isolation that Sec P1-1 motivated.**

Recommendation: **Option A**. The long-lived subscribe socket is
already the durable identity-bearer; extending it to carry RPCs
preserves the "one client = one connection identity" invariant.

PR-C work:
- IpcServer extension to dispatch request/response on a subscribe
  socket (gated by an opt-in flag in the subscribe payload, e.g.
  `events/subscribe { profile, supportsBidirectionalRpc: true }`).
- Daemon-side: keep both message-handling paths (the existing
  fresh-socket path for tooling that doesn't subscribe; the new
  same-socket path for clients that do).
- `IpcClient` extension: add `subscribeAndCall` or extend the
  subscribe handle with a `send()` method.
- MCP server flip: replace `IpcClient` with `connectToDaemonSession`,
  use the bidirectional RPC channel for both `bind-sender` and
  `host-call`.
- `release()` on signal-shutdown.
- New integration test: MCP-as-daemon-client end-to-end including
  proxy-tool host-call.

### 2. PR-E — packaged Electron daemon entry

`electron/daemon-connect.ts::resolveDaemonEntry` throws under
`app.isPackaged`. Wire the asar layout:
- `app.asar/dist/index.js` is the CLI entry in packaged mode.
- `pickDaemonInterpreter` already handles the `.js` + isElectron
  case → returns `"node"`.
- Bundling node binary or relying on PATH `node` — initial: PATH
  `node` with a clear error if missing; track bundling as a
  follow-up.

Test coverage: unit test for `resolveDaemonEntry` under
`app.isPackaged` flag. Manual smoke documented in PR description.

### 3. `instance:retryStep` daemon RPC (P0 user-visible from original Phase 13.5 prompt)

`electron/ipc/instance.ts::instance:retryStep` is currently a stub.
The renderer's section "Retry" buttons are clickable but useless.

Daemon side: new `session/retryStep` action handled in
`src/daemon/client-rpcs.ts`. Body: `{ stepId: "preflight" | "clean"
| "watchman" | "metro" | "build" }`. Supervisor exposes
`retryStep(stepId)` driving individual sections against the live
`SessionServices`.

Electron side: `instance:retryStep` calls a new `serviceBus`-resolved
session client method. Round-trips, fans events back into
`instance:section:start|end` IPC channels.

Smoke: each section's Retry button works without restart.

### 4. Migration carry-costs (Simplicity P0-3 from PR-A review)

Migrate `session-boot.test.ts` + `client-rpcs.test.ts` off
`session/start` to `events/subscribe { profile }`. Delete the
`session/start` daemon handler once nothing uses it.

### 5. Pid-recycling defense + consumer-side socket validation

From PR-B reviewer feedback (deferred):

- Add a daemon-side start-time field to `DaemonRegistration`.
  `/proc/<pid>/stat` field 22 on Linux; `ps -o lstart -p <pid>` on
  macOS. `isAlive` cross-checks the recorded start-time against the
  live process's start-time.
- Consumer-side socket validation in `findActiveDaemons` (or in PR-C
  as the consumer): `lstatSync(reg.sockPath)`, assert
  `isSocket() && uid === getuid() && (mode & 0o777) === 0o600`.
  Reject rows whose `sockPath` doesn't match
  `<worktree>/.rn-dev/sock`.

### 6. Audit-log lifecycle entries

From PR-A + PR-B reviewer feedback. Add `kind: "session-lifecycle"`
entries on session/start, session/stop, session/release, daemon
register/unregister. Captures who attached/released for forensic
purposes.

### 7. Investigate IpcServer.stop's 500ms grace

From PR-A reviewer feedback. The `closeAllConnections` no-op on Bun
is the actual bug; the 500ms grace papers over it. File a Bun issue
with a minimal repro; consider tracking accepted sockets explicitly
and `socket.destroy()`-ing each.

## Pre-push verification standard (unchanged, enforced via CLAUDE.md)

Every renderer/electron change MUST pass three layers:
1. `npx vitest run` — fast (~25s).
2. `npx tsc --noEmit && npx tsc --noEmit -p electron/tsconfig.json`.
3. `npx playwright test` — slow (~50s).

## Baselines to match or improve on (post-Phase 13.5)

- vitest: 985 / 0 (was 942 + 43 from this phase)
- tsc root: 149 (pre-existing wizard)
- tsc electron: 0
- `bun run build`: green
- `npx playwright test`: 10 / 0

## Branching

```sh
git checkout main
git pull
git checkout -b feat/module-system-phase-13-6
```

Per Martin's working preference for this repo: direct feature branch
on `main`, not worktrees.

## Remember

- `vitest run`, not `bun test`.
- `bun run build` + `bun run typecheck` for production verification.
- `npx playwright test` for smoke before any merge.
- `RN_DEV_DAEMON_BOOT_MODE=fake` for integration tests that shouldn't
  spawn real Metro.
- `events/subscribe { profile }` is the canonical attacher path;
  `session/start` is back-compat-only and should be retired.
- The daemon's session refcount is held by the long-lived subscribe
  socket — tests that expect daemon teardown on a single client's
  release should structure around that.
