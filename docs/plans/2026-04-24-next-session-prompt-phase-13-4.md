# Next-Session Prompt — Phase 13.4 (Electron migrates)

**Paste the block below at the start of the next session.**

---

We're continuing the rn-dev-cli daemon refactor. Phase 13.3 shipped
2026-04-24 via [PR #17](https://github.com/utopyk/rn-dev-cli/pull/17)
— the TUI is now a thin client of the per-worktree daemon. Metro /
DevTools / Builder / Watcher + module host live entirely in the
daemon, exposed through 11 RPCs + an `events/subscribe` stream that
carries 12 event kinds. Client-side adapters + a
`connectToDaemonSession` orchestrator live under
[src/app/client/](../../src/app/client/).

This session flips Electron over. All `electron/ipc/*` handlers
become `IpcClient` proxies to the daemon;
[electron/module-system-bootstrap.ts](../../electron/module-system-bootstrap.ts)
is deleted. The renderer surface (preload allowlist, React
components) does NOT change.

See [2026-04-24-module-system-phase-13-3-tui-client-handoff.md](./2026-04-24-module-system-phase-13-3-tui-client-handoff.md)
for the 13.3 closeout and the three deferred architecture P1s that
MUST be addressed before Electron can wire cleanly.

## This session: Phase 13.4 only

Scope — Electron becomes a daemon client. MCP stays in-process; it
migrates in 13.5.

### Prerequisite fixes (must land first — deferred from 13.3)

These three are load-bearing for Electron and were deliberately held
back from 13.3 because the TUI could tolerate their absence:

1. **Daemon-death handling in `connectToDaemonSession`.** Add
   `onClose` + `onError` to the subscription. On close-while-running,
   emit a `disconnected` event on each adapter and optionally attempt
   one reconnect (new IpcClient + new subscribe + `session/status`
   → if `running`, re-attach; if not, surface a clear error).
   Electron users expect the app to keep running when the daemon
   crashes — the TUI got away with "just ctrl-C and restart".
2. **Adapter `_dispatch` contract.** Drop the underscore convention
   and introduce an explicit `AdapterSink` interface. Electron's
   main-process orchestrator and its renderer-side mirror will both
   call into it; the method needs to read as public.
3. **`routeEventToAdapters` extensibility.** The 13.3 switch is
   closed — `modules/*` and `session/*` events have no adapter
   home. Either add a `ModuleHostClient` adapter alongside the
   existing four (and route `modules/state-changed|crashed|failed`
   to it), or expose `session.onRawEvent((kind, data) => …)` as a
   secondary fan-out. Electron renderer consumes modules events.

### Electron flip

1. **Replace `electron/module-system-bootstrap.ts` with a
   client-side session.** Today it calls `createModuleSystem` +
   publishes to the `serviceBus`. After the flip, Electron main
   calls `connectToDaemonSession` at app-ready time and publishes
   the returned adapters on the serviceBus (identical shape to
   13.3's start-flow). Delete `bootstrap.ts` once nothing imports it.
2. **Rewire `electron/ipc/*` handlers.** Every handler currently
   resolves a local manager reference from the serviceBus and calls
   it directly. Replace with the adapter's async method. Most
   handlers become 2-line passthroughs. Pay attention to:
   - `electron/ipc/services.ts` — Metro start/stop/reload/devMenu
   - `electron/ipc/modules-config.ts` — touches the module registry;
     likely needs the new `ModuleHostClient` adapter (prereq #3)
   - `electron/ipc/index.ts` — main dispatcher; consolidate the
     serviceBus subscriptions into one
3. **Preload / renderer untouched.** `electron/preload.ts` and
   anything under `renderer/` keeps working because
   `contextBridge.exposeInMainWorld` is still calling the same
   `ipcMain.handle` surface. Preload allowlist test
   (`electron/__tests__/preload-allowlist.test.ts`) should pass
   without changes.
4. **Electron's daemon-entry lookup.** `process.argv[1]` in a
   packaged Electron app points at `main.js`, not the rn-dev CLI
   entry. The `daemonEntry` option on `connectToDaemonSession` is
   the hook — thread it through. See the comment block at
   [src/daemon/spawn.ts:22-26](../../src/daemon/spawn.ts) for the
   rationale.

## Merge gate for 13.4

**Integration test #5 — GUI-quit / MCP-survive.** Added to
`electron/__tests__/gui-mcp-survive.test.ts`:

- Spawn the daemon; spawn an MCP server client against the same
  socket; subscribe to events.
- Boot Electron (spawn `bun run electron` with a fake display or
  `--headless` flag) and wait for its `connectToDaemonSession` to
  complete.
- Issue a session/status query from MCP → verify `running`.
- Kill Electron.
- Re-query session/status from MCP → MUST still be `running`.
- Issue a `metro/reload` RPC from MCP → works.
- Cleanup.

Plus all existing 70+ Electron integration tests must still pass
unchanged.

### Existing tests that may need adjustment

- `electron/__tests__/module-system-bootstrap.test.ts` —
  `bootstrap.ts` is going away; port the test's assertions
  ("publishes moduleHost + moduleRegistry + moduleEventsBus") to
  the new client-side orchestrator in Electron main.
- `electron/__tests__/modules-list.test.ts` /
  `electron/__tests__/modules-panels.test.ts` — if they construct
  an in-process ModuleHostManager, they may need to move to the
  daemon path via `spawnTestDaemon` (same pattern 13.2's
  `session-boot.test.ts` uses).

## TDD discipline

1. First commit: integration test #5 written and failing (Electron's
   client-flip doesn't exist yet).
2. Prerequisite fixes (daemon-death, AdapterSink, route
   extensibility) land as separate commits on the same branch with
   their own small tests.
3. Electron flip lands after.
4. Do not merge until test #5 is green.

## Baselines to match or improve on (post-13.3)

- **vitest**: 897 / 0
- **tsc root**: 149 (wizard errors — pre-existing)
- **tsc electron**: 0
- **tsc per-module (3)**: 0 / 0 / 0
- **`bun run build`**: green
- **`bun run typecheck`**: green at 149

## After merging 13.4

- Write `docs/plans/2026-04-??-module-system-phase-13-4-electron-client-handoff.md`.
- Run parallel reviewers (Kieran TS + Architecture + Security +
  Simplicity). Apply P0/P1 pre-merge. Squash-merge.
- Queue `docs/plans/2026-04-??-next-session-prompt-phase-13-5.md`
  for **Phase 13.5 — MCP ergonomics**:
  - MCP server uses `connectToDaemon` client-side
  - Active-daemon registry at `~/.rn-dev/registry.json`
  - Error-shape consolidation across the three client surfaces

## Deferred follow-ups from 13.3 to consider folding in

Lower priority; fold whichever touch the Electron-flip diff naturally:

- **Kieran P1-1**: typed EventEmitters on
  MetroManager/DevToolsManager/Builder/FileWatcher so `bind<T>` in
  supervisor drops its `as TPayload` cast.
- **Kieran P1-2**: replace `as FakeSurface as unknown as RealType`
  double-casts in `fake-boot.ts` with `Pick<>` + `satisfies`.
- **Kieran P1-6**: exhaustive-typed `routeEventToAdapters` using
  `SessionEvent["kind"]`.
- **Kieran P1-7**: typed `EventEmitter<ServiceBusEvents>` on
  service-bus.
- **Security P2-1**: project `MetroInstance` at the RPC boundary to
  hide pid / projectRoot from renderer + MCP clients.
- **Security P2-2**: cap `events/subscribe` subscribers (32 per
  supervisor).
- **Security P2-3**: replace Builder's incomplete ANSI-strip regex
  with a production-grade stripper; apply to metro/log too.

## Branching

```sh
git checkout main
git pull
git checkout -b feat/module-system-phase-13-4-electron-client
```

Per Martin's working preference for this repo: direct feature branch
on `main`, not worktrees — avoids the duplicate install/build pain.

## Remember

- `vitest run`, not `bun test`.
- `bun run build` + `bun run typecheck` for production verification.
- The daemon's socket is `0600` and `.rn-dev/` is `0700` —
  `connectToDaemonSession` honors `RN_DEV_DAEMON_SOCK` as an escape
  hatch for tests.
- Every third-party module tool wire name carries the `<moduleId>__`
  prefix.
- `config-set` audit entries record patch keys, never values.
- **One daemon = one worktree = one session.** Electron opening a
  second session against the same daemon is not supported in 13.4;
  multi-session is future phase work.
- `builder/build` RPCs now reject projectRoot outside the daemon's
  worktree. If Electron needs cross-worktree builds, that's a 13.5+
  scope decision — do not weaken the guard.

## The rest of the Phase 13 arc

- **13.5 MCP ergonomics** — MCP server uses `connectToDaemon`
  client-side; active-daemon registry at `~/.rn-dev/registry.json`;
  error-shape consolidation. Stretch/optional.
