# Next-Session Prompt — Phase 13.3 (TUI migrates to the daemon)

**Paste the block below at the start of the next session.**

---

We're continuing the rn-dev-cli daemon refactor. Phase 13.2 shipped
2026-04-24 via [PR #16](https://github.com/utopyk/rn-dev-cli/pull/16)
— services (Metro, DevTools, ModuleHost) now live inside a
per-worktree daemon, exposed via `session/start` / `session/stop` /
`session/status` / `events/subscribe` RPCs. TUI / Electron / MCP are
still on their existing in-process paths; **this session flips the
TUI over to the daemon as the proving ground for the client pattern
before the bigger Electron surface in 13.4**. See
[`docs/plans/2026-04-24-module-system-phase-13-2-services-in-daemon-handoff.md`](./2026-04-24-module-system-phase-13-2-services-in-daemon-handoff.md)
for the full 13.2 closeout, and
[`docs/superpowers/specs/2026-04-24-daemon-refactor-design.md`](../superpowers/specs/2026-04-24-daemon-refactor-design.md)
(on `design/daemon-refactor`) for the overall architecture.

**One-paragraph recap of the arc:** today's TUI path wires
`MetroManager` / `DevToolsManager` / `ModuleHostManager` up directly
in `src/app/start-flow.ts::startServicesAsync` behind an `IpcServer`
at `<wt>/.rn-dev/sock`. 13.2 built a `DaemonSupervisor` that drives
the same services from a separate daemon process. This session
**deletes the direct-call path from the TUI** and replaces it with
`connectToDaemon(worktree) → session/start → events/subscribe`. The
factory extracted in 13.2 (`bootSessionServices` in
`src/core/session/boot.ts`) stays put as the daemon-side boot path;
the TUI just swaps its call site from direct function invocation to
IPC client.

## This session: Phase 13.3 only

Scope — the TUI becomes a thin client. Electron + MCP are still
in-process; they migrate in 13.4 / 13.5.

1. **Flip `start-flow.ts::startServicesAsync` to client mode.**
   Today it calls `bootSessionServices({...})` directly and fans the
   returned services into `serviceBus.*`. Replace with:
   - `connectToDaemon(projectRoot)` to get an `IpcClient` (this auto-
     spawns the daemon if not already running, per Phase 13.1).
   - `session/start { profile }` over the client.
   - `events/subscribe` over the client; `onEvent` handler routes
     `metro/status`, `metro/log`, `devtools/status`,
     `modules/state-changed | crashed | failed`, `session/log` into
     `serviceBus.*` so the existing React UI keeps working unchanged.
   - Drop the direct imports of `MetroManager` / `DevToolsManager` /
     `ModuleHostManager` from the TUI — the TUI no longer owns
     service lifecycle.
2. **Re-shape `serviceBus` to accept event-stream inputs.** The
   non-React→React bus was designed around direct service references
   (`serviceBus.setMetro(metroInstance)`). Under the daemon-client
   model the TUI no longer *has* a `MetroManager` instance —
   everything arrives as events. Options:
   - **Option A**: keep `setMetro(metro)` / `setDevTools(devtools)`
     surface; introduce lightweight **client adapters**
     (`MetroClientAdapter`, `DevToolsClientAdapter`) that wrap the
     IpcClient and expose the same EventEmitter surface the TUI
     expects. Keeps the React side zero-change.
   - **Option B**: rewrite `serviceBus` to be event-native — the TUI
     attaches to `serviceBus.onMetroStatus(handler)` etc., and the
     daemon-client feeds those directly.
   Recommend **Option A** for 13.3 — it bounds the blast radius to
   the boot path and keeps the React UI unchanged. 13.4 can
   generalize. The adapters are ~100 LOC total and mirror the
   emitter surfaces `services.metro.on("status"|"log")` etc. already
   published by the daemon's `events/subscribe`.
3. **Handle daemon absence + crash recovery.**
   - If `connectToDaemon` times out spawning, surface a clear error
     in the TUI and exit — don't half-boot.
   - If the subscription's socket drops mid-session (daemon
     crashed), reconnect once. If reconnect fails, fall the TUI back
     to a "daemon unreachable" screen rather than freezing the UI.
4. **Delete the `IpcServer` the TUI used to start itself.** The
   daemon owns the socket now — the TUI opening its own IpcServer at
   `<projectRoot>/.rn-dev/sock` would collide with the daemon's bind
   on the same path. The `bootSessionServices` signature still takes
   an `ipc: IpcServer` (daemon passes its own), so the factory
   itself doesn't change.
5. **Retire the wizard's `onWizardComplete` → `startServices` path.**
   After the flip, the wizard completes → saves profile →
   `connectToDaemon(projectRoot)` → `session/start`. Same event flow
   as the non-wizard path. The `startServices` helper in
   `start-flow.ts` becomes unused and can be deleted (it was already
   called out as YAGNI in 13.2 simplicity review).

## Merge gate for 13.3

**Integration test #4 — session survives client churn.** Added to
`src/app/__tests__/tui-client.test.ts` using `spawnTestDaemon` +
the fake-boot mode from 13.2:

- Spawn daemon → TUI client connects via `connectToDaemon`.
- Send `session/start` + subscribe to events.
- Close the subscription socket client-side (simulate TUI quit or
  crash).
- Re-connect → `session/status` reports `running`.
- `metro/status` events still flow to the new subscriber — daemon
  kept the session alive across client churn.
- Cleanup: `session/stop` then daemon exits via `daemon/shutdown`.

Also update the existing TUI integration tests (if any) to run
against the daemon path.

### Existing tests that may need adjustment

Likely touch points: `src/app/__tests__/modules-subscribe.test.ts`,
`src/app/__tests__/modules-ipc.test.ts` — these currently construct
an in-process `IpcServer` + `ModuleHostManager`. If the TUI's wiring
moves, these tests may need to spin up a test daemon via
`spawnTestDaemon` instead. Audit before changing — they might
already test the bus layer which is unchanged.

## TDD discipline

1. First commit on the feature branch: `tui-client.test.ts` written
   and failing (the client adapters and event wiring don't exist
   yet).
2. Implementation commits follow.
3. Do not land until the test is green.

## Baselines to match or improve on (post-13.2)

- **vitest**: 889 / 0
- **tsc root**: 150 (pre-existing wizard errors)
- **tsc electron**: 0
- **tsc per-module (3)**: 0 / 0 / 0
- **`bun run build`**: green
- **`bun run typecheck`**: green (at 150 baseline)

## After merging 13.3

- Write
  `docs/plans/2026-04-??-module-system-phase-13-3-tui-client-handoff.md`.
- Run parallel reviewers (Kieran TS + Architecture + Security +
  Simplicity). Apply P0/P1. Squash-merge.
- Queue `docs/plans/2026-04-??-next-session-prompt-phase-13-4.md`
  for **Phase 13.4 — Electron migrates**. All `electron/ipc/*`
  handlers become `IpcClient` proxies to the daemon;
  `electron/module-system-bootstrap.ts` is deleted; renderer
  surface unchanged. Merge gate: integration test #5 (GUI-quit /
  MCP-survive) + all existing Electron integration tests still
  pass.

## Deferred P2s from 13.2 to consider folding in

- `detachAndExit` duplicates `spawnDetachedDaemon` — collapse
  (Simplicity #2).
- `startServices` TUI wrapper is a one-line passthrough —
  deleted naturally by this session's #5.
- `wireServiceEvents` in supervisor is five near-identical
  handlers — table-driven (Simplicity #6).
- `setpriv` PATH lookup could be pinned to absolute paths
  (Security P2).
- `orphan-sweep` `.lock` read could stat-first bound
  (Kieran #9).

Fold whichever touch the TUI-flip diff naturally; the rest can wait.

## Branching

```sh
git checkout main
git pull
git checkout -b feat/module-system-phase-13-3-tui-client
```

Per Martin's working preference for this repo: direct feature branch
on `main`, not worktrees — avoids the duplicate install/build pain.

## Remember

- `vitest run`, not `bun test`.
- `bun run build` + `bun run typecheck` for production verification.
- `.claude/` and SDK `dist/` are gitignored.
- The daemon's socket is `0600` and `.rn-dev/` is `0700` —
  `connectToDaemon` honors `RN_DEV_DAEMON_SOCK` as an escape hatch
  for tests / out-of-band debugging.
- Every third-party module tool wire name carries the `<moduleId>__`
  prefix.
- `config-set` audit entries record patch keys, never values.
- 13.2's `DaemonSupervisor` assumes a single active session per
  daemon. Keep the TUI → daemon mapping 1:1 for 13.3; multi-session
  support is future phase work.
- The `bootSessionServices` factory is now the canonical daemon-side
  boot. Resist the temptation to add a second TUI-side variant —
  the unification is the entire point of this arc.

## The rest of the Phase 13 arc

- **13.4 Electron migrates** — all `ipcMain` handlers under
  `electron/ipc/` become `IpcClient` proxies to the daemon.
  `electron/module-system-bootstrap.ts` deleted. Renderer surface
  unchanged. Merge gate: test **#5** (GUI-quit / MCP-survive) +
  all existing 70+ Electron integration tests still pass.
- **13.5 (stretch)** — MCP ergonomics: MCP server uses
  `connectToDaemon` client-side; active-daemon registry at
  `~/.rn-dev/registry.json`; consolidate error shapes.
