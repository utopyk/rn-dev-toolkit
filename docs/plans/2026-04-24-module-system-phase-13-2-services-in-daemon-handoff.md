# Phase 13.2 Handoff — Services Move Into the Daemon

**Shipped**: 2026-04-24 via
[PR #16](https://github.com/utopyk/rn-dev-cli/pull/16). (Squash-merge
hash TBD; update after merge.)

## Context

Phase 13.1 left us with an **empty-but-working** daemon binary that
booted, owned the pid/sock files, and answered `daemon/ping` +
`daemon/shutdown`. Nothing actually used it.

Phase 13.2 moves the services (Metro / DevTools / ModuleHost) into the
daemon and exposes them as RPCs. **The clients do not flip yet** —
TUI / Electron / MCP still run their in-process paths unchanged. The
daemon is additive. Phase 13.3 migrates the TUI first as the proving
ground; 13.4 does Electron.

The overall arc and spec:
[`design/daemon-refactor:docs/superpowers/specs/2026-04-24-daemon-refactor-design.md`](../superpowers/specs/2026-04-24-daemon-refactor-design.md)
(on the `design/daemon-refactor` branch until it lands in `main`).

## What shipped

### `src/core/session/boot.ts` (NEW)

`bootSessionServices(opts)` — the service-construction body extracted
from `src/app/start-flow.ts::startServicesAsync`. One factory now
drives both the TUI path and the daemon supervisor. The TUI wraps it
in a thin adapter that fans the returned services into `serviceBus.*`;
the daemon wraps it in `DaemonSupervisor`.

Returns `{metro, devtools, watcher, builder, moduleHost, moduleRegistry,
worktreeKey, metroLogsStore, capabilities, moduleEvents, dispose}`. The
`dispose()` closure is what the daemon calls on `session/stop`.

### `src/daemon/`

- **`supervisor.ts`** — `DaemonSupervisor` state machine. Transitions
  are strict: `stopped → starting → running → stopping → stopped`. A
  second `session/start` while running returns
  `E_SESSION_ALREADY_RUNNING`. Fan-out happens via an `EventEmitter`
  — `session/event`s are pushed to every `events/subscribe` consumer.
  Constructor accepts a `bootFn: SessionBootFn` so tests inject a
  fake without env-sniffing inside the supervisor itself.
- **`index.ts`** — now dispatches four new RPCs alongside
  `daemon/ping` + `daemon/shutdown`:
  - `session/start { profile }` → `{status: "starting"}` immediately.
    Boot runs async; progress is visible via `events/subscribe`. Mid-
    flight profile edits are ignored (snapshot on start).
  - `session/stop` → graceful teardown; daemon stays alive.
  - `session/status` → `{status, services}` snapshot.
  - `events/subscribe` → server-streaming; reuses the
    `modules/subscribe` reply-id pattern. Envelope: tagged-union
    `{kind, worktreeKey, data}`. Kinds shipped: `session/status`,
    `metro/status`, `metro/log`, `devtools/status`,
    `modules/state-changed | crashed | failed`, `session/log`.
- **`fake-boot.ts`** (NEW, test-only) — a no-op services stub gated
  behind `RN_DEV_DAEMON_BOOT_MODE=fake`. Emits `metro/status:
  starting` then `running` with realistic timing (setTimeout, not
  microtask — listeners attach after bootFn resolves). Lets the
  merge-gate integration test exercise the state machine + event
  fan-out without spawning Metro.
- **`orphan-sweep.ts`** (NEW) — cross-platform module orphan cleanup.
  On daemon boot, scans `~/.rn-dev/modules/<id>/.lock`, reads each
  pid, checks PPID. PPID=1 → crashed-daemon orphan → kill the
  process group and unlink the lock. PPID≠1 → another live daemon
  still owns a shared `global`-scope module → leave alone. Linux
  reads `/proc/<pid>/stat`; macOS shells out to `ps -o ppid=`.
- **`session.ts`** — expanded with `ServicesSnapshot` + `SessionEvent`
  envelope types. The event discriminant is a string literal union,
  not `string`, so the TypeScript compiler catches mistyped `kind`
  values at the handler sites.
- **`spawn.ts`** — `ConnectToDaemonOptions.daemonEntry` added. Threads
  the explicit CLI path through `spawnDetachedDaemon` so Electron
  (Phase 13.4) can override `process.argv[1]`, which in packaged
  builds points at `main.js`, not the CLI. This addresses Phase 13.1
  reviewer P1#4.

### `src/core/module-host/manager.ts`

`NodeSpawner` now prepends `setpriv --pdeathsig SIGKILL --` when
`setpriv` is on PATH on Linux. The kernel kills the module
subprocess the instant the daemon dies — closes the orphan window
ahead of the next daemon's startup sweep. Gracefully falls back to
plain `node <modulePath>` when `setpriv` isn't available (macOS,
distros without util-linux).

### `src/core/audit-log.ts`

Cross-process serialization. `AuditLog.append()` now runs its
critical section under an `O_EXCL` lockfile at `<path>.lock`. Stale
locks (`mtimeMs` > 2000ms) are force-reclaimed so a crashed writer
can't block fresh appenders.

Perf: the naive "re-read tail under every lock" version turned the
100k-entry verify test into O(n²). Added a `lastObservedSize`
invariant — sequential same-process appends compare `stat().size`
against the cached value, skip the tail re-read when nobody else
has written, and stay O(1). Cross-process contention pays the
tail-read cost only when another process actually appends.
`rotateIfNeeded` resets the invariant.

### Phase 13.1 reviewer carryovers

- **P1#3** (Architecture): stale-socket `unlink` hoisted from
  `IpcServer.start()` into `runDaemon` — lock-holder now deletes
  post-lock, tightening the post-lock/pre-bind window.
- **P1#4** (Architecture): `daemonEntry` option threaded. See
  `spawn.ts` section above.

## Merge gate

Integration test #3 at
[`src/daemon/__tests__/session-boot.test.ts`](../../src/daemon/__tests__/session-boot.test.ts):

- Spawn daemon with `RN_DEV_DAEMON_BOOT_MODE=fake`.
- Subscribe to `events/subscribe` → `{subscribed: true}` confirmation.
- `session/start { profile: <minimal> }` → `{status: "starting"}`.
- Wait for `metro/status: starting` then `metro/status: running` events.
- `session/status` → `{status: "running", services: {...}}`.
- `session/stop` → `metro/status: stopped` event → daemon still up
  (`daemon/ping` answers).
- Second test: concurrent `session/start` while running returns
  `E_SESSION_ALREADY_RUNNING`.

## Baselines (post-merge)

- **vitest**: 887 / 0 (was 885)
- **tsc root**: 150 (pre-existing wizard errors, unchanged)
- **tsc electron**: 0
- **tsc per-module (3)**: 0 / 0 / 0
- **`bun run build`**: green
- **`bun run typecheck`**: green at 150 baseline

## What's deferred

- Real Metro driven by the daemon in the integration test. The
  spec's fallback of a fake driver behind `RN_DEV_DAEMON_BOOT_MODE`
  proved the right call — Metro itself is too heavyweight to boot
  against a fixture. Phase 13.3 flips the TUI to the daemon path and
  exercises real Metro end-to-end in the existing TUI smoke flow.
- `macOS` PDEATHSIG. No equivalent exists; orphan sweep is the only
  mechanism on darwin. Practical impact is bounded because dev
  machines restart daemons constantly, but it's a known gap.
- Multi-session daemon. The supervisor assumes one active session per
  daemon today. If future phases need multiple concurrent sessions,
  swap the singleton state for a `Map<sessionId, SessionState>` and
  thread `sessionId` through the RPC envelopes.

## Next

Phase 13.3 — **TUI migrates to the daemon**. See the next-session
prompt at
[`docs/plans/2026-04-??-next-session-prompt-phase-13-3.md`](./2026-04-??-next-session-prompt-phase-13-3.md).
`start-flow.ts` flips from direct `bootSessionServices(...)` to
`connectToDaemon(worktree) → session/start → events/subscribe`. The
factory extracted in 13.2 stays put as the daemon-side boot path;
the TUI just swaps its call site. Merge gate: integration test #4
(session survives client churn).
