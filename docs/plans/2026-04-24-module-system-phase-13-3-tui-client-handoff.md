# Phase 13.3 Handoff — TUI migrates to the daemon client

**Date:** 2026-04-24
**PR:** [#17](https://github.com/utopyk/rn-dev-cli/pull/17)
**Merge commit:** f1a1480
**Next phase:** 13.4 (Electron migrates)

## What shipped

The TUI is now a thin client of the per-worktree daemon. Zero direct
construction of `MetroManager` / `DevToolsManager` / `Builder` /
`FileWatcher` / `IpcServer` in `src/app/start-flow.ts` — those live
in the daemon, and the TUI talks to them over the `events/subscribe`
stream and 11 RPCs.

### Daemon surface (new)

11 new RPC actions dispatched through `src/daemon/client-rpcs.ts`:

- `metro/reload`, `metro/devMenu`, `metro/getInstance`
- `devtools/listNetwork`, `devtools/status`, `devtools/clear`, `devtools/selectTarget`
- `builder/build`
- `watcher/start`, `watcher/stop`, `watcher/isRunning`

4 new event kinds on `events/subscribe` (via
`DaemonSupervisor.wireServiceEvents`):

- `devtools/delta` — network capture delta ids (clients re-query `listNetwork`)
- `builder/line`, `builder/progress`, `builder/done`
- `watcher/action-complete`

Full list of `SessionEvent` variants lives in
[src/daemon/session.ts](../../src/daemon/session.ts).

### Client surface (new)

Under [src/app/client/](../../src/app/client/):

- `MetroClient`, `DevToolsClient`, `BuilderClient`, `WatcherClient` —
  `EventEmitter` adapters with async methods that round-trip over
  `IpcClient.send`, plus `_dispatch(kind, data)` called by the
  session orchestrator to fan incoming events to listeners.
- `connectToDaemonSession(projectRoot, profile, opts?)` — single-call
  orchestrator that boots the daemon if needed, subscribes once,
  starts the session, awaits the `running` transition, and returns a
  `DaemonSession { client, metro, devtools, builder, watcher,
  worktreeKey, stop }`. Rejects promptly if the session transitions
  `starting → stopped|stopping` before reaching `running` (boot failed).

### TUI wiring

- [start-flow.ts](../../src/app/start-flow.ts) deleted the
  `startServicesAsync` / `startServices` helpers and swapped
  `bootSessionServices` direct-call for `connectToDaemonSession`.
- [AppContext.tsx](../../src/app/AppContext.tsx) + [App.tsx](../../src/app/App.tsx) + [service-bus.ts](../../src/app/service-bus.ts)
  updated for client adapter types — manager methods that were sync
  in-process became async round-trips (listNetwork, status, clear,
  selectTarget, reload, devMenu, getInstance, watcher start/stop/isRunning).
- Quit no longer calls `metro.stopAll()` — the daemon owns lifecycle;
  the TUI just closes its subscription. The merge-gate test in
  [src/app/__tests__/tui-client.test.ts](../../src/app/__tests__/tui-client.test.ts)
  pins that the session survives client churn.

## Scope expansion from the original plan

The original plan scoped the flip to event streams only (Option A,
"~100 LOC adapters", "React UI keeps working unchanged"). That was
unworkable — React consumes action methods (`reload`, `devMenu`,
`clear`, `selectTarget`, `build`, watcher toggle) and sync queries
(`listNetwork`, `status`, `getInstance`) that no daemon RPC covered.
A strict-plan flip would have shipped a TUI that renders but can't act.

Expanded per Martin's direction ("number 1 guideline is good arch,
we want a solid foundation for the 3 clients"). Every action the
TUI takes now goes through an RPC that Electron (13.4) and MCP (13.5)
will reuse. React became async where needed.

## Reviewer findings — applied + deferred

Parallel review by 4 agents (Kieran TypeScript + Architecture +
Security + Simplicity). All P0s and all security/simplicity P1s
landed in the second commit on the branch. 3 architecture P1s were
deliberately deferred to 13.4 where they become load-bearing.

### Applied pre-merge

- **[Security P0]** `builder/build.env` denylist — LD_PRELOAD /
  DYLD_INSERT_LIBRARIES / NODE_OPTIONS / PATH / IFS / PS4 rejected at
  the RPC boundary via a shared `checkEnv` validator extracted from
  profile-guard.ts. Previously a caller with socket access could
  inject code into every spawned build child.
- **[Security P1-1]** `builder/build.projectRoot` scoped to the
  supervisor's worktree via `checkAbsolutePath` + `path.relative`.
  Rejects sibling-repo escapes and relative paths.
- **[Security P1-2]** `Builder.build` refuses concurrent builds on
  the same instance — a looping RPC caller could otherwise fork-bomb
  xcodebuild/gradle children.
- **[Kieran P0-1]** Session orchestrator rejects `runningPromise` on
  pre-running `session/status: stopped|stopping` transitions.
  Previously the caller waited the full 30s timeout on boot failure.
- **[Kieran P0-2]** Dropped unnecessary `as unknown as Record<string,
  unknown>` cast in builder-adapter — `IpcMessage.payload` is already
  typed `unknown`.
- **[Kieran P1-3]** `parseSessionEventEnvelope` runtime guard at the
  wire — malformed daemon events discarded rather than silently
  narrowed.
- **[Kieran P1-4/P1-5]** `DevToolsClient.listNetwork` / `.status`
  return concrete `CaptureListResult<NetworkEntry>` /
  `DevToolsStatus` — downstream double-cast in AppContext.tsx
  eliminated.
- **[Simplicity P1a]** `detachAndExit` / `spawnDetachedDaemon`
  duplication collapsed (deferred Simplicity #2 from 13.2).
- **[Simplicity P1b]** `applyCliOverrides` helper extracted; wizard +
  non-wizard branches in start-flow no longer drift.
- **[Simplicity P1c]** Dead `watcherEnabled` useState removed from
  App.tsx.

### Deferred to 13.4 (documented here so next session picks them up)

- **[Arch P1-1]** `connectToDaemonSession` has no daemon-death path
  (subscribe has no `onClose` / `onError`). Acceptable for the TUI
  (user can ctrl-C and restart); NOT acceptable for Electron or
  long-lived MCP. **Becomes a 13.4 blocker.** Fix: `onClose` →
  adapter-level `disconnected` event → optional reconnect.
- **[Arch P1-2]** Adapter `_dispatch` underscore convention works
  inside one module but will look weird when Electron main/renderer
  split introduces a second dispatch site. Options: document as
  public integration point OR introduce `AdapterSink` interface +
  inject. Address before Electron wires through.
- **[Arch P1-3]** `routeEventToAdapters` is a closed switch —
  `modules/*` events have no home. When Electron renderer needs them
  (which it will in 13.4), add extensibility: `session.onRawEvent`
  or a `ModuleHostClient` adapter alongside the others.

### Deferred to follow-up work (lower priority)

- **[Kieran P1-1]** `bind<T>` in supervisor uses `as TPayload`. Accept
  for now — untyped service emitters mean the cast is load-bearing.
  Proper fix: typed EventEmitters on MetroManager / DevToolsManager /
  Builder / FileWatcher. Bigger refactor.
- **[Kieran P1-2]** `fake-boot.ts` uses `as FakeSurface as unknown
  as RealType`. Cleaner: `Pick<MetroManager, …>` + `satisfies`.
  Test-only code; low impact.
- **[Kieran P1-6]** `routeEventToAdapters` uses string literals
  decoupled from `SessionEvent["kind"]`. Exhaustive union typing
  would catch missing cases at compile time.
- **[Kieran P1-7]** Typed `EventEmitter<ServiceBusEvents>` on
  `service-bus.ts`. Pre-existing drift; subclass or tseventemitter
  wrapper.
- **[Security P2-1]** `MetroInstance.pid` / `.projectRoot` leak over
  `metro/getInstance`. Low severity — same-UID socket gate — but
  project before handing to MCP clients in 13.5.
- **[Security P2-2]** `events/subscribe` has no subscriber cap.
  Add a 32-subscriber limit to prevent fan-out amplification DoS.
- **[Security P2-3]** `builder/line` forwards incomplete-ANSI-stripped
  text. Replace with `ansi-regex`-grade stripper; apply to
  `metro/log` too.

Every deferred item is tagged in the code with a comment pointing at
this handoff.

## Baselines at merge

| Metric | Baseline | This phase |
|---|---|---|
| vitest | 889 / 0 | 897 / 0 (+8 new) |
| tsc root | 150 | 149 |
| tsc electron | 0 | 0 |
| tsc per-module (3) | 0 / 0 / 0 | 0 / 0 / 0 |
| `bun run build` | green | green |
| `bun run typecheck` | green | green |

## What's next — Phase 13.4

Electron migrates. All `electron/ipc/*` handlers become `IpcClient`
proxies to the daemon. `electron/module-system-bootstrap.ts` deleted;
renderer surface unchanged.

Merge gate: integration test #5 (GUI-quit / MCP-survive) — closing
the Electron window must leave the daemon + any live MCP session
untouched. Plus all 70+ existing Electron integration tests pass.

**Before implementation, Phase 13.4 MUST address the three deferred
architecture P1s from this phase**: daemon-death handling, adapter
`_dispatch` contract, and `routeEventToAdapters` extensibility. See
[2026-04-24-next-session-prompt-phase-13-4.md](./2026-04-24-next-session-prompt-phase-13-4.md).
