# Next-Session Prompt — Phase 13.4.1 (Electron flip completion)

**Paste the block below at the start of the next session.**

---

We're continuing the rn-dev-cli daemon refactor. Phase 13.4 shipped
2026-04-24 via [PR #18](https://github.com/utopyk/rn-dev-cli/pull/18)
— three deferred architecture P1s from 13.3 landed (`disconnect()` +
daemon-death handling, `AdapterSink` interface, `ModuleHostClient`
adapter), integration test #5 went green, and
[electron/daemon-connect.ts](../../electron/daemon-connect.ts)
stands up the Electron-side connect primitive. The connect call is
behind `RN_DEV_ELECTRON_DAEMON_CLIENT=1` — default off — because
enabling it today collides with `startRealServices`'s in-process
Metro on the profile port.

This session executes the flip proper: delete the env gate + the
in-process duplicate, remove
[electron/module-system-bootstrap.ts](../../electron/module-system-bootstrap.ts),
rewire every ipcMain handler to consume serviceBus adapters or call
daemon RPCs, and collapse
[electron/ipc/services.ts](../../electron/ipc/services.ts)'s 514 LOC
of preflight/clean/watchman/signing/metro/build orchestration into
a thin Electron-UX wrapper around `connectToDaemonSession`.

See [2026-04-24-module-system-phase-13-4-electron-client-handoff.md](./2026-04-24-module-system-phase-13-4-electron-client-handoff.md)
for the 13.4 closeout and the full deferred-items list.

## This session: Phase 13.4.1 only

Scope — flip the Electron IPC handlers + remove the duplicate
module-system bootstrap. MCP still in-process; it migrates in 13.5.

### 1. Delete the env gate

[electron/main.ts](../../electron/main.ts) has
`ELECTRON_DAEMON_CLIENT_ENABLED` guarding
`connectDaemonClientBestEffort`. Remove the gate. This forces
`startRealServices` to stop spawning its own Metro — which is what
steps 2-4 are for.

### 2. Rewire `electron/ipc/*` handlers

Every handler under [electron/ipc/](../../electron/ipc/) resolves a
local manager reference from the serviceBus and calls it directly.
Replace with the adapter's async method. Most handlers become 2-line
passthroughs. Concrete mapping:

| Handler | Current | Post-flip |
|---|---|---|
| [electron/ipc/metro.ts](../../electron/ipc/metro.ts) (`metro:reload`, `metro:devMenu`, `metro:port`) | `instance.metro.reload(worktreeKey)` | `await serviceBus.metro.reload()` |
| [electron/ipc/tools.ts](../../electron/ipc/tools.ts) (`watcher:toggle`) | in-process Watcher | `await serviceBus.watcher.start() / stop() / isRunning()` |
| [electron/ipc/modules-config.ts](../../electron/ipc/modules-config.ts) (`modules:config-get/set`) | `daemonGetConfig(opts, payload)` in-process | `await client.send({ action: "modules/config/get", ... })` |
| [electron/ipc/modules-install-register.ts](../../electron/ipc/modules-install-register.ts) (`modules:install`, `modules:uninstall`, `marketplace:list/info`) | in-process installer | daemon RPCs: `modules/install`, `modules/uninstall`, `marketplace/list`, `marketplace/info` (all exist) |
| [electron/ipc/modules-panels-register.ts](../../electron/ipc/modules-panels-register.ts) `modules:list` | in-process `listRows({manager, registry})` | `modules/list` RPC |
| `modules:list-panels` | `listPanels(deps.registry)` | new `modules/list-panels` RPC (or re-project from `modules/list`) |
| `modules:call-tool` | `resolveCallTool(manager, registry, moduleId, payload)` | `modules/call` RPC |
| `modules:host-call` | `resolveHostCall(manager, registry, payload, auditHostCall)` | NEW `modules/host-call` RPC — panel-bridge's main missing piece |
| `modules:activate-panel` / `deactivate-panel` / `set-panel-bounds` | `activatePanel(deps, payload)` — WebContentsView lifecycle | stays Electron-side; manifest lookup via daemon RPC for `moduleRoot` |

The only genuinely new surface is `modules/host-call`. Everything
else is wiring. Suggested commit order:
1. Simple adapter flips (`metro`, `tools`).
2. `modules/config/get|set` via daemon RPC.
3. `modules/install|uninstall|marketplace` via daemon RPC.
4. `modules/list|list-panels` via daemon RPC.
5. `modules/call` wiring for `modules:call-tool`.
6. New `modules/host-call` RPC on the daemon side + wire.
7. Panel-lifecycle handlers — thin shim around adapter for manifest
   lookup.

### 3. Delete `electron/module-system-bootstrap.ts`

Once the handlers no longer need `ModuleHostManager` /
`ModuleRegistry` references (because they're all daemon RPCs),
`bootstrapElectronModuleSystem` has no caller. Delete the file + its
test (port assertions into a new `electron/__tests__/daemon-connect.test.ts`
that pins `connectElectronToDaemon` publishes the expected adapters
on the serviceBus).

### 4. Collapse `electron/ipc/services.ts`

514 LOC of preflight / clean / watchman / signing / simulator boot /
metro / builder orchestration most of which the daemon's
`bootSessionServices` already runs. Keep these client-side:

- **Package-manager conflict prompt** — needs renderer interaction
  via `instance:prompt` + `prompt:respond:*` handlers. Cannot cross
  the daemon socket cleanly. Move to a thin helper that runs BEFORE
  `connectToDaemonSession` and settles the profile.
- **Code-signing detection prompt** — same story.

Everything else (preflight, clean, watchman, port-kill, simulator
boot, Metro start, build trigger) goes away — the daemon owns it.
`startRealServices` becomes a ~50-LOC function that:
1. Runs the interactive prompts (if any).
2. Calls `connectElectronToDaemon`.
3. Wires `instance:*` IPC channels off adapter events
   (metro.on('log') → `instance:metro`, builder.on('line') →
   `instance:build:line`, etc.).

### 5. Port / delete existing Electron tests

- [electron/__tests__/module-system-bootstrap.test.ts](../../electron/__tests__/module-system-bootstrap.test.ts)
  (101 lines, 5 tests) — port to a new
  `daemon-connect.test.ts` that asserts
  `connectElectronToDaemon`publishes the correct serviceBus keys.
- [electron/__tests__/modules-list.test.ts](../../electron/__tests__/modules-list.test.ts)
  + [electron/__tests__/modules-panels.test.ts](../../electron/__tests__/modules-panels.test.ts)
  — if they construct in-process ModuleHostManager, move behind
  `spawnTestDaemon` (same pattern 13.2's `session-boot.test.ts` uses).
- All ~70 existing Electron integration tests must still pass.

## New merge gate for 13.4.1

**Integration test #6 — panel-bridge survives the flip.** Added to
`electron/__tests__/panel-bridge-daemon.test.ts`:

- Spawn the daemon with a fake module that registers a panel +
  a host capability.
- `connectElectronToDaemon` + stand up a fake `BrowserHost`.
- Activate the panel → assert the WebContentsView factory was called
  with the right args.
- Fire a `modules/host-call` RPC from the fake panel — assert it
  resolves against the daemon-side capability registry.
- Kill Electron's connection — assert the daemon's panel subprocess
  continues.

Plus all existing Electron integration tests + integration test #5
from 13.4 stay green.

## TDD discipline

1. First commit: integration test #6 written and failing (the new
   `modules/host-call` RPC doesn't exist yet).
2. New `modules/host-call` RPC on the daemon side, with its own
   small test.
3. Handler flips land as separate commits per handler group.
4. `bootstrap.ts` deletion lands after nothing imports it.
5. `services.ts` collapse lands last.

## Baselines to match or improve on (post-13.4)

- **vitest**: 914 / 0 (902 baseline + 12 new in 13.4; the `+2 guard`
  addition made up for the typed-trio removal)
- **tsc root**: 149 (wizard errors — pre-existing)
- **tsc electron**: 0
- **`bun run build`**: green
- **`bun run typecheck`**: green at 149

## After merging 13.4.1

- Write `docs/plans/2026-04-??-module-system-phase-13-4-1-electron-flip-handoff.md`.
- Run parallel reviewers (Kieran TS + Architecture + Security +
  Simplicity). Apply P0/P1 pre-merge. Squash-merge.
- Queue `docs/plans/2026-04-??-next-session-prompt-phase-13-5.md`
  for **Phase 13.5 — MCP ergonomics**:
  - MCP server uses `connectToDaemon` client-side
  - `DaemonSession.release()` ref-counted semantic (Architecture P2
    from PR #18)
  - Active-daemon registry at `~/.rn-dev/registry.json`
  - Error-shape consolidation across the three client surfaces
  - Packaged-Electron `daemonEntry` (Kieran P1 + Security P2 from
    PR #18 — `resolveDaemonEntry` throws loudly under `app.isPackaged`
    today; the installer work wires this)

## Deferred follow-ups from 13.4 to fold in

Lower priority; fold whichever touch the handler-flip diff naturally:

- **Simplicity P1** — `electron/daemon-connect.ts` inline into
  `main.ts`. Revisit after the flip — once daemon-connect.ts grows
  IPC-forwarding wiring it may earn its keep; if it stays an 86-LOC
  passthrough, inline it.
- **Simplicity P1** — collapse the 5 adapters' identical
  `notifyDisconnected` bodies into an `AdapterBase` helper.
- **Simplicity P2** — narrow EventKind type aliases in
  `adapter-sink.ts`: could drop if the AdapterSink generic proves
  unused after the renderer-mirror work lands, or keep as
  compile-time safety for `routeEventToAdapters`.
- **Kieran P1** — null out `resolveRunning` / `rejectRunning` after
  settle in `session.ts` to quiet the "is this a leak?" review
  question.
- **Kieran P1-4** — beef up the disconnect-idempotency test with a
  `vi.fn()` spy on `sub.close` to assert it runs exactly once.
- **Kieran P2-1** — type `ModuleHostClient.list()`'s return (if
  `list()` gets re-added). Today the method is deleted pending a
  real caller.
- **Security P2-3** — cross-client RPC ordering test: two clients
  both firing Metro RPCs at the same time; assert `metro/reload` +
  `metro/devMenu` are re-entrant on the same instance.
- **Security P2-4** — `disconnect()` should `removeAllListeners()`
  to prevent `modules-event` forwarders from calling
  `mainWindow.webContents.send` on a destroyed window.

## Branching

```sh
git checkout main
git pull
git checkout -b feat/module-system-phase-13-4-1-electron-flip
```

Per Martin's working preference for this repo: direct feature branch
on `main`, not worktrees — avoids the duplicate install/build pain.

## Remember

- `vitest run`, not `bun test`.
- `bun run build` + `bun run typecheck` for production verification.
- Every third-party module tool wire name carries the `<moduleId>__`
  prefix.
- `config-set` audit entries record patch keys, never values.
- **One daemon = one worktree = one session.** Electron opening a
  second session against the same daemon is not supported in 13.4.1;
  multi-session is future phase work.
- `builder/build` RPCs reject projectRoot outside the daemon's
  worktree. Preserve when flipping the build handler.
- `RN_DEV_ELECTRON_DAEMON_CLIENT` env gate goes away in this phase —
  the daemon client IS the only path.

## The rest of the Phase 13 arc

- **13.5 MCP ergonomics** — MCP server uses `connectToDaemon`
  client-side; `release()` ref-counted session; active-daemon
  registry at `~/.rn-dev/registry.json`; error-shape consolidation;
  packaged-Electron daemon entry. Stretch/optional.
