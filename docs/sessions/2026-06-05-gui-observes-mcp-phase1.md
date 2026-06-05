# Session — GUI observes agent/MCP sessions (Phase 1) landed

**Date:** 2026-06-05
**Commit:** `37cf58c` on `main` (local-only, 47 ahead of origin — never pushed)
**Plan:** `docs/plans/2026-06-05-feat-gui-observes-mcp-sessions.md` (Phase 1)

## What shipped

The Electron GUI now auto-surfaces sessions started by **any** client (an LLM over MCP, the CLI/TUI) as **read-only, badged 🤖 tabs** — answering the user's question "can I see what an LLM is doing via MCP in the GUI?". This is the reverse of agent-native parity: anything an agent does in the shared daemon, a human can watch in the GUI.

User-confirmed surface: auto badged tabs (not a sidebar panel); mutating controls disabled behind a read-only banner; closing an observe tab detaches only the observer (the agent's session keeps running).

## How it works (layers)

- **Daemon** (`rpc-args`, `supervisor`, `index`, `version`): `events/subscribe` attach-by-id gains an `observer` flag. Observers live in a separate **non-counting** `SessionEntry.observerConnections` set that never gates teardown. `DAEMON_VERSION` 0.1.2 → 0.1.3.
- **Client** (`src/app/client/session.ts`): `connectToDaemonSession` accepts `attachSessionId` / `observer` / `worktreeKeyHint` (param 2 now `Profile | null`). The hint seeds `worktreeKey` so an already-running attach-by-id skips the bare `session/status` backfill that returns `E_SESSION_AMBIGUOUS` under N>1 sessions.
- **Electron** (`electron/ipc/sessions.ts` new + `state`/`instance`/`services`/`devtools`/`daemon-connect`/`main`): `SessionsWatcher` polls `sessions/list` refcount-free (`isDaemonAlive` + raw `IpcClient`, never `connectToDaemon`). A pure `planSessionReconcile` classifies external vs own, single-flights in-flight observes, tears down vanished ones, caps observed tabs. `instances:remove` `disconnect()`s observe tabs instead of `session/stop`; devtools `select-target`/`restart` disabled for observed sessions.
- **Renderer** (`App`, `InstanceTabs`, `DevToolsView`, `types`, CSS): 🤖 badge, read-only banner, "Stop observing" close copy, disabled mutating shortcuts, read-only DevTools.

## Why the daemon change (deviation from spec's "no daemon change")

The daemon has **no idle reaper** — teardown is only socket-close refcount, `session/stop`, or daemon shutdown. A naive (counting) observer would pin the agent's session and its Metro port alive forever after the agent released. Non-counting observers fix this. See memory `code_fact_observer_attach_non_counting.md`.

## Verification (3-layer + real-boot)

- **vitest:** +20 (observer non-counting teardown; reconcile-planner edge cases; badged tab; read-only DevTools). Full suite green modulo two pre-existing **concurrency-flaky** integration tests (`registry`, `session-watchdog`) that pass in isolation (16/16) — different tests fail each run; neither touched by this work.
- **tsc:** 4 baseline (excl `src/ui`) + 0 electron. **smoke:** 13.
- **real-boot** (`tests/electron-real-e2e/gui-observes-mcp-session.spec.ts`, `REAL_BOOT_SMOKE=1`, workspace-1 emulator, `1 passed`): an external agent boots+builds+captures; the GUI auto-surfaces a 🤖 tab, loads RN DevTools read-only, **the agent's capture survives the GUI's Fusebox connect** (the one empirical unknown — resolved; delta-fed-list contingency not needed), and closing the observe tab leaves the agent session running. **0 daemon leaks.**

## Parked / next

- **Phase 2 (take over):** promoting an observer to interactive needs a *fresh* attach (the observer connId sits in the daemon's non-counting set; flipping buttons client-side is insufficient).
- **Phase 3:** authoritative `origin`/`label` at `session/start` (drops the "not one of our sessionIds = external" heuristic).
- **Task #7** (event-push stall on MCP build-status path) still open, not blocking.
