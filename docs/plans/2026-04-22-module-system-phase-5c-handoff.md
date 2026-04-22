# Module System — Phase 5c → Phase 6 Handoff

**Written:** 2026-04-22
**By:** Claude (Phase 5c session)
**For:** The next Claude (or human) continuing this feature

---

## What shipped in Phase 5c

Three coherent units in one PR:

1. **Seven review follow-ups** that PR #3 parked:
   - Arch #1 — unified the two `ModuleRegistry` instances in `start-flow.ts`.
   - Arch #3 — `MarketplaceModuleEntry = Pick<RegisteredModuleRow, ...>`; both surfaces project via `rowFor`.
   - Arch #4 — added `kind` to `RegisteredModuleRow`, branched `rowFor` on `kind`, deleted the `isBuiltInModulePath` predicate.
   - Security F3 — per-module `config-set` serialization lock (`Map<moduleId:scope, Promise<unknown>>`).
   - Security F5 — explicit channel allowlist in `electron/preload.js`; no more generic `invoke(channel, ...args)`.
   - Security F6 — reserved `log` / `appInfo` capability ids in `CapabilityRegistry`.
   - Simplicity #6 — dropped the `serviceBus.moduleEvent` relay; subscribers attach to the shared `moduleEvents` bus directly.
2. **Electron-side module-system bootstrap.** `electron/ipc/services.ts` now calls `bootstrapElectronModuleSystem` during `startRealServices` so the Electron-mode `modules:list-panels` / `modules:config-*` / `modules:list` handlers have live deps. Before this, they returned `{ modules: [] }` / `E_CONFIG_SERVICES_PENDING` — Phase 5c's renderer work would have been non-functional otherwise.
3. **Renderer Phase 5c.**
   - `renderer/components/ModuleConfigForm.tsx` — generic JSON-Schema-driven form. Drives any module that declares `contributes.config.schema`.
   - `renderer/views/Settings.tsx` — kept the theme picker grid on top; added a `<ModuleConfigForm />` below for the `settings` module's declared schema. Theme changes persist through `modules:config-set`.
   - `renderer/views/Marketplace.tsx` + `modules:list` IPC channel — rows show id / version / kind / scope / state with a "system, uninstallable" badge on built-ins.
   - `Sidebar.tsx` + `App.tsx` — option (a) from the 5c prompt. Hardcoded sidebar dispatch stays; manifests are metadata-only. Marketplace is a new sidebar entry.

---

## Scope that shipped

| Concern | Shipped |
|---------|---------|
| Arch #1 — single `ModuleRegistry` instance shared by TUI + daemon surfaces | ✅ created in `startFlow`, passed through to `startServicesAsync` + `startServices` |
| Arch #3 — `MarketplaceModuleEntry` is a `Pick<>` of `RegisteredModuleRow` | ✅ row projection centralized in `rowFor` (exported as `listRows`) |
| Arch #4 — branch on `RegisteredModule.kind` (delete `isBuiltInModulePath`) | ✅ `rowFor` branches on kind; sentinel `modulePath` kept, predicate deleted |
| Security F3 — concurrent `modules/config/set` serialization | ✅ 8-line `Map<key, Promise<unknown>>` chain in `setModuleConfig`, auto-cleaned on chain tail |
| Security F5 — renderer preload channel allowlist | ✅ `electron/preload-allowlist.cjs` (sharable with vitest) + preload.js check + 10 new tests |
| Security F6 — reserve `log` / `appInfo` ids | ✅ `RESERVED_CAPABILITY_IDS` in `CapabilityRegistry`; opt-in `{allowReserved: true}` for host wiring |
| Simplicity #6 — drop `serviceBus.moduleEvent` relay | ✅ Electron `ipc/index.ts` subscribes to the published bus directly; serviceBus topic deleted |
| Electron-mode module-system bootstrap | ✅ `electron/module-system-bootstrap.ts` + called from `startRealServices` |
| `ModuleConfigForm` renderer component | ✅ JSON Schema → form (string, integer, number, boolean, enum); config-changed live updates preserve in-flight edits |
| `Settings.tsx` migrated to `modules:config-get/set` | ✅ theme picker + schema-driven preferences form; `onSaved` re-applies theme |
| `Marketplace.tsx` renderer panel + `modules:list` IPC | ✅ rows / kind + state / built-in badge; no install UI (Phase 6) |
| Sidebar + App.tsx — option (a): hardcoded dispatch, manifests metadata-only | ✅ Marketplace entry added; 3p extensions still flow through `modules:list-panels` |

---

## Files touched

### New

| File | Purpose |
|------|---------|
| `electron/module-system-bootstrap.ts` | Stand up `CapabilityRegistry` + `ModuleHostManager` + `ModuleRegistry` with built-ins + Marketplace for Electron mode. Publishes through `serviceBus` so pre-registered ipcMain handlers resolve their deps. |
| `electron/preload-allowlist.cjs` | Channel allowlist + `isAllowedInvoke` / `isAllowedOn` predicates. Plain CJS so the vitest test can `require()` it (project is ESM). |
| `electron/__tests__/preload-allowlist.test.ts` | 10 tests — every INVOKE_EXACT / ON_EXACT entry accepted, prefix match works, non-strings + bare prefixes rejected, lists are frozen. |
| `electron/__tests__/module-system-bootstrap.test.ts` | 5 tests — serviceBus publish, built-in manifest registration, marketplace capability registration, idempotency, reserved-id enforcement on fresh registries. |
| `electron/__tests__/modules-list.test.ts` | 4 tests — `listRows` returns kind/state/version correctly, arch #3 shape match. |
| `renderer/components/ModuleConfigForm.tsx` | Generic JSON-Schema → form. Reads via `modules:config-get`, writes via `modules:config-set`, live-updates on `modules:event` `config-changed`. |
| `renderer/components/ModuleConfigForm.css` | Styling for the form. |
| `renderer/views/Marketplace.tsx` | Marketplace renderer panel. |
| `renderer/views/Marketplace.css` | Marketplace styling (state/kind/scope badges). |
| `renderer/__tests__/settings-schema-parity.test.ts` | 2 tests — `SETTINGS_CONFIG_SCHEMA` in Settings.tsx mirrors the server `settingsManifest.contributes.config.schema`. Catches drift without RTL. |
| `docs/plans/2026-04-22-module-system-phase-5c-handoff.md` | This document. |

### Modified

| File | Change |
|------|--------|
| `src/app/start-flow.ts` | Arch #1 — single `ModuleRegistry`; both legacy Ink registrations + `registerBuiltIn` happen at `startFlow` level; `startServicesAsync` + `startServices` accept the registry as an argument. F6 — `allowReserved: true` on `log` / `appInfo`. Simplicity #6 — dropped the `emitModuleEvent` relay; the bus is the single fan-out point. |
| `src/app/modules-ipc.ts` | `RegisteredModuleRow` gains `kind`. `rowFor` branches on `kind`: built-ins use `reg.state` directly; subprocess modules consult the manager. `listRows` exported so Electron can reuse the projection. `setModuleConfig` is now async + guarded by a per-module lock. |
| `src/app/service-bus.ts` | Dropped `moduleEvent` topic + `emitModuleEvent` method (simplicity #6). `moduleEventsBus` is the only fan-out point. |
| `src/modules/registry.ts` | Deleted `isBuiltInModulePath` predicate (arch #4). `builtInModulePath()` + `BUILT_IN_MODULE_PATH_PREFIX` remain for display-only use. |
| `src/modules/built-in/marketplace.ts` | `MarketplaceModuleEntry` is now a `Pick<RegisteredModuleRow, ...>` (arch #3). |
| `src/core/module-host/capabilities.ts` | `RESERVED_CAPABILITY_IDS = ["log", "appInfo"]` + `allowReserved: true` opt-in on `register()` (F6). |
| `src/core/module-host/__tests__/capabilities.test.ts` | Pass `allowReserved: true` where tests previously registered `log` / `appInfo`; added 3 new tests for the reserved-id guard. |
| `src/core/module-host/__tests__/manager.integration.test.ts` | `register("log", {}, { allowReserved: true })` in the shared harness. |
| `src/modules/__tests__/built-in-registration.test.ts` | Removed `isBuiltInModulePath` import; the test that used it now asserts `kind === "built-in-privileged"` instead. |
| `electron/__tests__/modules-config.test.ts` | All `handleConfigSet` assertions are `await`ed (now async). +2 new tests — F3 same-id serialization, cross-module parallelism. |
| `electron/ipc/modules-config.ts` | `handleConfigSet` is async (F3 lock). Reply type widens to `Promise<ModuleConfigSetResult>`. |
| `electron/ipc/modules-panels-register.ts` | New `modules:list` handler delegates to `listRows`. Dispose tears it down. |
| `electron/ipc/services.ts` | Static `import { bootstrapElectronModuleSystem }`; called right after `state.artifactStore` is populated. |
| `electron/ipc/index.ts` | Subscribe to the published `moduleEventsBus` for renderer forward (simplicity #6). |
| `electron/preload.js` | Allowlist-gated `invoke` / `on` / `off`. Rejected invokes return a rejected Promise; rejected subscribes log + no-op. Allowlist arrays live in `preload-allowlist.cjs`. |
| `electron/preload.ts` | DELETED — was an unused duplicate; main.ts loads `preload.js` directly. |
| `renderer/App.tsx` | `case 'marketplace': return <Marketplace />;` in `renderView()`. Tab-cycle includes `marketplace`. |
| `renderer/components/Sidebar.tsx` | New `marketplace` entry in `builtinModules`. |
| `renderer/views/Settings.tsx` | `SETTINGS_CONFIG_SCHEMA` mirrored from the server manifest; `<ModuleConfigForm />` below the theme picker; theme persistence via `modules:config-set`. |
| `renderer/views/Settings.css` | Styling for the new `settings-section-description`. |

---

## Verification

- **vitest:** 707 passed / 0 failed (+26 since PR #3 merged).
- **tsc (root):** 149 — unchanged baseline.
- **bun run build:** green.
- **Manual GUI smoke:** passed. First pass regressed on the preload split (see "In-session regression" below); second pass after the fix + Quick-Mode ship came back clean.

---

## Permanent contract decisions made in Phase 5c

- **Arch #1 — there is one `ModuleRegistry` instance per host process.** TUI and daemon share it; legacy Ink `RnDevModule` and manifest-shape `RegisteredModule` live in separate maps on the same object.
- **Arch #3 — the Marketplace capability returns a subset of the IPC row.** `MarketplaceModuleEntry = Pick<RegisteredModuleRow, "id" | "version" | "scope" | "isBuiltIn" | "kind" | "state">`. One projection (`rowFor`) feeds both surfaces.
- **Arch #4 — branch on `RegisteredModule.kind`.** Consumers that need to know "is this a built-in?" compare against `kind === "built-in-privileged"` (or read `isBuiltIn`). The `builtInModulePath()` helper remains as a display/sentinel-only constructor; the predicate is gone.
- **F3 — `setModuleConfig` is async + per-module serialized.** Callers must `await`. The lock key is `<moduleId>:<scopeUnit>` so cross-module writes parallelize but same-module writes never interleave.
- **F5 — renderer preload exposes a closed allowlist.** Adding a new channel is a two-file diff (`preload-allowlist.cjs` + the handler registrar). Unknown channels reject at the preload boundary even before the handler would run.
- **F6 — `log` and `appInfo` are reserved capability ids.** `CapabilityRegistry.register()` rejects them unless the caller passes `{allowReserved: true}`. Only `startFlow` / `bootstrapElectronModuleSystem` use that opt-in; 3p + built-ins get a loud error if they collide.
- **Simplicity #6 — one module-events bus per host, one fan-out point.** `registerModulesIpc` owns the bus; `serviceBus.setModuleEventsBus(bus)` publishes it; every subscriber (Electron renderer forward, MCP subscribe, Electron config-set audit) attaches directly.
- **Electron-mode bootstrap is idempotent.** Re-entering `startRealServices` (via `app.activate` on macOS) doesn't double-register capabilities.
- **`modules:list` is the Electron equivalent of the daemon's `modules/list` action.** Both route through `listRows` so the row shape is transport-agnostic.
- **Built-in config schemas are mirrored, not imported, on the renderer side.** `renderer/__tests__/settings-schema-parity.test.ts` guards against drift. Future built-ins that grow a schema should add a parity test per module.
- **Sidebar stays hardcoded (option a).** Manifests are metadata-only on the renderer side in 5c. Option (b) — driving the sidebar off `modules:list-panels` and branching on `kind` — is a clean long-term goal but requires the `electronPanel` schema to distinguish "webview" vs "renderer-native" panels, which is Phase 7+ scope.

---

## Pre-merge review — 4 reviewers, fixes applied this PR

Four parallel reviews ran against the initial 3-commit stack (kieran-typescript, security-sentinel, architecture-strategist, code-simplicity-reviewer). Zero P0 findings. P1 items were split between "fix pre-merge" (introduced by this PR, real correctness/security, short fix) and "follow-up" (pre-existing or scope-expansion).

### Pre-merge fixes (4th commit on the stack)

- **Kieran P1-1** — `ModuleConfigForm` `useIpcOn` listener leak. Handler closed over `config` and depended on `[moduleId, config]`, so the subscription re-created on every config change + every keystroke (since `useIpcOn` re-fires on handler identity). Switched to `configRef` / `draftRef` refs; callback identity is now stable across renders.
- **Kieran P1-2** — `ConfigSetReply = Promise<ModuleConfigSetResult>` was mis-shaped; reply types should describe values. Changed to `ConfigSetReply = ModuleConfigSetResult`, `handleConfigSet(...): Promise<ConfigSetReply>` explicitly.
- **Security P1-2** — bootstrap's 3p manifest rejections were silent `console.warn` in production. Routed through `serviceBus.log()` for parity with the TUI path (`start-flow.ts`) so rejections surface in the renderer's service:log pane.
- **Security P1-3** — `readHostVersion()` used `process.cwd()/package.json` which in Electron mode often points at the user's RN project. A hostile project `package.json` could spoof the host version to bypass `hostRange` gating. Resolved relative to `import.meta.url` instead. No silent `"0.0.0"` fallback either — throws with a clear message if the host `package.json` is missing a `version`.
- **Simplicity P0-1** — deleted the `integer` / `number` FieldInput branch in `ModuleConfigForm`. No Phase 5c built-in uses those types; re-add when a 3p module actually ships one. Narrowed `JsonSchemaProperty.type` to `'string' | 'boolean'`.
- **Simplicity P0-2** — dropped the Marketplace "Action" column. It only ever displayed "system, uninstallable" (built-ins) or an em-dash (3p, no install flow yet). Phase 6 will reintroduce the column when the install button is real.
- **Simplicity P0-3** — trimmed WHAT-explains comments (section dividers, obvious useEffect explanations, narrative preamble in bootstrap).
- **Simplicity P1-4** — collapsed `saved` status into a derived `showSaved = justSaved && !dirty && status === 'idle'` flag. Dropped the 1500ms timeout and the explicit `saved` state variant; the "✓ Saved" pill fades as soon as the user edits again.

### Deferred to follow-ups (not in this PR)

Each of these is tracked in the list below; the "Deferred items" section calls them out for Phase 6 / 7 owners. None block merge.

- **Kieran P1-3** — `useIpc.ts` returns `any`. Pre-existing. Tighten the hook signature to `<T = unknown>(channel: string, ...args): Promise<T>` in a follow-up.
- **Arch P1-1** — `electron/module-system-bootstrap.ts` duplicates `src/app/start-flow.ts`'s capability + registry + built-in wiring. The TUI and Electron paths need different subsets today (Electron skips `metro` / `artifacts` capabilities and the unix IPC dispatcher), but every new built-in has to land in both files. Extract a shared `createModuleSystem()` factory in Phase 6 when install-flow adds a third bootstrap concern.
- **Arch P1-2** — `ModuleConfigForm` mixes IPC with presentation. Extract a `useModuleConfig(moduleId, scope)` hook when the second consumer arrives (likely Phase 6's per-module settings drawer off a Marketplace row click).
- **Security P1-1** — host UI `PanelSenderRegistry.trustHostSender(window.webContents)` grants wildcard cross-module config-write authority. A renderer XSS could rewrite any module's config. Mitigation: either split trust into `host:read` / `host:write-own` / `host:write-cross-module`, or scope cross-module writes to a declared allowlist per panel. Phase 6 consideration — compounds once 3p modules ship schemas with sensitive fields.

---

## In-session regression — preload split broke `window.rndev`

Commit 2 split the renderer preload into `electron/preload.js` + `electron/preload-allowlist.cjs`, with preload.js doing `require('./preload-allowlist.cjs')`. Martin's first smoke pass showed the renderer running `useSimulatedLogs` output ("CompileC Module1.swift", "MovieNightsClub rootTag:30") — the browser-only fallback at `renderer/hooks/useSimulatedLogs.ts:23` fires when `window.rndev` is undefined.

Root cause: project is `"type": "module"` in package.json, so Electron's preload loader treated `preload.js` as ESM. Either `require` wasn't available or the relative `.cjs` path didn't resolve; the require threw silently and `contextBridge.exposeInMainWorld('rndev', ...)` never ran.

Fix (commit 5, `a8fd969`): renamed `electron/preload.js` → `electron/preload.cjs`, inlined the allowlist data + predicates, wrapped the `require('electron')` in try/catch so vitest can still require the same file for the 10 predicate tests. Deleted `preload-allowlist.cjs`. Updated `main.ts` preload path + test import path.

**Lesson:** Electron preload files must be self-contained in ESM-typed projects, and should carry an explicit `.cjs` extension. The preload runs in an isolated context where silent failures don't reach stdout — a layered default fallback (the simulated logs here) can mask it for hours.

---

## Quick Mode landed same session

Commit 6 (`c160620`) implemented the "Quick Mode" from the prior `docs/superpowers/specs/2026-04-13-tab-close-retry-continue-quick-mode-design.md` spec (was in a worktree, never merged). When `mode === "quick"`: skip clean + code-signing check + build trigger; Metro starts with `resetCache: false`. The already-installed app binary on the device/sim connects to Metro directly. Drops smoke-test startup from ~5min (xcodebuild) to ~3s.

Step behavior by mode:

| Step       | Quick | Dirty | Clean | Ultra-Clean |
|------------|:-----:|:-----:|:-----:|:-----------:|
| Preflight  |   Y   |   Y   |   Y   |      Y      |
| Clean      |   -   |   -   |   Y   |      Y      |
| Watchman   |   Y   |   Y   |   Y   |      Y      |
| Metro      |   Y   |   Y   |   Y   |      Y      |
| Build      |   -   |   Y   |   Y   |      Y      |

Out-of-scope sections from that same spec doc (not this session) — tight independent pieces, worth a small follow-up PR if they're biting day-to-day:

- **Section 1 — Tab close double-click UX + builder cancel leak** (bug). Close button requires confusing double-click; `instances:remove` only kills Metro, leaks the Builder subprocess.
- **Section 2 — Retry & Continue chain + busy flag** (feature). Retry currently re-runs one step; users want it to continue the chain.
- **Section 4 — Profile banner mode display** (bug). Banner hardcodes `dirty:true` because `ProfileInfo.dirty` is a boolean; should be a `mode: string`.

---

## Deferred items (Phase 5c → Phase 6 and beyond)

1. **Real install / uninstall.** Phase 6. `@npmcli/arborist --ignore-scripts`, registry SHA pin, consent dialog. The Marketplace renderer panel's "Action" column is deliberately a placeholder for built-ins today; Phase 6 fills it in for `kind === "subprocess"` rows.
2. **Option (b) sidebar — drive off `modules:list-panels` + branch on `kind`.** Needs the `electronPanel` manifest schema to grow a `kind: "webview" | "renderer-native"` discriminator (or make `webviewEntry` optional) so built-ins can contribute renderer-native panels declaratively. Defer until Phase 7 or whenever a third renderer-native panel joins Marketplace + Settings.
3. **MCP tool contributions on built-ins.** Zero built-ins contribute MCP tools through their manifest today — the top-level `rn-dev/*` surface still owns everything. The plan eventually wants built-ins to contribute through the manifest path for uniformity.
4. **HMAC-chained `AuditLog.append()`.** Still a separate follow-up; `service:log` is the audit sink for `modules:host-call` + `modules:config-set` today.
5. **Interactive GUI smoke automation.** This phase lands with the Electron boot confirmed but no per-panel screenshots. If the next phase also touches the renderer, set up RTL or Playwright-for-Electron so future PRs have automated visual evidence.

---

## Where the module system stands (end of Phase 5c)

- **Phase 0–3d** (squashed PR #2): foundation.
- **Phase 4 + 5a + 5b** (squashed PR #3): Electron panels, per-module config, built-in manifest-ification + Marketplace stub.
- **Phase 5c** (this PR): review follow-ups + Electron bootstrap + renderer panels + Settings migration.

**Test totals:** 707 passed / 0 failed. tsc: 149 (unchanged). `bun run build`: green.

---

## What's next

Ask Martin:

> **"Phase 5c done. Ready for Phase 6 (marketplace install flow + consent UX + arborist) or pivot to Device Control module / DevTools Network extension?"**

Phase 6 is a bigger design conversation (curated-registry schema, SHA pinning strategy, consent UX). If Martin wants to keep forward momentum on foundation and defer install for one more phase, a good intermediate is:

- **Option (b) sidebar + `electronPanel` schema extension** — now that Marketplace + Settings both live as renderer-native panels, there's a real use case for `kind: "renderer-native"` in the schema. Cheap to ship and unblocks future built-ins shipping as declarative manifest contributions.
- **MCP tool contributions on built-ins** — rewire the top-level `rn-dev/*` surface to flow through manifest `contributes.mcp.tools` so 3p and built-in tools are uniform. Moderate scope; no user-visible changes but a cleaner architecture.

---

## Useful commands

```bash
# Phase 5c-specific tests
npx vitest run \
  electron/__tests__/module-system-bootstrap.test.ts \
  electron/__tests__/modules-list.test.ts \
  electron/__tests__/preload-allowlist.test.ts \
  renderer/__tests__/settings-schema-parity.test.ts

# Full suite — expect 707 / 0
npx vitest run

# Type check — baseline 149
npx tsc --noEmit | grep -c "error TS"

# Production build
bun run build

# Manual GUI smoke — this phase's smoke was blocked on OS permissions;
# Martin should run this locally before merge.
bun run dev:gui
# Click through: DevSpace → DevTools → Lint & Test → Metro Logs →
# Marketplace → Settings. Hit Tab to cycle. Edit a Settings preference,
# confirm "✓ Saved" appears + ~/.rn-dev/modules/settings/config.json
# updates. Edit the theme via the form picker (enum) + via the grid;
# both should work + persist.
```
