# Next-Session Prompt — Phase 13.6 Follow-up

**Paste the block below at the start of the next session.**

---

We're continuing the rn-dev-cli daemon refactor. Phase 13.6 PR-C
(multiplexed daemon channel + MCP-as-daemon-client) shipped
2026-04-25 as [`7a466b2`](https://github.com/utopyk/rn-dev-cli/commit/7a466b2)
([PR #24](https://github.com/utopyk/rn-dev-cli/pull/24)). Spec at
[`docs/superpowers/specs/2026-04-25-multiplexed-daemon-channel-design.md`](../superpowers/specs/2026-04-25-multiplexed-daemon-channel-design.md);
plan at [`docs/superpowers/plans/2026-04-25-multiplexed-daemon-channel-plan.md`](../superpowers/plans/2026-04-25-multiplexed-daemon-channel-plan.md).

PR-C closed the multi-client keystone: events/subscribe is now a
multiplexed channel (filtered events + bidirectional RPCs gated by
`supportsBidirectionalRpc: true`); MCP rides
`connectToDaemonSession({ kinds: ["modules/*"] })`;
`RN_DEV_HOSTCALL_BIND_GATE` flipped default-on. Reviewer round
(Kieran TS + Architecture + Security + Simplicity) surfaced 4 P0s
+ 8 P1s, all applied pre-merge. Final state: vitest 1014/0,
tsc root 149 (pre-existing wizard, unchanged), tsc electron 0,
playwright 10/10.

## This session: Phase 13.6 follow-up

Pick whichever scope fits the time available. PR-E and
`instance:retryStep` are the user-visible blockers; the rest are
quality-of-life or carry-cost cleanup.

### 1. PR-E — packaged-Electron daemon entry (HIGH-VALUE, ~30 LOC)

`electron/daemon-connect.ts::resolveDaemonEntry` still throws under
`app.isPackaged`. Production Electron builds can't spawn the daemon.

Wire the asar layout:
- `app.asar/dist/index.js` is the CLI entry in packaged mode.
- `pickDaemonInterpreter` already handles the `.js` + isElectron
  case → returns `"node"`.
- Bundling node binary or relying on PATH `node` — initial: PATH
  `node` with a clear error if missing; track bundling as a
  follow-up.

Test coverage: unit test for `resolveDaemonEntry` under
`app.isPackaged` flag. Manual smoke documented in PR description.

### 2. `instance:retryStep` daemon RPC (P0 user-visible, deferred from Phase 13.5)

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

### 3. PR-C reviewer follow-ups (carry-cost cleanup)

From the parallel-reviewer round on PR #24, deferred as polish:

- **ModuleHostClient `client` → `sender` field rename** (Architecture
  P1-4 / Simplicity P1-4). The constructor takes `(sender, rawClient,
  idGen)`; the field for the IpcSender is named `client` which
  conflicts with the conceptual model. Cosmetic, but strengthens the
  channel-bound-vs-event-stream distinction at every call site.

- **`tryIpcAction` helper to consolidate `src/mcp/tools.ts` boilerplate**
  (Simplicity P1-5). Six call sites repeat
  `if (ctx.session) { try { ... } catch { } }`. Extract to a shared
  helper sibling to the existing `ipcAction()` (Phase 5 lifecycle
  tools have it). ~36 LOC saved.

- **session/status auto-append layer placement** (Architecture P1-1).
  Today `connectToDaemonSession` auto-appends `session/status` to any
  caller-supplied `kinds`. Architecture argued this is leaky abstraction
  (the daemon should always include `session/status` implicitly,
  treating it as a reserved control channel). The current client-side
  approach has a comment but no test pinning the layer rationale.
  Decide and either refactor (move to daemon) or document the choice
  explicitly in `subscribe-registry.ts`'s `parseKinds` JSDoc.

- **Teardown-ordering test** (Architecture P1-3). After a
  multiplexed-channel client releases, both `SubscribeRegistry` and
  `SenderBindings` cleanup hooks fire on socket close. Add an
  assertion that pin both clear in coordination — drives a probe via
  daemon-side accessors that the next test would hit MODULE_UNAVAILABLE
  on a fresh bidirectional connection trying to inherit the stale
  binding.

### 4. Phase 13.5 carry-cost: `session/start` migration

From PR-A reviewer (Simplicity P0-3 deferred): migrate
`session-boot.test.ts` + `client-rpcs.test.ts` off `session/start`
to `events/subscribe { profile }`. Delete the `session/start` daemon
handler once nothing uses it (it's currently retained as back-compat
with no refcount participation, and its in-handler comment says
"Phase 13.6 may delete this handler outright after migrating
session-boot.test.ts and friends").

### 5. Pid-recycling defense + consumer-side socket validation

From PR-B reviewer feedback (deferred):

- Add a daemon-side start-time field to `DaemonRegistration`.
  `/proc/<pid>/stat` field 22 on Linux; `ps -o lstart -p <pid>` on
  macOS. `isAlive` cross-checks the recorded start-time against the
  live process's start-time.
- Consumer-side socket validation in `findActiveDaemons`:
  `lstatSync(reg.sockPath)`, assert
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

### 8. Other PR-C P2 advisory items

Lower priority, but worth knocking off if time permits:

- `IpcServer.start` race: `srv.on("error")` doesn't unbind on
  successful listen — late errors silently re-reject a settled promise.
- `parseKinds` accept-pattern mismatch: `["/*"]` validates and matches
  anything starting with `/`. Add a `kind.length > 2` check.
- `daemon/ping` discloses daemonVersion to non-bidirectional
  subscribers — minor, threat-model-doc anchor.
- Re-subscribe rejection has no audit-log entry — anomaly detection
  has nothing to anchor on.

## Pre-push verification standard (unchanged, enforced via CLAUDE.md)

Every renderer/electron change MUST pass three layers:
1. `npx vitest run` — fast (~25s).
2. `npx tsc --noEmit && npx tsc --noEmit -p electron/tsconfig.json`.
3. `npx playwright test` — slow (~50s).

## Baselines to match or improve on (post-Phase 13.6 PR-C)

- vitest: 1014 / 0 (was 983 baseline pre-13.6)
- tsc root: 149 (pre-existing wizard, unchanged)
- tsc electron: 0
- `bun run build`: green
- `npx playwright test`: 10 / 10

## Branching

```sh
git checkout main
git pull
git checkout -b feat/module-system-phase-13-6-followup
```

Per Martin's working preference for this repo: direct feature branch
on `main`, not worktrees.

## Remember

- `vitest run`, not `bun test`.
- `bun run build` + `bun run typecheck` for production verification.
- `npx playwright test` for smoke before any merge.
- `RN_DEV_DAEMON_BOOT_MODE=fake` for integration tests that shouldn't
  spawn real Metro.
- `events/subscribe { profile, supportsBidirectionalRpc: true }` is
  the canonical Electron/MCP attacher payload; `session/start` is
  back-compat-only and queued for retirement (item 4).
- `RN_DEV_HOSTCALL_BIND_GATE` is default-on. `=0` is the emergency
  off-switch.
- `connectToDaemonSession` auto-appends `session/status` to `kinds`
  when supplied — design decision flagged in item 3.
- The daemon's session refcount is held by the long-lived subscribe
  socket — tests that expect daemon teardown on a single client's
  release should structure around that.
