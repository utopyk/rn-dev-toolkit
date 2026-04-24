# Phase 13.4.1 handoff — Electron flip completion

**Merged:** 2026-04-24 via [PR #20](https://github.com/utopyk/rn-dev-cli/pull/20)

Closes the Phase 13 daemon refactor for the Electron host. Every
ipcMain handler now resolves runtime services through the daemon
client; the in-process `ModuleHostManager` / `ModuleRegistry` / Metro
/ Builder / Watcher are gone. Electron is a pure client.

## What landed

- **Three new daemon RPCs** — `modules/host-call`, `modules/list-panels`,
  `modules/resolve-panel`. Wired into `registerModulesIpc`; dispatcher
  entries in `src/app/modules-ipc.ts`. Pre-session guard in
  `src/daemon/index.ts::handleMessage` returns `E_SESSION_NOT_RUNNING`
  for modules actions that arrive before session/start.
- **`ModuleHostClient` gained 11 RPC methods** + a `subscribeToEvents()`
  stream subscription that opens `modules/subscribe` against the daemon
  and re-emits the full 9 `ModulesEvent.kind`s on the adapter's local
  `modules-event` topic.
- **Every Electron ipcMain handler flipped** — metro, tools,
  modules-config, modules-install-register, modules-panels-register
  all route through `serviceBus.modulesClient` / other adapter topics.
- **`RN_DEV_ELECTRON_DAEMON_CLIENT` env gate deleted.** The daemon-
  client path is the only path now.
- **`electron/module-system-bootstrap.ts` deleted** (no callers after
  the flip).
- **`electron/ipc/services.ts` collapsed 514 → 246 LOC.** The two
  interactive prompts (package-manager conflict, code-signing) stay
  Electron-side; everything else now lives in the daemon's
  `bootSessionServices`.
- **Merge-gate integration test #6** — `electron/__tests__/panel-bridge-daemon.test.ts`
  pins the wire contract for the three new RPCs. Four assertions,
  all green against `spawnTestDaemon` + `fakeBootSessionServices`.

## Baselines post-merge

- `vitest run`: **936/0** (914 pre-Phase-13.4 + 9 from the neumorphic UI
  PR + 13 new unit tests for `modules/host-call|list-panels|resolve-panel`
  + 11 new `ModuleHostClient` RPC-method unit tests + 6 reshaped
  `modules-config` + 6 reshaped `modules-panels` + 1 new
  `daemon-connect` + 4 new `panel-bridge-daemon` − 5 deleted
  `module-system-bootstrap` − 14 deleted `resolveHostCall`/`resolveCallTool`/`listPanels`
  whose coverage moved daemon-side in `src/app/__tests__/modules-ipc.test.ts`
  − 2 deleted `listPanels`).
- `tsc` root: **149** (unchanged — pre-existing wizard errors).
- `tsc` electron: **0**.
- `bun run build`: green.

## 4-reviewer round — what landed pre-merge

### P0s

1. **Kieran P0-1** — `modules:event` IPC stream broken. The pre-flip
   `serviceBus.on('moduleEventsBus', ...)` forwarder had no publisher
   post-bootstrap deletion; Settings + Marketplace regressed to empty
   state. **This was the "Settings tab crashes" bug Martin reported
   mid-review.** Rewired to subscribe to `ModuleHostClient.on('modules-event', ...)`.
2. **Kieran P0-2** — 6 of the 9 `ModulesEvent.kind`s (install,
   uninstall, enabled, disabled, restarted, config-changed) never
   reached the renderer because they fan out on a daemon-local bus
   consumed only via `modules/subscribe`. Added
   `ModuleHostClient.subscribeToEvents()` that opens the stream.
3. **Arch P0** — stale `modulesClient` after daemon disconnect.
   Added `serviceBus.clearModulesClient()` + invalidation in
   `main.ts::wireDaemonDisconnectListener` + null-handling in all
   three registrars.
4. **Simplicity P0** — dropped four orphaned serviceBus topics
   (`moduleHost` / `moduleRegistry` / `moduleEventsBus` / `hostVersion`)
   with no remaining publishers. `-40 LOC`.

### P1s

- **Sec P1-1** — `moduleRoots` cache invalidation wired on uninstall /
  crashed / failed events + on daemon disconnect.
- **Sec P1-2** — duplicate audit entries per host-call. Dropped the
  Electron-side `auditLog.append({kind:'host-call'})` branch; the
  daemon's `getDefaultAuditLog()` in `src/app/modules-ipc.ts::hostCall`
  is now the single writer.
- **Kieran P1-3** — `FakeModuleHostSurface` in `src/daemon/fake-boot.ts`
  was a 3-method fake cast to a 15-method manager; widened to include
  stubs the dispatcher calls at request time, plus a real
  `CapabilityRegistry` field.
- **Kieran P1-4 partial** — runtime narrowing on `hostCall` +
  `resolvePanel` replies (the two genuinely-new RPCs). The other 9
  RPC methods keep `as`-casts — pre-flip consumers (CLI, TUI) already
  handle the legacy error envelopes.
- **Arch P1** — `instances:create` now returns `ok: false` + a
  `MULTI_INSTANCE_NOT_SUPPORTED` code so the wizard treats it as a
  failure.
- **Arch P1** — dead-code cleanup in `instances:remove` (dropped the
  `instance.devtools.dispose()` + `instance.metro.stop()` branches
  that gated on always-null refs).
- **Simplicity P1** — `ResolvedPanelContribution` → SDK type alias.
- **Simplicity P2** — dropped `void profile;` YAGNI comment-out from
  `settleCodeSigning`.

## Reviewer tensions — resolved in commit message

1. **Kieran P0-2 (more events) vs Sec P1-4 (widened attack surface):**
   Different layers. Both stand; Sec P1-4 deferred to Phase 13.5
   (daemon-side sender-binding check for `modules/host-call`).
2. **Kieran P1-4 (narrow every RPC) vs Simplicity P2 (no
   pre-abstraction):** Took the middle — narrowed the two NEW RPCs
   where no legacy consumer validates shape; left 9 pre-flip RPCs
   using `as`-casts since their existing consumers handle legacy
   error envelopes.
3. **Kieran P0-1 (wire modules-event) vs Simplicity P0 (delete
   moduleEventsBus):** Simplicity wanted to delete; Kieran pointed
   out the forwarder had a consumer. Took Kieran — rewired consumer
   to `modulesClient`'s emitter. The other three dead topics got
   dropped per Simplicity.

## Deferred to Phase 13.5

Explicit tracker list for the next phase — don't drop these.

### From this session

1. **Sec P1-4 — daemon-side sender binding for `modules/host-call`.**
   Today the dispatcher in `src/app/modules-ipc.ts::hostCall` has no
   sender check; any same-UID client (TUI, MCP, second Electron
   window) can call host-call with an arbitrary `moduleId` and
   exercise that module's full granted-capability surface. Panel-
   sender-registry gate is Electron-side only. v1 trust boundary is
   socket-permission-only per CLAUDE.md, but the widened threat
   model deserves daemon-side enforcement before Phase 13.5 multi-
   client work (MCP uses `connectToDaemon`).
2. **Sec P1-3 — audit outcome granularity.** `AuditOutcome` collapses
   to `ok | error | denied`; the granular `unavailable` /
   `method-not-found` / etc. that Electron used to surface got lost
   in the daemon-side move. Either widen `AuditOutcome` or add a
   discriminator field.
3. **Arch P1 — packaged Electron daemon entry.** `resolveDaemonEntry`
   still throws under `app.isPackaged`. Phase 13.5 installer work
   wires this. Kieran P1 + Security P2 from PR #18 flagged this
   originally.
4. **Ref-counted `DaemonSession.release()`** — multi-session story.
   `instances:create` currently returns a loud "not supported" error;
   the wizard can't actually bring up a second profile's services
   without an app restart. 13.5 ref-counted release enables this.
5. **`instance:retryStep` through daemon RPCs** — the handler stubs
   out today. 13.5 can add a daemon-side `session/retryStep` action
   or model individual step retries via the existing adapters.
6. **Re-introduce `instance:section:start|end` events** if the daemon
   grows `session/log`-style progress events the renderer can
   transform into section UX.
7. **Kieran P1-4 full** — narrow the other 9 RPC method replies on
   `ModuleHostClient`. Only critical when Phase 13.5 starts running
   Electron against a differently-versioned daemon.
8. **Panel-subprocess-survives-Electron-drop assertion** for the merge
   gate. Needs a fake 3p module fixture that registers a panel + a
   host capability. Daemon-side panel-bridge (new Phase 13.5 surface)
   makes this testable end-to-end.

### From prior phases (still open)

- Simplicity P1 from PR #18 — collapse the 5 adapters' identical
  `notifyDisconnected` bodies into an `AdapterBase` helper. Revisit
  after the 13.5 ref-counted session work.
- Simplicity P1 from PR #18 — `electron/daemon-connect.ts` inline
  into `main.ts`. Now that the flip is done + 13.5's installer work
  is next, the file might grow packaged-Electron wiring that earns
  its keep. Re-evaluate after 13.5 lands.
- Kieran P1 from PR #18 — null out `resolveRunning` / `rejectRunning`
  after settle in `src/app/client/session.ts` to quiet the "is this
  a leak?" review question.
- Kieran P1-4 from PR #18 — beef up the disconnect-idempotency test
  with a `vi.fn()` spy on `sub.close` to assert exactly-once.
- Sec P2-3 from PR #18 — cross-client RPC ordering test: two clients
  both firing Metro RPCs at the same time; assert `metro/reload` +
  `metro/devMenu` are re-entrant.
- Sec P2-4 from PR #18 — `disconnect()` should `removeAllListeners()`
  to prevent `modules-event` forwarders from calling
  `mainWindow.webContents.send` on a destroyed window.

## The rest of the Phase 13 arc

- **13.5 MCP ergonomics + installer.** MCP server uses `connectToDaemon`
  client-side; `release()` ref-counted session; active-daemon registry
  at `~/.rn-dev/registry.json`; packaged-Electron daemon entry; daemon-
  side `modules/host-call` sender binding; `AuditOutcome` widening.
  The big Phase 13 finale.

## Known runtime limitations (from this phase)

These will hit users; document so support tickets aren't surprises.

- **Multi-instance flow:** creating a second profile through the
  wizard creates the renderer record but doesn't attach services.
  Users need to restart the app. `instances:create` returns
  `MULTI_INSTANCE_NOT_SUPPORTED`.
- **Step retry:** `instance:retryStep` always returns "not wired to
  the daemon yet — restart the app to re-run the full boot sequence."
- **Section UX:** `instance:section:start|end` events no longer fire.
  The renderer gracefully degrades to flat log output.
- **Packaged builds:** `resolveDaemonEntry` throws under
  `app.isPackaged` — dev mode only until Phase 13.5.

## Commits (squash-merged)

1. `test(electron)`: failing merge-gate test for Phase 13.4.1 daemon RPCs (ee4358e)
2. `feat(daemon)`: `modules/host-call` + `list-panels` + `resolve-panel` + fake-boot wiring + handleMessage fall-through skip (458bcae)
3. `feat(client)`: ModuleHostClient RPC methods + 11 unit tests (2846c2b)
4. `refactor(electron)`: flip metro.ts + tools.ts to adapters (6148f8c)
5. `refactor(electron)`: flip modules-config + install + panels handlers to daemon RPCs (c836706)
6. `refactor(electron)`: delete env gate + bootstrap, collapse services.ts (d46fbb7)
7. `fix(electron)`: apply 4-reviewer round P0/P1 findings (f52526d)
