# Phase 13.5 — handoff (partial; PR-A + PR-B + PR-D landed; PR-C + PR-E deferred)

**Date:** 2026-04-25 (overnight autonomous session)

## What shipped

Phase 13.5's keystone refcount + multi-client foundation landed. The
daemon can now hold overlapping client attachments cleanly, with
last-release tear-down semantics and a per-conn authorization gate
for module host-calls. Three of the five planned PRs merged; two
deferred.

### PR-A — ref-counted session attach/release ([PR #21](https://github.com/utopyk/rn-dev-cli/pull/21), squashed as `d2f1890`)

The keystone. Refcount lives on the **long-lived events/subscribe
socket**, not on `session/start` (which uses short-lived send-conns
and would auto-release after every RPC).

Wire-protocol changes:
- `events/subscribe { profile }` — the canonical attacher path. Boots
  if stopped, joins if running with matching profile, rejects on
  profile mismatch with `E_PROFILE_MISMATCH`.
- Subscribe response carries `{ subscribed, status, started, attached }`
  so joiners can detect running-already and short-circuit cleanly.
- `IpcMessageEvent.connectionId` — stable per-connection id.
- `session/start` retained as back-compat for tests + tooling that
  drives the boot via separate RPC. NO refcount participation —
  documented as carry-cost; Phase 13.6 may delete after migrating
  `session-boot.test.ts` and `client-rpcs.test.ts`.
- `session/release` wire action **removed** post-review (Sec P1-1
  forgery DoS); `release()` client method now just closes the
  subscribe socket, daemon's auto-release fires.

Subtle correctness fixes:
- Listener registration before attach: bootAsync's "running" emit
  can fire on the same microtask drain as attach's resume.
- `IpcClient.subscribe` filters initial confirmation by `type:
  "response"` — listener-first ordering can't hijack the ack.
- `IpcServer.stop` has 500ms grace for Bun's flaky `closeAllConnections`.
- bootAsync failure clears `attachedConnections` so a stale first-
  attacher entry doesn't block last-release teardown.

Electron:
- Drops `MULTI_INSTANCE_NOT_SUPPORTED`. Same-profile second instance
  shares the active session; cross-profile attempts surface
  `E_PROFILE_MISMATCH` directly.
- `state.daemonSessionProfileName` tracks the active profile.
- `app.on('window-all-closed')` calls `disconnect()` (refcount-aware).

Tests: 12 new unit tests in `supervisor-refcount.test.ts` + 5
integration tests in `session-release.test.ts`. Migrated
`session-disconnect.test.ts`, `gui-mcp-survive.test.ts`,
`panel-bridge-daemon.test.ts` to the new attacher subscribe shape.

4-reviewer round (Kieran TS + Architecture + Security + Simplicity)
surfaced 6 P0s + 4 P1s; all fixed in-branch. Notable:
- Kieran P0-1: bootAsync failure now clears attached set.
- Sec P1-1: dropped `session/release` wire action (forgery DoS).
- Arch + Kieran + Simplicity P0: deleted dead `attachWithoutProfile`.
- Kieran P0-3: `parseSubscribeResponse` runtime parser replaces
  dishonest `as` casts.

### PR-B — active-daemon registry ([PR #22](https://github.com/utopyk/rn-dev-cli/pull/22), squashed as `a480425`)

Discovery side-channel at `~/.rn-dev/registry.json`. Maps worktree
absolute paths to `{ pid, sockPath, since, hostVersion }` rows.

Behavior:
- Daemon writes its row on boot (after socket bind + chmod + lock-
  acquired); removes on graceful SIGTERM.
- `registerDaemon`'s pid-liveness sweep cleans up rows from previously
  crashed daemons.
- Atomic temp-file + rename writes; mode 0o600.
- O_EXCL-based RMW lock at `<dir>/registry.lock` (Kieran P0)
  prevents concurrent daemon-boots from silently dropping each
  other's rows. 200ms budget; falls through unlocked rather than
  deadlocking boot.
- Tightened shape validation rejects `pid<=1`, non-integer pids,
  empty strings, unparseable timestamps.
- `RN_DEV_REGISTRY_PATH` env override for tests.

Tests: 13 — 11 unit (missing/malformed file, mode 0o600, stale-pid
sweep, idempotent re-register, 100-crashes-don't-accumulate, env
override, tightened shape validation) + 2 integration (register-on-
boot/unregister-on-shutdown roundtrip, findActiveDaemons with
stale entry).

3-reviewer round; applied Kieran P0 (RMW lock), P1 (shape
validation, dead `EMPTY_REGISTRY`), Sec P2 (random temp-filename
suffix), Simplicity P0 (dead readFileSync import).

### PR-D — per-conn sender bindings for `modules/host-call` ([PR #23](https://github.com/utopyk/rn-dev-cli/pull/23), open at handoff time)

Daemon-side authorization gate. Pre-13.5, hostCall trusted
`payload.moduleId` because there was at most one client per daemon.
Phase 13.5 multi-client coexistence means a same-UID compromised
module subprocess could otherwise impersonate any module's host-call.

Wire surface:
- `modules/bind-sender { moduleId }` — authorize the calling
  connection. Idempotent. Rejects unregistered moduleIds with
  `MODULE_NOT_REGISTERED`. Malformed payload → `BIND_INVALID_PAYLOAD`.
- `modules/host-call` requires a prior bind. Without one, returns
  `MODULE_UNAVAILABLE` with audit-log outcome `denied` (same code as
  "not registered" so a malicious enumerator can't distinguish).
- Socket-close clears the connection's bindings.

Files:
- `src/daemon/sender-bindings.ts` (new): `SenderBindings` class.
- `src/app/modules-ipc.ts`: hostCall + bindSenderAction +
  MODULES_ACTIONS gains `modules/bind-sender` + dispatcher threads
  connectionId + `registerModulesIpc` instantiates a fresh
  SenderBindings per session boot + per-conn cleanup hook.

Tests: 8 unit (deny-by-default, conn-scoped + module-scoped
isolation, idempotency, multi-module per conn, clearConnection,
size accounting) + 4 integration (host-call without bind denies,
bind for unregistered module rejects, malformed payload rejects,
per-socket-binding semantic pinned).

**Known limitation pinned by tests:** `IpcClient.send()` opens a new
socket per call, so binding over send-conn-A doesn't carry to
send-conn-B. Real callers must use a long-lived connection. PR-C
(MCP daemon-client flip) will need to address this.

3-reviewer round dispatched at handoff time; status pending. If
reviewers surface blocking P0s, they're tracked on the
`feat/module-system-phase-13-5-d` branch.

## What did NOT ship

### PR-C — MCP server flipped to daemon client (deferred)

Largest of the five. Today `src/mcp/server.ts` builds its own
`McpContext` whose `ipcClient` field talks to the daemon for module-
tool discovery only — it does NOT own a `DaemonSession`. Flipping
it to use `connectToDaemonSession` is the primary remaining work
for tri-client coexistence.

**Why deferred:** scope. The flip requires:
1. Replace MCP startup's manual `IpcClient` with `connectToDaemonSession`.
2. Tool handlers that need typed RPC go through adapter methods
   instead of building raw `IpcMessage` payloads.
3. MCP profile resolution — existing default-profile picker keeps
   working; clear error when no profile is configured.
4. `release()` on signal-shutdown.
5. `bind-sender` per moduleId the MCP server proxies (consumes
   PR-D).
6. New integration test confirming MCP-as-daemon-client end-to-end.

PR-D's known limitation (per-socket bindings) actually blocks PR-C
from working today: MCP would need to keep a long-lived connection
to the daemon and route both `bind-sender` and `host-call` over it.
This implies a daemon-side change to support arbitrary RPCs over
the events/subscribe socket, which is a bigger surface change than
this overnight session can responsibly land. **Phase 13.6 work.**

### PR-E — packaged-Electron daemon entry (deferred)

`electron/daemon-connect.ts::resolveDaemonEntry` still throws under
`app.isPackaged`. Production Electron builds can't spawn the daemon.

**Why deferred:** orthogonal to multi-client foundation and
mechanically isolated. Easy to land in a follow-up session;
~30 LOC + test.

## Remaining items from the original next-session prompt (Phase 13.6 candidates)

From `docs/plans/2026-04-25-next-session-prompt-phase-13-5.md`:

1. `instance:retryStep` daemon RPC — renderer Retry buttons. Orthogonal to
   multi-client.
2. `AuditOutcome` widening (Sec P1-3 deferred from earlier phases).
3. `instance:section:start|end` events (optional renderer UX).
4. PR-A simplicity reviewer's recommendation to migrate
   `session-boot.test.ts` + `client-rpcs.test.ts` off `session/start`.

## Verification at end of session

After PR-A + PR-B merged (PR-D pending):
- vitest: 985 / 0 (originally 942 → +43 new in this phase)
- tsc root: 149 (pre-existing wizard, unchanged)
- tsc electron: 0
- bun run build: green
- npx playwright test: 10 / 0

## Open follow-ups (from reviewer feedback, deferred to future PRs)

### PR-A reviewer feedback deferred

- Sec P1-2: session-lifecycle audit-log entries (no current consumer).
- Kieran P1-1: investigate Bun's `closeAllConnections` no-op rather than
  the 500ms grace timeout in `IpcServer.stop`.
- Simplicity P0-3: migrate `session-boot.test.ts` + `client-rpcs.test.ts`
  off `session/start` so the no-refcount carry-cost can be retired.

### PR-B reviewer feedback deferred

- Pid recycling defense via start-time cross-check (`/proc/<pid>/stat`
  field 22 on Linux, `ps -o lstart` on macOS). Real but
  lower-frequency than the RMW race fixed in this phase.
- Consumer-side socket validation (`lstat` for `isSocket` + `uid` +
  `mode` before dial) — belongs in PR-C as the first real consumer
  of `findActiveDaemons`.
- Audit-log entries for daemon register/unregister.
- `version: 1` field in registry JSON for forward-compat.

### PR-D reviewer feedback (status TBD at handoff)

3 reviewers dispatched, status pending. Notable expected items based
on the documented known-limitation:
- The per-socket-binding limitation is the biggest open question.
  PR-C will need to address by routing bind-sender + host-call over
  the long-lived events/subscribe socket.

## Branching state at handoff

- `main`: PR-A + PR-B squash-merged.
- `feat/module-system-phase-13-5-d`: PR-D branch, [PR #23](https://github.com/utopyk/rn-dev-cli/pull/23) open.
- `feat/module-system-phase-13-5-b`: deleted (squash-merged via gh).
- `feat/module-system-phase-13-5`: deleted (PR-A squash-merged via gh).
- Stale branches `pr-22` (local artifact from interactive merge): can be deleted.
