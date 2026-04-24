# Phase 13.4 Handoff — Electron wires to the daemon client

**Date:** 2026-04-24
**Branch:** `feat/module-system-phase-13-4-electron-client`
**Next phase:** 13.4.1 (complete the Electron IPC handler flip) → 13.5 (MCP ergonomics)

## What shipped

Phase 13.4 delivers the architectural prerequisites + the Electron-side
daemon-client primitive. Integration test #5 — the merge gate — pins
that the daemon + any attached MCP client survive Electron's
disappearance.

Scope split from the written plan:
- **Landed this phase:** the three deferred-from-13.3 architecture
  prereqs, integration test #5, and `electron/daemon-connect.ts`
  wired into Electron main as an additive connection alongside the
  in-process `startRealServices`.
- **Deferred to Phase 13.4.1:** deletion of
  `electron/module-system-bootstrap.ts`, the ipcMain handler flip
  (`metro`, `tools`, `modules-config`, `modules-install`,
  `modules-panels-register`), and the collapse of
  `electron/ipc/services.ts`'s 514 LOC of in-process orchestration.
  Rationale below.

### Prereq #1 — daemon-death handling (feat: daemon-death handling + disconnect())

`connectToDaemonSession` now wires `onClose` / `onError` on its
subscription into a `notifyDisconnected(err?)` dispatcher that fans a
`disconnected` event to every adapter AND rejects any in-flight
`runningPromise`. Previously a daemon death mid-boot would hang the
full 30-second timeout before the caller learned anything was wrong.

`DaemonSession` grew two exit points:
- `disconnect()` — closes subscription + client sockets WITHOUT
  sending `session/stop`. Electron's window-close uses this so a
  second client (MCP, another TUI, a second GUI instance) keeps
  working.
- `stop()` — preserved its pre-13.4 semantics: `session/stop` then
  disconnect. CLI paths where "user quits" legitimately means "return
  the daemon to idle" keep calling this.

Voluntary `disconnect()` / `stop()` do NOT fire the `disconnected`
event — that's reserved for socket drops (daemon crashed, SIGKILLed,
host lost).

New integration tests in
[src/app/client/__tests__/session-disconnect.test.ts](../../src/app/client/__tests__/session-disconnect.test.ts)
cover both invariants.

### Prereq #2 — AdapterSink interface

The 13.3 `_dispatch` underscore convention broke down the moment a
second dispatch site (future Electron renderer mirror) came into
view. Introduced `AdapterSink<K extends string>` in
[src/app/client/adapter-sink.ts](../../src/app/client/adapter-sink.ts)
with:
- `dispatch(kind, data)` — public entry point for fanning a daemon
  event into an adapter.
- `notifyDisconnected(err?)` — signal an unexpected daemon drop.

Every adapter (Metro / DevTools / Builder / Watcher / ModuleHost)
narrows `K` to its own literal-string union so TypeScript catches a
mis-routed event at compile time. Behavior unchanged.

Conformance test:
[src/app/client/__tests__/adapter-sink.test.ts](../../src/app/client/__tests__/adapter-sink.test.ts).

### Prereq #3 — ModuleHostClient adapter + route modules/* events

The 13.3 `routeEventToAdapters` switch was a closed set: `modules/*`
events fell into the default case. Added
[src/app/client/module-host-adapter.ts](../../src/app/client/module-host-adapter.ts):
- Consumes `modules/state-changed | crashed | failed` via
  `AdapterSink<ModuleHostEventKind>`.
- Re-emits each as a typed topic event AND a shimmed `modules-event`
  payload whose shape matches the pre-13.4 in-process
  `moduleEventsBus`.

Preserving the `modules-event` shape means Electron's existing
renderer-forwarding code in
[electron/ipc/index.ts](../../electron/ipc/index.ts) (93-95) will
keep working during the 13.4.1 flip without edits. Same filter —
only transitions touching `active` fan out to the renderer.

The adapter exposes one RPC passthrough (`list()`); more land as the
Electron flip discovers what it actually consumes. Keeps the client
from prematurely mirroring the daemon's `modules-ipc.ts` surface
1-to-1.

`DaemonSession` grew a `modules: ModuleHostClient` field. The
session-disconnect test was extended to cover it.

### Integration test #5 — GUI-quit / MCP-survive

[electron/__tests__/gui-mcp-survive.test.ts](../../electron/__tests__/gui-mcp-survive.test.ts)
pins the architectural property:

1. Daemon boots with `RN_DEV_DAEMON_BOOT_MODE=fake`.
2. An MCP-like `IpcClient` subscribes and confirms `session/status: running`.
3. A `connectToDaemonSession` call plays the Electron role — this is
   the exact primitive `electron/main.ts` uses after the flip.
4. The "Electron" client calls `disconnect()`.
5. MCP-like client re-queries `session/status` → still `running`, issues
   a `metro/reload` RPC → succeeds, and its subscription still delivers
   events.

Not a packaged-Electron test. Phase 13.5 extends this with a real
`bun run electron --headless` harness once MCP itself moves onto
`connectToDaemon`; a packaged-Electron spawn in every CI run isn't
worth the cost today.

### Electron main wiring (partial)

[electron/daemon-connect.ts](../../electron/daemon-connect.ts) —
`connectElectronToDaemon(projectRoot, profile)`:
- Calls `connectToDaemonSession` with a `daemonEntry` resolved via
  `import.meta.url` + `../../src/index.tsx`. `process.argv[1]` in a
  packaged Electron points at `main.js`, not the CLI entry — the
  comment block at [src/daemon/spawn.ts:22-26](../../src/daemon/spawn.ts)
  documents the hazard.
- Publishes `session.metro`, `.devtools`, `.builder`, `.watcher`,
  `.worktreeKey` on the serviceBus. Shape matches the TUI's
  `connectAndWire` intentionally so reviewers can A/B the two sites.

[electron/main.ts](../../electron/main.ts) invokes it after the
renderer's `did-finish-load`, best-effort. Failures are non-fatal in
13.4 because in-process services still cover the UI; 13.4.1 removes
that fallback.

`window-all-closed` now calls `daemonSession.disconnect()`, NOT
`stop()`. Using `stop()` would tear the session down for every other
client attached to the daemon — the exact regression prereq #1 was
designed to prevent.

## What's deferred to Phase 13.4.1

The full Electron IPC handler flip exceeded the ~1-session budget
once the scope of panel-bridge + `modules:host-call` became visible.
None of the 13.4 prereqs needed it to land cleanly, and coexistence
during 13.4 means nothing in the current UI regresses.

Items:

1. **Delete [electron/module-system-bootstrap.ts](../../electron/module-system-bootstrap.ts).**
   The 102 LOC construct a full Electron-local `CapabilityRegistry` +
   `ModuleHostManager` + `ModuleRegistry` duplicate of the daemon's
   module system. Panel-bridge
   (`modules:call-tool` / `modules:host-call`) depends on a real
   `ModuleHostManager` reference, so we can't delete this file until
   the panel-bridge has a daemon-RPC path. In-process state now
   duplicates daemon state — acceptable for one phase, not long-term.

2. **Rewire ipcMain handlers to adapters.**
   - [electron/ipc/metro.ts](../../electron/ipc/metro.ts) — three
     handlers (`metro:reload`, `metro:devMenu`, `metro:port`) that
     currently pull an in-process `MetroManager` off an instance.
     Should consume `serviceBus.metro` (MetroClient adapter).
   - [electron/ipc/tools.ts](../../electron/ipc/tools.ts) —
     `watcher:toggle` becomes a WatcherClient passthrough.
   - [electron/ipc/modules-config.ts](../../electron/ipc/modules-config.ts)
     currently calls `daemonGetConfig` / `daemonSetConfig` in-process
     (see the comment at line 8-14). Post-flip, these call
     `modules/config/get` / `modules/config/set` RPCs over the
     socket.
   - [electron/ipc/modules-install-register.ts](../../electron/ipc/modules-install-register.ts)
     — install/uninstall/marketplace map to `modules/install`,
     `modules/uninstall`, `marketplace/list`, `marketplace/info`
     daemon RPCs (already exist).
   - [electron/ipc/modules-panels-register.ts](../../electron/ipc/modules-panels-register.ts)
     — `modules:list` maps to `modules/list` daemon RPC; panel
     lifecycle (`activate-panel` / `deactivate-panel` /
     `set-panel-bounds`) stays Electron-side but `modules:call-tool`
     routes through the new daemon `modules/call` RPC.
   - `modules:host-call` — needs a NEW daemon RPC
     (`modules/host-call`). Panels use it to resolve host
     capabilities (e.g., `metro.reload`) against the daemon's
     capability registry.

3. **Collapse [electron/ipc/services.ts](../../electron/ipc/services.ts).**
   514 LOC of preflight / clean / watchman / signing / simulator boot
   / metro / build orchestration, most of which the daemon's
   `bootSessionServices` already runs. Keep the interactive prompts
   (package manager conflict, signing) client-side — renderer-gated
   UX that can't cross a daemon socket cleanly. Everything else
   becomes redundant and goes away.

4. **`electron/__tests__/module-system-bootstrap.test.ts`** (101
   lines, 5 tests) — port to assert the daemon-client-equivalent
   publishing via `connectElectronToDaemon` once bootstrap.ts is
   gone. `modules-list.test.ts` + `modules-panels.test.ts` construct
   in-process manager/registry and may need to move behind
   `spawnTestDaemon`.

## Baselines at merge

| Metric | 13.3 baseline | Phase 13.4 |
|---|---|---|
| vitest | 897 / 0 | 912 / 0 (+15 new) |
| tsc root | 149 | 149 |
| tsc electron | 0 | 0 |
| tsc per-module (3) | 0 / 0 / 0 | 0 / 0 / 0 |
| `bun run build` | green | green |
| `bun run typecheck` | green at 149 | green at 149 |

New tests breakdown:
- `gui-mcp-survive.test.ts` — 1 integration
- `session-disconnect.test.ts` — 2 integration
- `adapter-sink.test.ts` — 6 unit
- `module-host-adapter.test.ts` — 6 unit

## What's next — Phase 13.4.1

Execute the full Electron IPC flip + bootstrap deletion. The
architectural substrate (adapters, AdapterSink, ModuleHostClient,
daemon-death handling) is in place; 13.4.1 is execution against it
plus one new daemon RPC (`modules/host-call`).

Merge gate for 13.4.1: all 70+ Electron integration tests pass with
`electron/module-system-bootstrap.ts` removed; one new integration
test proves `modules/host-call` round-trips a capability invocation
from a panel through the daemon.

After 13.4.1, Phase 13.5 picks up MCP ergonomics:
- MCP server uses `connectToDaemon` client-side.
- Active-daemon registry at `~/.rn-dev/registry.json`.
- Error-shape consolidation across the three client surfaces.
