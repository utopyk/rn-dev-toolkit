# Module System — Phase 5b → Phase 5c / 6 Handoff

**Written:** 2026-04-22
**By:** Claude (Phase 5b session)
**For:** The next Claude (or human) continuing this feature

---

## What shipped in Phase 5b (core)

The four existing built-ins now carry **manifest-shape metadata** and
register as first-class `RegisteredModule` entries in the daemon's module
registry alongside 3p modules. A new `Marketplace` built-in ships the
`modules` host capability (list/install/uninstall) with install +
uninstall as explicit `NOT_IMPLEMENTED` stubs — the real install flow
lands in Phase 6.

Phase 5b intentionally stopped short of the renderer-side work. See
**Deferred items** below for what's left.

---

## Scope that shipped

| Concern | Shipped |
|---------|---------|
| `RegisteredModule.kind` ("subprocess" \| "built-in-privileged") | ✅ additive, defaults to "subprocess" for backward compat |
| Sentinel `modulePath` for built-ins (`<built-in:<id>>`) | ✅ `builtInModulePath()` + `isBuiltInModulePath()` helpers |
| `ModuleRegistry.registerBuiltIn(manifest, opts)` helper | ✅ validates schema, waives 3p tool-prefix policy, stamps kind + state="active" + isBuiltIn=true |
| Built-in manifests for `dev-space`, `metro-logs`, `lint-test`, `settings` | ✅ in `src/modules/built-in/manifests.ts` (kept React-free so tests don't transitively pull OpenTUI) |
| `metro-logs` + `settings` contribute `config.schema` | ✅ exercises Phase 5a plumbing |
| `Marketplace` built-in | ✅ `src/modules/built-in/marketplace.ts` — `createMarketplaceCapability(registry)` + `registerMarketplaceBuiltIn({moduleRegistry, capabilities})` |
| `modules` capability on the host `CapabilityRegistry` | ✅ `MARKETPLACE_CAPABILITY_ID = "modules"`, public (no requiredPermission) |
| Manager refuses to spawn built-ins | ✅ `acquire()` throws `E_BUILT_IN_NOT_SPAWNABLE` |
| `modules/call` returns `MODULE_UNAVAILABLE` for built-ins | ✅ clear error message: "call the host-native MCP surface directly" |
| `start-flow.ts` wires everything up | ✅ four `registerBuiltIn` calls + one `registerMarketplaceBuiltIn` |

---

## Files touched

### New

| File | Purpose |
|------|---------|
| `src/modules/built-in/manifests.ts` | Pure-data built-in manifests. React-free on purpose so tests + server-side code can import without pulling in `@opentui/react` via the colocated `RnDevModule` components. |
| `src/modules/built-in/marketplace.ts` | Marketplace built-in manifest + `MarketplaceCapability` interface + `createMarketplaceCapability()` + `registerMarketplaceBuiltIn()`. `install` / `uninstall` are explicit `NOT_IMPLEMENTED` stubs with a Phase 6 marker in the error message. |
| `src/modules/__tests__/built-in-registration.test.ts` | 9 tests — kind/state/path stamps, scopeUnit resolution, validation-throws-on-invalid, duplicate-id guard, tool-prefix waiver for built-ins, each of the 4 manifests registers + contributes its own TUI view. |
| `src/modules/__tests__/marketplace.test.ts` | 7 tests — list mirrors registry, 3p surface as kind=subprocess, install/uninstall reject with NOT_IMPLEMENTED, `registerMarketplaceBuiltIn` end-to-end, double-call throws, schema is valid. |
| `docs/plans/2026-04-22-module-system-phase-5b-handoff.md` | This document. |

### Modified

| File | Change |
|------|--------|
| `src/modules/registry.ts` | `RegisteredModule.kind?: "subprocess" \| "built-in-privileged"`. `BUILT_IN_MODULE_PATH_PREFIX` + `builtInModulePath()` + `isBuiltInModulePath()` helpers. New `registerBuiltIn(manifest, options)` method that throws `ModuleError` on invalid manifests (programmer error, not runtime state) and waives the 3p tool-prefix policy. |
| `src/modules/index.ts` | Re-exports `devSpaceManifest`, `metroLogsManifest`, `lintTestManifest`, `settingsManifest` from `./built-in/manifests.js` + marketplace surfaces. |
| `src/modules/built-in/{dev-space,metro-logs,lint-test,settings}.ts` | Each file now `export { <id>Manifest } from "./manifests.js"`. The inline manifest declarations that briefly lived here were moved to `manifests.ts` once the test suite surfaced an OpenTUI transitive import. No functional change. |
| `src/core/module-host/manager.ts` | `acquire()` throws `E_BUILT_IN_NOT_SPAWNABLE` when asked to spawn a built-in-privileged module. Defensive; `modules-ipc` already short-circuits earlier. |
| `src/app/modules-ipc.ts` | `callModuleTool` returns `MODULE_UNAVAILABLE` with a clear message for built-in-privileged modules — agents see the same error code as "unknown module" but the message explains the cause. |
| `src/app/__tests__/modules-ipc.test.ts` | +2 tests for the built-in guard in `modules/call` + direct `manager.acquire`. |
| `src/app/start-flow.ts` | Imports `devSpaceManifest`, `metroLogsManifest`, `lintTestManifest`, `settingsManifest`, `registerMarketplaceBuiltIn`. Right after creating the daemon's `moduleRegistry`, calls `registerBuiltIn` for each of the four existing built-ins plus `registerMarketplaceBuiltIn({moduleRegistry, capabilities})`. |

---

## Verification

- **vitest:** 671 passed / 0 failed (+18 since Phase 5a).
- **tsc (root):** 149 — unchanged from Phase 4/5a baseline.
- **bun run build:** green.
- **Manual GUI smoke:** not run this session. The renderer continues to
  dispatch to its hard-coded native React views; no visible change to
  DevSpace / MetroLogs / LintTest / Settings panels. Phase 5c's Settings
  migration is the right time for a before/after smoke test.

---

## Permanent contract decisions made in Phase 5b

- **`RegisteredModule.kind` is optional** and defaults to `"subprocess"`
  when omitted. Every existing Phase 0–5a registration keeps its shape
  — no migration required in call sites.
- **Built-ins have no package on disk.** The sentinel
  `<built-in:<id>>` is written to `modulePath` so panel-bridge + IPC
  consumers can detect the in-process case with a single string check
  (`isBuiltInModulePath`), no extra field, no special-case enum value.
- **Built-ins bypass the `<moduleId>__<tool>` prefix policy.** The
  `enforceToolPrefix(manifest, {isBuiltIn: true})` call inside
  `registerBuiltIn` waives it — built-ins can contribute flat-namespace
  MCP tools (e.g. `metro/*`) per the plan's tool-name policy.
- **Built-ins are not spawnable.** Both `ModuleHostManager.acquire` and
  `modules/call` refuse them with `E_BUILT_IN_NOT_SPAWNABLE` /
  `MODULE_UNAVAILABLE` respectively. A module author trying to proxy
  a built-in's tools through `modules/call` gets a clear signal — the
  built-in's capabilities are registered directly on the
  `CapabilityRegistry` and called via `host/call`, not through
  subprocess RPC.
- **Marketplace capability id is `"modules"`.** No `requiredPermission`.
  Matches the plan's "known built-in capability ids" list in
  `host-rpc.ts`.
- **Marketplace install / uninstall are explicit `NOT_IMPLEMENTED`.**
  Rejected promises with the string `NOT_IMPLEMENTED` in the error
  message so callers can pattern-match without parsing prose. Real
  install flow is Phase 6.
- **Marketplace `list()` delegates to `ModuleRegistry.getAllManifests()`
  — same source of truth as `modules/list`.** Two reads, one truth.
- **Manifests live in a React-free file** (`manifests.ts`). This came
  from the test suite: importing `devSpaceManifest` from
  `./built-in/dev-space.ts` transitively pulled `@opentui/react`, which
  has an ESM-resolution issue in the vitest env. Splitting fixed the
  tests AND means future server-only consumers (e.g. MCP server) never
  pay the TUI cost to read a manifest.

---

## Deferred items (Phase 5b → Phase 5c / 6)

The Phase 5 next-session prompt bundled two sub-phases; Phase 5b here is
only "built-in modules adopt manifest shape + Marketplace stub". The
following items remain:

1. **Marketplace renderer-native React panel.** Phase 5c or alongside
   Phase 6. The capability is in place; a `renderer/views/Marketplace.tsx`
   + sidebar entry + renderer hook wiring is needed to actually display
   "system, uninstallable" badges on the four built-ins.
2. **Settings renderer panel migrates to `modules/config/*`.** Phase 5c.
   Today `renderer/views/Settings.tsx` doesn't read/write any persistent
   config. The `settingsManifest.config.schema` declares two fields
   (`theme`, `showExperimentalModules`); a follow-up migrates the panel
   to call the IPC channels shipped in Phase 5a.
3. **Sidebar drives from the manifest list.** Currently
   `renderer/components/Sidebar.tsx` + `renderer/App.tsx` hard-code the
   built-in ids. Phase 5b only unifies the data shape on the daemon;
   the renderer still dispatches by hardcoded string. Phase 5c can
   either (a) keep the hardcoded dispatch and treat the manifests as
   metadata-only, or (b) drive the sidebar from `modules/list` +
   distinguish built-in-privileged (native React) vs subprocess
   (WebContentsView) by the `kind` field. (b) is the clean endpoint;
   (a) is cheaper to ship.
4. **Real install / uninstall.** Phase 6. `@npmcli/arborist --ignore-scripts`,
   registry SHA pin, consent dialog.
5. **Renderer-native panel contribution kind.** The current
   `electronPanel` schema requires `webviewEntry` — which makes no
   sense for a built-in with a native React view. Decide whether to
   (a) add `kind: "webview" | "renderer-native"` to the panel schema,
   or (b) make `webviewEntry` optional. Either is fine; hold until
   Phase 5c actually needs it.
6. **MCP tool contributions on built-ins.** Zero Phase 5b built-ins
   contribute MCP tools through the manifest path — the top-level
   `rn-dev/*` surface (in `src/mcp/tools.ts`) owns everything. The
   plan eventually wants built-ins to contribute through the manifest
   too for uniformity with 3p; not a Phase 5b blocker.

---

## Where the module system stands (end of Phase 5b)

Branch `feat/module-system-phase-4` is now 11 commits on top of
`main@6718346`:

- **Phase 0–3d** (squashed PR #2): foundation.
- **Phase 4** (5 commits): Electron panel contributions.
- **Phase 5a** (1 commit): per-module config surface end-to-end.
- **Phase 5b core** (1 commit, this session): built-in manifest-ification
  + Marketplace stub.

**Test totals:** 671 passed / 0 failed. tsc: 149 (unchanged).
`bun run build`: green.

PR surface is growing — 11 commits spanning three meaningful phases.
Previous recommendation to open a PR at the Phase 5a boundary still
applies, even more so now. If Martin opts to keep stacking, the next
natural stopping point is after Phase 5c (renderer work) or after Phase
6 (install flow).

---

## What's next

Ask Martin:

> **"Phase 5b core done — open a PR at `feat/module-system-phase-4`
> (11 commits: Phase 4 + 5a + 5b) now, continue to Phase 5c (Marketplace
> panel + Settings migration), or jump to Phase 6 (install flow)?"**

My recommendation: **open the PR**. The stack covers three coherent
units that each stand on their own. Phase 5c and Phase 6 both touch the
renderer in meaningful ways and deserve their own review surface. A
reviewer staring at 11 commits + 2000+ inserted lines will thank you
for splitting.

If Martin insists on continuing, **Phase 5c next** (not Phase 6). The
plumbing is in place; the Marketplace panel is a small-ish React piece
that exercises the 5a+5b work end-to-end. Phase 6 is a bigger design
conversation (curated registry schema, consent UX, arborist integration).

---

## Useful commands

```bash
# Just the Phase 5b tests
npx vitest run \
  src/modules/__tests__/built-in-registration.test.ts \
  src/modules/__tests__/marketplace.test.ts \
  src/app/__tests__/modules-ipc.test.ts

# Full suite — expect 671+ / 0 failed
npx vitest run

# Type check — baseline 149
npx tsc --noEmit | grep -c "error TS"

# Production build
bun run build

# GUI smoke — expect zero visible change from Phase 5a; Phase 5c's
# Settings migration is the right time for before/after captures
bun run dev:gui
```
