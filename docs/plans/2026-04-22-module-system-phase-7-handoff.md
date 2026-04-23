# Module System — Phase 7 → Phase 8 Handoff

**Written:** 2026-04-22
**By:** Claude (Phase 7 session)
**For:** The next Claude (or human) continuing this feature

---

## What shipped in Phase 7

Five coherent units bundled into one PR:

1. **First real 3p module — `@rn-dev-modules/device-control`.** New workspace
   package at `modules/device-control/`. Manifest declares 9 MCP tools
   (`device-control__{list,screenshot,tap,swipe,type,launch-app,logs-tail,install-apk,uninstall-app}`)
   and an Electron panel (`panel/index.html`). Install/uninstall-app
   ship with `destructiveHint: true`. Platform adapters: Android via
   direct `adb` shelling (subset of the appium-adb surface); iOS via
   `xcrun simctl`. Subprocess entry uses the SDK's `runModule()`.
2. **Registry population — `docs/fixtures/`.** Local `modules.json` +
   packed tarball as a stand-in for the `rn-dev-modules-registry` repo
   that doesn't exist yet. `RN_DEV_MODULES_REGISTRY_URL=file://…`
   points the host at it. Smoke-test workflow documented in the
   fixture README.
3. **CLI parity — `rn-dev module {install,uninstall,list,enable,disable,restart}`.**
   Install/uninstall work standalone (calls `installModule` /
   `uninstallModule` directly); list/enable/disable/restart require a
   running daemon and dispatch over the unix-socket `IpcClient`.
   Install/uninstall best-effort notify a running daemon afterwards.
4. **MCP `tools/listChanged` event widening.** `ModulesEvent.kind` now
   includes `install` and `uninstall` (distinct from the existing
   `enabled` / `disabled` kinds, which fire on the disabled-flag
   toggle). `installAction` / `uninstallAction` emit them;
   `subscribeToModuleChanges` still fires
   `notifications/tools/list_changed` on any `modules-event` — the
   forwarder already covered the install path by
   union-widening + refactor.
5. **Review follow-ups parked from Phase 6** — two of the P2 items from
   PR #5 that felt worth bundling:
   - **Kieran P2-3** — extract `ModuleRegistry.loadSingleManifest(path, opts)`
     helper. Installer no longer uses a scratch registry +
     `loadUserGlobalModules` round-trip, so a broken sibling manifest
     can't poison an unrelated install.
   - **Kieran P2-4** — replace `window.confirm` on uninstall with a
     styled `UninstallConfirmDialog` mirroring the Phase 6 consent
     dialog.

Plus a new Electron IPC surface — `modules:call-tool` — so a module's
panel can invoke its own subprocess tools without a new dedicated IPC
per module. Scoped by `PanelSenderRegistry.resolve()` so only sandboxed
panels can use it; the moduleId comes from the sender identity, not
the renderer.

---

## Scope that shipped

| Concern | Shipped |
|---------|---------|
| `@rn-dev-modules/device-control` package | ✅ `modules/device-control/` — manifest, runtime entry, Android + iOS adapters, panel HTML/JS, 3 test files covering parsers + dispatch |
| `modules.json` fixture + tarball | ✅ `docs/fixtures/modules.json` + `device-control-0.1.0.tgz` + README with smoke flow |
| CLI `rn-dev module …` | ✅ `src/cli/module-commands.ts` — 6 sub-commands, `src/cli/__tests__/module-commands.test.ts` for wiring |
| `install` / `uninstall` event kinds | ✅ widened `ModulesEvent.kind`, updated `installAction` / `uninstallAction`, `src/app/__tests__/modules-install-event.test.ts` covers emission |
| Kieran P2-3 — `loadSingleManifest` | ✅ static method on `ModuleRegistry`; `src/modules/__tests__/load-single-manifest.test.ts` with 6 tests |
| Kieran P2-4 — styled uninstall modal | ✅ `renderer/components/UninstallConfirmDialog.{tsx,css}`, Marketplace wired |
| `modules:call-tool` IPC | ✅ `electron/ipc/modules-panels.ts:resolveCallTool` + handler + `rnDev.callTool` in `preload-module.js` |

---

## Files touched

### New

| File | Purpose |
|------|---------|
| `modules/device-control/rn-dev-module.json` | Manifest — 9 MCP tools + 1 Electron panel + permissions |
| `modules/device-control/package.json` | Package declaration (already existed; narrowed `files`) |
| `modules/device-control/build.ts` | Bun bundler entry; mirrors `packages/module-sdk/build.ts` |
| `modules/device-control/tsconfig.json` | Strict TS + NodeNext + colocated tests excluded |
| `modules/device-control/src/exec.ts` | `execBinary()` — shell-free, timeout, oversize cap, distinct error kinds |
| `modules/device-control/src/adapter.ts` | `DeviceAdapter` interface + shared types |
| `modules/device-control/src/android-adapter.ts` | `adb` wrapper + `parseDevices` for `adb devices -l` |
| `modules/device-control/src/ios-adapter.ts` | `xcrun simctl` wrapper + JSON parser for `simctl list -j` |
| `modules/device-control/src/tools.ts` | Pure tool dispatchers, adapter lookup by platform |
| `modules/device-control/src/index.ts` | Subprocess entry — `runModule()` binding |
| `modules/device-control/src/__tests__/android-adapter.test.ts` | 8 tests — parser + tap/swipe/type/launchApp/logsTail argv |
| `modules/device-control/src/__tests__/ios-adapter.test.ts` | 7 tests — simctl parser + adapter shells |
| `modules/device-control/src/__tests__/tools.test.ts` | 11 tests — dispatch + platform branching + error cases |
| `modules/device-control/panel/index.html` | Device list UI + screenshot preview |
| `modules/device-control/panel/panel.js` | Calls `rnDev.callTool("list" | "screenshot", …)` |
| `docs/fixtures/modules.json` | Phase 7 registry — one entry for `device-control` |
| `docs/fixtures/device-control-0.1.0.tgz` | Packed tarball; SHA-256 pinned in the fixture |
| `docs/fixtures/README.md` | Smoke-test flow + note on tarball-SHA drift per build |
| `renderer/components/UninstallConfirmDialog.tsx` | Styled replacement for `window.confirm` |
| `renderer/components/UninstallConfirmDialog.css` | Matches ConsentDialog polish |
| `src/cli/module-commands.ts` | `registerModuleCommands(program)` — 6 sub-commands + helpers |
| `src/cli/__tests__/module-commands.test.ts` | 4 tests — wiring, flags, positional args |
| `src/app/__tests__/modules-install-event.test.ts` | 5 tests — install/uninstall emit, type-level kind union |
| `src/modules/__tests__/load-single-manifest.test.ts` | 7 tests — happy/error paths for the new helper |
| `docs/plans/2026-04-22-module-system-phase-7-handoff.md` | This document |

### Modified

| File | Change |
|------|--------|
| `src/modules/registry.ts` | `loadManifestFile` → static `loadSingleManifest`; `loadUserGlobalModules` calls through it |
| `src/modules/marketplace/installer.ts` | Uses `loadSingleManifest` directly; no more scratch-registry trick |
| `src/app/modules-ipc.ts` | `ModulesEvent.kind` union +=`"install" \| "uninstall"`; `installAction`/`uninstallAction` emit new kinds; `callModuleTool` exported |
| `electron/ipc/modules-panels.ts` | `CallToolPayload` / `CallToolReply` types + `resolveCallTool` pure helper |
| `electron/ipc/modules-panels-register.ts` | `modules:call-tool` ipcMain handler — sender-bound moduleId, panel-only |
| `electron/preload-module.js` | `rnDev.callTool(tool, args?)` exposed on the per-module preload surface |
| `renderer/views/Marketplace.tsx` | Uses `UninstallConfirmDialog` instead of `confirm()`; state for `uninstallTarget` |
| `src/cli/commands.ts` | Imports + calls `registerModuleCommands(program)` |
| `modules/device-control/src/index.ts` | Stub replaced with the real subprocess entry |
| `modules/device-control/package.json` | `files` narrowed to `dist/`, `panel/`, `rn-dev-module.json` |

---

## Verification

- **vitest:** 779 passed / 0 failed (+43 since PR #5; mostly device-control + new helper tests).
- **tsc (root):** 150 — baseline drift (was 149 at Phase 6 close, ±1 is noise from line-number shifts in pre-existing errors). **0 new errors** introduced by Phase 7 (diffed against main).
- **tsc (renderer):** 1 — down from the 3 baseline. `App.tsx(100,50)` remains — pre-existing `InstanceLogs.sections` mismatch.
- **bun run build:** green.
- **Manual smoke flow:** documented in `docs/fixtures/README.md`. Requires `bun run dev:gui` + file:// registry URL + walk Marketplace install flow. Not executable in CI without a real Electron runtime — same posture as Phase 6.

---

## Permanent contract decisions locked in Phase 7

- **`install` / `uninstall` are distinct event kinds** from `enabled` /
  `disabled` on `ModulesEvent.kind`. Subscribers that only care about
  tool-list invalidation can keep treating any kind as a refresh
  signal (`subscribeToModuleChanges` does). UI surfaces that need to
  distinguish "newly landed" from "toggled on" can branch cleanly.
- **`modules:call-tool` is the surface a module's panel uses to call
  its own subprocess tools.** The payload is `{ tool, args }` — the
  moduleId is derived from the `PanelSenderRegistry` identity, not
  the renderer. Host UI senders are rejected with `MODULE_UNAVAILABLE`;
  cross-module tool invocation stays on `modules:host-call` +
  capability registration.
- **`rnDev.callTool(tool, args?)` is the preload ergonomic.** Panels do
  not need to know their own moduleId to call a tool — the main
  process fills it in. `rnDev.capabilities.<id>.<method>()` remains
  the cross-module RPC path.
- **`ModuleRegistry.loadSingleManifest` is the single-manifest
  validation pipeline.** Installer + scanner share it. Static because
  state doesn't flow through the registry for a one-shot validation.
- **Installer rejects sibling-manifest failures no longer contaminate
  an unrelated install.** Scratch-registry + loadUserGlobalModules
  trick replaced with a direct `loadSingleManifest` call on the
  freshly-extracted manifest.
- **Device-control manifest is the reference 3p manifest.** Tool names
  follow the `<moduleId>__<tool>` policy; destructive tools carry
  `destructiveHint: true`; permissions are declared advisories
  (`exec:adb`, `exec:simctl`, `network:outbound`).
- **Tarball SHAs in `modules.json` are fixtures-scoped for v1.** The
  bun bundler embeds absolute source paths in sourcemaps → SHAs drift
  per checkout. Production (published npm) tarballs SHA-pin once per
  release. The fixture README documents the re-pack cadence.

---

## Deferred items (Phase 7 → Phase 8 and beyond)

1. **Populate the real curated registry.** `rn-dev-modules-registry` repo
   still doesn't exist. The file:// fixture unblocks local smoke
   testing. Publishing `@rn-dev-modules/device-control` to npm + setting
   up the remote registry is a separate ops task.
2. **Bake `EXPECTED_MODULES_JSON_SHA256`.** Still empty → dev-mode
   warning on every registry fetch. The moment a published registry
   exists, bake its SHA into `src/modules/marketplace/registry.ts`
   as part of the first host release that ships it.
3. **`modules/rescan` IPC action.** CLI install today prints
   "daemon is running — restart it to pick up the new module". Phase 8
   should add `modules/rescan` so a daemon re-walks
   `~/.rn-dev/modules/` + publishes the new entries without a restart.
4. **Physical iOS device support.** The v0.1.0 `IosAdapter` only covers
   simulators — `tap`/`swipe`/`type` throw "not implemented" because
   `simctl` has no input primitives. `idb` integration is the Phase 8
   path.
5. **adbkit framebuffer streaming.** Current screenshot is
   exec-out `screencap -p` per-call. Real-time framebuffer stream
   (for live mirror preview in the panel) needs `adbkit`. Deferred —
   device-control v0.2.
6. **Arch P1-2 — `registerWithLazyDeps` abstraction.** Phase 7 added
   the `modules:call-tool` handler inside the existing
   `modules-panels-register.ts`, so the 4th-registrar threshold
   didn't fire. Revisit when Phase 8's DevTools Network extension
   adds a 4th standalone registrar.
7. **Kieran P2-1 — wider MCP reply error-code unions.** Most reply
   types are already unions (`InstallReply`, `UninstallReply`,
   `ModuleCallError`). A repo-wide scan for `{ code: string }` would
   catch the stragglers — low-cost follow-up.
8. **Simplicity P1 #1 — `RegistryFetcher` class → function.** Still
   deferred; judgment call. `RegistryFetcher` has no instance state
   today but keeps a stable shape for test stubbing.
9. **`keepData` retention + GC sweep.** Per-module `<id>/data/` dir
   preservation + 30-day TTL + startup sweep. Still Phase 8+.
10. **HMAC-chained `AuditLog.append()`.** `service:log` is still the
    audit sink for install/uninstall/config-set. Swap all at once
    when the audit log lands.
11. **Detached `modules.json` Ed25519 signature verification.** V1.1
    path; schema reserves the field.

---

## Where the module system stands (end of Phase 7)

- **Phase 0–3d** (squashed PR #2): foundation.
- **Phase 4 + 5a + 5b** (squashed PR #3): Electron panels, per-module
  config, built-in manifest-ification + Marketplace stub.
- **Phase 5c** (squashed PR #4): review follow-ups + Electron bootstrap
  + renderer panels + Settings migration + Quick Mode.
- **Phase 6** (squashed PR #5): Marketplace install/uninstall + consent
  UX + curated registry + host-read/write split + Arch P1-1 factory +
  Kieran P1-3 generic.
- **Phase 7** (this PR): Device Control v0.1 + registry fixture + CLI
  parity + install/uninstall event kinds + `modules:call-tool` + Kieran
  P2-3/P2-4.

**Test totals:** 779 passed / 0 failed. tsc root: 150 (0 new). tsc
renderer: 1. `bun run build`: green.

---

## What's next

Ask Martin:

> **"Phase 7 done. Next is either Phase 8 (DevTools Network extension
> as the second 3p module + HMAC audit log + `modules/rescan`), the
> option-(b) sidebar schema extension (per-module renderer-native vs.
> sandboxed panels), or publishing `@rn-dev-modules/device-control` to
> npm + baking a real `EXPECTED_MODULES_JSON_SHA256`?"**

Phase 8 natural sequence:
- `modules/rescan` IPC action so CLI-installed modules light up without
  a daemon restart.
- `AuditLog` HMAC-chained + retire every `service:log` audit sink in
  one pass.
- DevTools Network extracted into `@rn-dev-modules/devtools-network`
  (first built-in-to-3p migration — proves the packaging pipeline).
- Physical iOS device support via `idb` — closes the simctl "not
  implemented" gap.

If Martin wants polish before Phase 8:
- Publish `@rn-dev-modules/device-control` v0.1.0 to npm + bake the
  published tarball's SHA. Moves the fixture out of `docs/fixtures/`.
- `modules/rescan` standalone PR so CLI install UX is seamless.
- Arch P1-2 `registerWithLazyDeps` once a 4th registrar materializes.

---

## Useful commands

```bash
# Phase 7-specific tests
npx vitest run \
  modules/device-control/src/__tests__/ \
  src/cli/__tests__/module-commands.test.ts \
  src/app/__tests__/modules-install-event.test.ts \
  src/modules/__tests__/load-single-manifest.test.ts

# Full suite — expect 779 / 0
npx vitest run

# Type check — baselines 150 root / 1 renderer
npx tsc --noEmit | grep -c "error TS"
(cd renderer && npx tsc --noEmit | grep -c "error TS")

# Production build
bun run build

# Smoke — walk the real install flow end-to-end.
bun run packages/module-sdk/build.ts
bun run modules/device-control/build.ts
(cd modules/device-control && bun pm pack)
mv modules/device-control/rn-dev-modules-device-control-0.1.0.tgz \
   docs/fixtures/device-control-0.1.0.tgz
SHA=$(shasum -a 256 docs/fixtures/device-control-0.1.0.tgz | awk '{print $1}')
# Paste $SHA into docs/fixtures/modules.json#modules[0].tarballSha256
RN_DEV_MODULES_REGISTRY_URL="file://$PWD/docs/fixtures/modules.json" \
  bun run dev:gui
# Marketplace → Available to install → Install device-control → walk consent
rn-dev module uninstall device-control
# ↳ confirms teardown path + should fire tools/listChanged on any active MCP session
```
