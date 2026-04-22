# Module System — Phase 4 → Phase 5/6 Handoff

**Written:** 2026-04-22
**By:** Claude (Phase 4 session)
**For:** The next Claude (or human) continuing this feature

---

## What shipped in Phase 4

Electron panel contributions end-to-end. A 3p module with a
`contributes.electron.panels[]` entry now renders an embedded
`WebContentsView` inside the main `BrowserWindow`, and the panel's
`window.rnDev.<capability>.<method>(args)` call round-trips to the
daemon's `CapabilityRegistry` with permission gating applied.

Steps shipped (matches the Phase 4 plan):

| Step | Scope | Commit |
|------|-------|--------|
| 3    | Daemon-side `host/*` RPC + SDK `ctx.host.capability()` Proxy | `e28fb46` |
| 1    | `electron/panel-bridge.ts` + `panel-bridge-electron.ts`      | `6a00d5f` |
| 2    | `electron/preload-module.js` + `modules-panels` IPC + daemon exposures + main wire-up | `c402e0b` |
| 4+5  | `renderer/components/ModulePanel.tsx` + `App.tsx` dynamic view map + `modules:event` forwarding | `88bdcca` |
| 6    | `modules:host-call` audit logging                            | `ef31ecf` |

Step 3 landed first because it's the foundation — without daemon
`host/*` + the SDK Proxy, steps 1/2/4 would be wiring for a surface
that doesn't do anything.

---

## Files touched

### Step 3 — daemon `host/*` + SDK Proxy

| File | Change |
|------|--------|
| `src/core/module-host/host-rpc.ts` | **New** — `attachHostRpc(rpc, manifest, capabilities)` installs a `host/call` handler on each managed module's `ModuleRpc` before `rpc.listen()`. Error codes: `HOST_CAPABILITY_NOT_FOUND_OR_DENIED` (same code for unknown + denied so modules can't probe gated IDs), `HOST_METHOD_NOT_FOUND`, `HOST_MALFORMED_PARAMS`. |
| `src/core/module-host/__tests__/host-rpc.test.ts` | **New** — 8 unit tests. |
| `src/core/module-host/manager.ts` | `public readonly capabilities` (was private) so Electron main can resolve against the same registry; `spawnEntry` now calls `attachHostRpc` between the log-notification hook and `rpc.listen()`. |
| `src/core/module-host/__tests__/manager.integration.test.ts` | +1 test — spawns a real subprocess that calls `host.capability(id).method(args)` through the SDK Proxy; verifies granted path returns the capability's result and permission-denied path returns `{ found: false }`. |
| `packages/module-sdk/src/module-runtime.ts` | `createHostApi(connection, { log, appInfo, manifest })` builds `ctx.host`. `log` and `appInfo` are synthesized locally; other ids are permission-gated against `appInfo.capabilities` descriptors, then returned as a Proxy that dispatches `host/call` per property access. `ModuleToolContext` gains `host: HostApi`. |
| `packages/module-sdk/src/__tests__/module-runtime.test.ts` | +5 tests (log/appInfo local, unknown id → null, permission-denied → null, granted id → Proxy that calls host/call). |
| `test/fixtures/echo-module/index.js` | New `echo__probe-host` tool that calls `ctx.host.capability(id).method(...args)` — not in the manifest's contributions, fixture-only. |

### Step 1 — panel-bridge

| File | Change |
|------|--------|
| `electron/panel-bridge.ts` | **New** — pure logic. `createPanelBridge({ host, factory, getBounds, moduleRoot, auditLog? })` returns `{ register, show, hide, unregister, list, applyBounds }`. One view per `(moduleId, panelId)`, at most one attached to `window.contentView` at a time. No `electron` import. |
| `electron/panel-bridge-electron.ts` | **New** — Electron-runtime binding. `installPanelBridge({ window, preloadPath, moduleRoot, getBounds, auditLog? })` composes `createElectronBrowserHost(window)` + `createElectronPanelViewFactory(preloadPath)` with the pure bridge. Each `WebContentsView` uses `partition: "persist:mod-<id>"`, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and `additionalArguments` carrying `--rn-dev-module-id`, `--rn-dev-panel-id`, `--rn-dev-host-api=<csv>`. |
| `electron/__tests__/panel-bridge.test.ts` | **New** — 9 tests against fakes for `BrowserHost` + `PanelViewFactory`. |

### Step 2 — preload + IPC glue

| File | Change |
|------|--------|
| `electron/preload-module.js` | **New** — hand-written CommonJS (matches `preload.js` pattern — Electron preloads aren't tsx-loaded). Reads `--rn-dev-*` from `process.argv` and exposes `window.rnDev` with: `moduleId`, `panelId`, `hostApi[]` (frozen), `call(methodDotted, ...args)`, and `capabilities.<capId>.<method>(...args)` objects built from the allowlist. Every call goes through `ipcRenderer.invoke('modules:host-call', { moduleId, capabilityId, method, args })`. |
| `electron/ipc/modules-panels.ts` | **New** — pure logic: `listPanels`, `resolveHostCall` (+ audit hook), `activatePanel`, `deactivatePanel`, `setPanelBounds`, `createBoundsCache`, `ModulesPanelsIpcDeps` / `ModulesPanelsIpcHandle`. No `electron` import. |
| `electron/ipc/modules-panels-register.ts` | **New** — thin `ipcMain.handle` registrar. Split from the pure file so vitest can import helpers without executing `import { ipcMain }`. |
| `electron/__tests__/modules-panels.test.ts` | **New** — 12 tests: listPanels shape, resolveHostCall across all error codes, audit-event fanout, activatePanel registers+shows+caches bounds, activatePanel rejects unknown panels, deactivatePanel/setPanelBounds delegate. |
| `src/core/module-host/manager.ts` | `capabilities` now `public readonly` (also step 3). |
| `src/app/start-flow.ts` | `startServicesAsync` / `startServices` now return `moduleRegistry`. `registerModulesIpc` return captured; `modulesIpc.moduleEvents.on("modules-event", …)` forwards to `serviceBus.emitModuleEvent`. |
| `src/app/service-bus.ts` | New `moduleRegistry: (ModuleRegistry) => void` and `moduleEvent: (ModulesEvent) => void` topics + setters. |
| `electron/ipc/index.ts` | Subscribes to both `serviceBus.moduleHost` and `serviceBus.moduleRegistry`; once both fire, installs the panel bridge and registers the `modules:*` ipcMain channels. Also forwards `moduleEvent` to the renderer via `send('modules:event', …)`. Audit callbacks for both panel lifecycle and host-call route to the existing `service:log` channel. |

### Steps 4 + 5 — ModulePanel + dynamic view map

| File | Change |
|------|--------|
| `renderer/components/ModulePanel.tsx` | **New** — React component that measures its own `getBoundingClientRect()` and reports to main via `modules:activate-panel` on mount, `modules:set-panel-bounds` on every `ResizeObserver` tick (deduped), and `modules:deactivate-panel` on unmount. Also listens to `window.resize` for non-ResizeObserver layout shifts. |
| `renderer/App.tsx` | Drops the `ViewTab` union; `activeTab: string`. Fetches panel contributions via `invoke('modules:list-panels')` on mount and on every `modules:event` (no second subscription path — reuses the MCP `modules/subscribe` stream). `renderView()` dispatches `module:<moduleId>:<panelId>` keys into `<ModulePanel />`. Tab-cycle keyboard shortcut includes module panels. |
| `renderer/components/Sidebar.tsx` | `activeTab: string` (was `ViewTab`); new `modulePanels: SidebarModulePanel[]` prop renders under an `EXTENSIONS` section. |
| `renderer/components/StatusBar.tsx` | Same string widening; `labelFor()` unpacks module-panel titles from the key format. |

### Step 6 — host-call audit

| File | Change |
|------|--------|
| `electron/ipc/modules-panels.ts` | `resolveHostCall` accepts an optional `audit` callback and fires it exactly once per invocation with `{ moduleId, capabilityId, method, outcome }`. |
| `electron/__tests__/modules-panels.test.ts` | +1 test for `ok` and `denied` outcomes. |
| `electron/ipc/index.ts` | `auditHostCall` sink emits `[host-call] <id>/<cap>.<method> <outcome>` to `service:log`. |

---

## Verification

- **vitest:** 604 passed / 18 pre-existing unrelated failures.
  - +35 tests since start of Phase 4 (8 host-rpc, 5 sdk proxy, 1 manager integration, 9 panel-bridge, 12 modules-panels — 1 duplicate in the tally).
- **tsc (root):** 154 errors. Unchanged baseline.
- **tsc (renderer):** 1 pre-existing error (`InstanceLogs.sections` missing on line 95). Present on `main@185802e`.
- **bun run build:** green.
- **Manual GUI smoke:** **Not run this session.** Requires a real 3p
  module with `contributes.electron.panels[]` to exercise end-to-end.
  See "Next-up validation" below.

---

## Permanent contract decisions made in Phase 4

- **`ModuleHostManager.capabilities` is public readonly.** Electron
  main resolves against the same registry the subprocesses see via
  `host/call` — single source of truth for permission gating.
- **Daemon and SDK use the SAME error code for unknown-capability and
  permission-denied:** `HOST_CAPABILITY_NOT_FOUND_OR_DENIED`. Modules
  can't probe the registry for gated IDs by catching different errors.
- **SDK `host.capability<T>(id)` is a two-layer gate:**
  (1) local pre-check against `appInfo.capabilities` + manifest.permissions
  (returns `null` synchronously — matches the `T | null` contract);
  (2) daemon-side `attachHostRpc` re-enforces. A module that bypasses
  the SDK still gets rejected.
- **`log` and `appInfo` are synthesized locally in the SDK Proxy.** No
  RPC round-trip. Future host-authored capabilities named `log` or
  `appInfo` would be shadowed — reserved v1 built-in ids per
  `host-rpc.ts` docstring.
- **Panel bridge attaches AT MOST ONE `WebContentsView` to
  `window.contentView` at a time.** Switching panels removes the
  previous view first. Cross-module DOM delivery is structurally
  impossible.
- **Every panel event is audit-logged:** `register`, `show`, `hide`,
  `unregister`, `destroy-all` (panel lifecycle) plus `host-call`
  outcomes. Both route to `service:log` via the Electron IPC sink.
  An HMAC-chained sink (per the plan's `AuditLog.append()`) will
  replace the log-channel pass-through in a follow-up.
- **`modules:host-call` is Electron-only.** It's an `ipcMain.handle`
  channel inside the Electron main process — the daemon lives in the
  same process, so there's no socket hop. MCP clients continue to use
  `modules/call` for tool proxying; they don't need `host-call`.
- **Panel preload is JavaScript, not TypeScript.** Electron preloads
  aren't loaded through the tsx hook that the main process uses, so
  they must be plain JS. Matches the existing `preload.js` pattern.
- **One subscription path for module events.** Renderer listens to
  `modules:event` IPC pushes; main forwards from `serviceBus.moduleEvent`;
  bus receives from `registerModulesIpc`'s `moduleEvents` EventEmitter;
  MCP server reads the same events via `modules/subscribe` IPC. No
  second subscription mechanism.

---

## Where the module system stands (end of Phase 4)

Branch `feat/module-system-phase-4` sits on `main@6718346` (the
squashed PR #2 → Phases 0–3d). This branch adds Phases 0…3d's Electron
payload:

- **Phase 3 (subprocess):** `host.capability<T>(id)` is no longer
  type-only — it actually does something via `host/call` RPC.
- **Phase 4 (panel):** 3p modules contributing
  `contributes.electron.panels[]` get real `WebContentsView`s attached
  to the GUI; their preload can call `rnDev.<cap>.<method>(args)` and
  hit the same capability registry the subprocess uses.

Renderer sidebar re-renders on every `modules:event` — install a
module in a running session and it appears without a reload.

**Test totals:** 604 passed / 18 pre-existing unrelated failures. tsc:
154 (unchanged). `bun run build`: green.

---

## What's still deferred (Phase 4 → Phase 5+ gap)

From the Phase 4 plan's "Do NOT do" list, these items intentionally
stayed out of scope:

1. **Marketplace / install flow / `@npmcli/arborist`.** Phase 6.
2. **Device Control module implementation.** Phase 7+.
3. **Module signing (`manifest.signature`).** V2.
4. **Sandbox enforcement (`manifest.sandbox`).** V2.
5. **Progress-token streaming on cold-start.** Still low priority.
6. **Per-activation-event routing (`onMcpTool:<pattern>`).** Still low
   priority.

New Phase-4-specific follow-ups flagged by this session:

7. **HMAC-chained audit sink.** Panel-bridge + host-call events
   currently route to `service:log`. When `~/.rn-dev/audit.log` +
   `AuditLog.append()` land per the Revision Log, swap the sink.
8. **Manual GUI smoke.** A real 3p module (e.g. the scaffolded
   `@rn-dev-modules/device-control` once it gains a panel) needs to
   mount end-to-end to validate:
   - `WebContentsView` actually appears at the right bounds.
   - Resize + window drag reapply bounds correctly.
   - Preload's `window.rnDev.capabilities.<cap>.<method>(…)` reaches
     the daemon.
   - Audit log entries appear in the service-log output.
9. **Renderer test harness.** `ModulePanel.tsx`, updated `App.tsx`,
   and `Sidebar.tsx` have no tests (the repo has no renderer test
   setup yet). Consider `@testing-library/react` + vitest env
   `jsdom` for next session.
10. **Pre-existing renderer tsc error** (`sections` missing on line
    95 of App.tsx) predates Phase 4 but should be cleaned up alongside
    the next renderer change.

---

## What's next — Phase 5 or Phase 6

The plan's Phase 5 is **per-module config** (`contributes.config.schema`
+ host storage). Phase 6 is the **marketplace + install flow**
(registry JSON, SHA pin, `@npmcli/arborist --ignore-scripts`, consent
dialog).

Martin's call which ships first. Arguments:

- **Phase 6 first (marketplace):** unblocks the "install a 3p module
  from a curated list" story which is what every new user wants to
  try. Needs the host registry JSON + consent UI.
- **Phase 5 first (config):** smaller scope; lets the device-control
  module persist state (target emulator id, ADB path) without hacks.
  Could land in 1–2 days.

Recommendation: **Phase 5 first**. It's a clean small chunk that
doesn't require the Marketplace UI; the consent + install flow is a
larger design conversation. Phase 6 can follow once a real module
(device-control) exists to actually install.

### Branching

PR #2 closed. Branch here is `feat/module-system-phase-4`. Five
commits on top of `main@6718346`. Before Phase 5 / 6, ask Martin:

> **"Phase 4 done — open PR from `feat/module-system-phase-4` and
> start Phase 5 fresh off main, or keep stacking?"**

Five commits is more reviewable than 23. Squash-merging per-phase
keeps future diffs small.

---

## Environment notes

- Node ≥18; Bun for install + build + dev; vitest for tests.
- `WebContentsView` requires Electron ≥30. Repo is at `35.7.5`. ✓
- `electron/preload-module.js` is a hand-written CJS file — NOT
  `preload-module.ts`. If you rename, update
  `electron/ipc/index.ts:registerModulePanelsHandlers` too (the
  `preloadPath` it constructs).
- `tsx/cjs` loads `electron/main.ts` at runtime via
  `electron/launcher.cjs`; the main process doesn't need a build
  step. All Phase 4 `.ts` files under `electron/` inherit this.
- SDK build is still automatic via `vitest.global-setup.ts`.

---

## Useful commands

```bash
# Run just the Phase 4 tests
npx vitest run electron/__tests__/ src/core/module-host/__tests__/host-rpc.test.ts packages/module-sdk/src/__tests__/module-runtime.test.ts

# Full suite
npx vitest run

# Type check (baseline 154)
npx tsc --noEmit | grep -c "error TS"

# Production build
bun run build

# GUI (for manual smoke)
bun run dev:gui
```
