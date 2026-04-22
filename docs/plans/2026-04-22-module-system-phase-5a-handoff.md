# Module System — Phase 5a → Phase 5b/6 Handoff

**Written:** 2026-04-22
**By:** Claude (Phase 5a session)
**For:** The next Claude (or human) continuing this feature

---

## What shipped in Phase 5a

Per-module persistent config. A module with
`contributes.config.schema` in its manifest now:

1. Receives its persisted config blob on the `initialize` handshake
   (`params.config`) as a new first-class field alongside `capabilities` +
   `hostVersion`.
2. Receives live config updates via the `config/changed` notification
   (vscode-jsonrpc). `ctx.config` is replaced in place; the author's
   `onConfigChanged` callback fires after the swap.
3. Is exposed to MCP agents via `rn-dev/modules-config-get` +
   `rn-dev/modules-config-set` — both route through the daemon's
   `modules/config/*` IPC action set.
4. Is exposed to the Electron renderer / preload via `modules:config-get`
   + `modules:config-set` ipcMain channels with audit logging.
5. Is validated against the module's JSON Schema before every write; a
   failing `set` returns `E_CONFIG_VALIDATION` with the full ajv error
   list.
6. Persists atomically to `~/.rn-dev/modules/<id>/config.json` — tmpfile
   + rename. Lives alongside the existing `disabled.flag` from Phase 3c.

All on one branch stack (`feat/module-system-phase-4`), one commit for
Phase 5a.

---

## Files touched

### New — Phase 5a

| File | Purpose |
|------|---------|
| `src/modules/config-store.ts` | `ModuleConfigStore` — `rootFor`, `pathFor`, `get`, `validate` (ajv 2020-12, validator cache), `write` (tmpfile + rename). Defaults to `~/.rn-dev/modules/`. |
| `src/modules/__tests__/config-store.test.ts` | 14 unit tests — round-trip, schema validation, malformed-JSON tolerance, atomic write, default path. |
| `electron/ipc/modules-config.ts` | Pure IPC logic — `handleConfigGet`, `handleConfigSet`. Reuses daemon `getModuleConfig` / `setModuleConfig` so one code path covers unix-socket + Electron main callers. Audit emits sorted key names, not values. |
| `electron/ipc/modules-config-register.ts` | Thin `ipcMain.handle` registrar (split to keep `modules-config.ts` importable under vitest without pulling `electron`). |
| `electron/__tests__/modules-config.test.ts` | 6 tests — persist, schema reject, audit fields, moduleEvents fan-out, unknown module. |
| `docs/plans/2026-04-22-module-system-phase-5a-handoff.md` | This document. |

### Modified

| File | Change |
|------|--------|
| `packages/module-sdk/manifest.schema.json` | `contributes.config` description flipped from "Reserved for Phase 5 …host ignores in v1" to "Host stores the validated JSON blob at …". Still additive — no schema version bump. |
| `packages/module-sdk/src/module-runtime.ts` | `ModuleAppInfo.config: Record<string, unknown>` (required, always present). `ModuleToolContext.config` mirrors it. `RunModuleOptions.onConfigChanged?: (config) => void \| Promise<void>`. New `connection.onNotification("config/changed", ...)` handler replaces `ctx.config` + `ctx.appInfo.config` in place and fires the callback. `normalizeInitializeParams` coerces non-object / missing → `{}`. `fallbackContext` returns `config: {}`. |
| `packages/module-sdk/src/__tests__/module-runtime.test.ts` | +3 tests — initialize propagation, `config/changed` round-trip + onConfigChanged, missing-config defaults to `{}`. |
| `src/core/module-host/rpc.ts` | `InitializeParams.config: Record<string, unknown>` required. |
| `src/core/module-host/__tests__/rpc.test.ts` | Two existing tests now pass `config: {}` to `performInitialize`. |
| `src/core/module-host/manager.ts` | New `configStore?: ModuleConfigStore` option (defaults `new ModuleConfigStore()`). Manager exposes `public readonly configStore` (parity with `public readonly capabilities`). `spawnEntry` reads config before the handshake via `this.configStore.get(manifest.id)` and passes it to `performInitialize`. New `notifyConfigChanged(moduleId, scopeUnit, config)` sends a `config/changed` notification to a live subprocess and returns `false` if nothing is running. |
| `src/app/modules-ipc.ts` | New actions `modules/config/get` + `modules/config/set` added to `ModulesIpcAction` + `MODULES_ACTIONS`. New `ModulesEvent.kind` value `"config-changed"` with `config` payload. `ModulesIpcOptions.configStore?: ModuleConfigStore` (defaults to `opts.manager.configStore`). Helpers `getModuleConfig` + `setModuleConfig` are **exported** so the Electron IPC layer can call them directly. `setModuleConfig` shallow-merges patch → validates against `manifest.contributes.config.schema` → writes → calls `manager.notifyConfigChanged` → emits `config-changed` on `opts.moduleEvents`. Error codes: `E_CONFIG_VALIDATION`, `E_CONFIG_MODULE_UNKNOWN`, `E_CONFIG_BAD_PATCH`. |
| `src/app/__tests__/modules-ipc.test.ts` | +8 tests for the two new actions — defaults, shallow-merge, validation reject, event fan-out, live subprocess notification, unknown id, bad-patch, schemaless module. |
| `src/app/service-bus.ts` | New `moduleEventsBus: (emitter: EventEmitter) => void` topic + `setModuleEventsBus` setter. Published by `start-flow.ts` after `registerModulesIpc` so Electron-main can emit into the same bus MCP subscribers listen on. |
| `src/app/start-flow.ts` | Calls `serviceBus.setModuleEventsBus(modulesIpc.moduleEvents)` right after the existing `moduleEvents.on("modules-event", ...)` bridge. |
| `src/mcp/tools.ts` | New `rn-dev/modules-config-get` + `rn-dev/modules-config-set` at the end of `buildModulesLifecycleTools`. Both route through `ipcAction` to the daemon's `modules/config/*` actions. Descriptions note that advisory permissions do not gate config reads/writes in v1. |
| `src/mcp/__tests__/tools.test.ts` | Tool count assertions bumped 29 → 31 (default) and 33 → 35 (with `--enable-devtools-mcp`). |
| `electron/ipc/index.ts` | `registerModulesConfigHandlers()` installed alongside `registerModulePanelsHandlers(window)` inside `setupIpcBridge`. Same lazy-deps-via-`getDeps()` pattern as Phase 4's panel bridge. Deps fill in when three serviceBus topics fire: `moduleHost`, `moduleRegistry`, `moduleEventsBus`. Audit sink routes to `service:log` in the same format as host-call: `[modules-config] set <id>[:<scope>] keys=[...] <outcome> (code)`. |
| `test/fixtures/echo-module/rn-dev-module.json` | Added `contributes.config.schema` — a simple `{greeting: string, loud: boolean}` object. |
| `test/fixtures/echo-module/index.js` | Mirrors the manifest schema. New `echo__read-config` tool returns `{ config: ctx.config, appInfoConfig: ctx.appInfo.config, history: configHistory }` for integration tests. `onInitialize` echoes the initial config. `onConfigChanged` appends to the module-local `configHistory` array so tests can observe the callback sequence. |

---

## Verification

- **vitest:** 653 passed / 0 failed (+31 vs Phase 4's 622).
- **tsc (root):** 149 errors — unchanged from Phase 4 baseline.
- **bun run build:** green.
- **Manual GUI smoke:** not run this session. The renderer does not yet
  have a Settings panel driving `modules:config-*`; Phase 5b's Settings
  migration is the natural time to exercise end-to-end.

---

## Permanent contract decisions made in Phase 5a

- **Storage layout.** Config lives at `~/.rn-dev/modules/<id>/config.json`,
  alongside `disabled.flag` — one directory per module, human-readable,
  one grep away.
- **Atomic writes.** `writeFileSync` to `config.json.tmp-<pid>-<ts>` then
  `renameSync`. Crashes mid-write leave only the old file; `get()`
  tolerates corrupt JSON anyway by returning `{}`.
- **Shallow merge for `set`.** The patch is shallow-merged into the
  current config. Clients that need to replace (rather than merge) pass
  the full blob as the patch. Deeper diff semantics are out of scope
  for v1 — JSON Patch / JSON Merge Patch are too much surface for the
  common case of "flip a boolean".
- **Schema is optional.** Modules without `contributes.config.schema`
  still get `get`/`set` — the store accepts any JSON object patch and
  skips validation. Modules that declare a schema get validation on
  every write.
- **JSON Schema 2020-12.** Reuses the ajv path
  `define-module.ts` uses so authors don't learn two validation stacks.
- **Validator caching by schema identity.** `WeakMap<schema, validator>`
  so re-compiling ajv on every set is amortized across the module's
  lifetime.
- **One subscription path.** `modules/config/set` emits a single
  `config-changed` event onto the shared `modulesIpc.moduleEvents` bus.
  MCP `modules/subscribe` consumers see it, and the bus is also
  forwarded to `serviceBus.moduleEvent` → Electron renderer `modules:event`.
  No second fan-out mechanism.
- **SAME bus for Electron path.** When the Electron IPC layer calls
  `setModuleConfig` in-process (bypassing the unix-socket dispatcher),
  it passes the same `moduleEvents` bus via the new
  `serviceBus.moduleEventsBus` topic. MCP subscribers do NOT miss the
  event when the edit originates from the GUI.
- **Error codes returned in the reply body.** `setModuleConfig` returns
  `{kind:"error",code:"E_CONFIG_VALIDATION",message}` rather than
  throwing. Mirrors the `modules/call` pattern — MCP clients branch on
  `kind`.
- **Audit events name keys, not values.** The Electron audit sink
  serialises `patchKeys = Object.keys(patch).sort()` but does NOT
  include the patch body. Config blobs may contain tokens / paths /
  private data; an audit log that echoes them is a leak.
- **`ModuleHostManager.configStore` is `public readonly`.** Electron
  main resolves config against the same store the manager uses to seed
  the handshake — single source of truth, same parity as `capabilities`.
- **Advisory permissions still do not gate config ops in v1.** Both
  MCP tool descriptions call this out explicitly. Future sandbox work
  (v2) may restrict which modules can read/write their own config.

---

## Where the module system stands (end of Phase 5a)

Branch `feat/module-system-phase-4` now sits 10 commits on top of
`main@6718346`:

- **Phase 0–3d** (squashed PR #2): manifest, registry, module host,
  subprocess lifecycle, disabled-flag, MCP module lifecycle tools.
- **Phase 4** (5 commits): Electron panel contributions — panel-bridge,
  WebContentsView, preload, `modules:host-call`, audit.
- **Phase 5a** (1 commit, this session): per-module config surface end-to-end.

**Test totals:** 653 passed / 0 failed. tsc: 149 (unchanged).
`bun run build`: green.

Martin's call which ships next. Arguments:

- **Phase 5b first (built-in migration + Marketplace stub):** finishes
  the "every built-in uses the manifest shape" unification. Exercises the
  Phase 5a config plumbing through the real Settings panel. Touches
  DevSpace + MetroLogs + LintTest + Settings + introduces the
  Marketplace built-in.
- **Pause at Phase 5a and open a PR now:** the stack is 10 commits
  since main and covers two meaningful units (Phase 4 + Phase 5a). If
  Phase 5b grows, that PR review surface compounds.

Recommendation: **open the PR now.** Phase 5a is self-contained; Phase
5b drags in Settings-panel migration which warrants its own review.
Martin's existing preference is meaningful-unit PRs.

---

## What's still deferred (Phase 5a → Phase 5b/6 gap)

From the Phase 5 plan, these items intentionally stayed out of Phase 5a:

1. **Built-in modules adopt the manifest shape.** Phase 5b. DevSpace /
   MetroLogs / LintTest / Settings become manifest-driven. Remain
   in-process and privileged (`kind: "built-in-privileged"`).
2. **Marketplace built-in.** Phase 5b. Renderer-native React panel,
   registers a `modules` capability (list, resolve update, install
   stub, uninstall stub). Real install lands in Phase 6.
3. **Settings panel migration.** Phase 5b. Moves to consume the new
   `modules/config/*` tools through the same surface for built-ins +
   3p modules.
4. **Install / uninstall / `@npmcli/arborist`.** Phase 6.
5. **Registry SHA pin + consent dialog.** Phase 6.
6. **Device Control module implementation.** Phase 7+.
7. **Schema versioning / migrations.** V2.
8. **Config encryption at rest.** Not in scope; permissions are advisory
   in v1.
9. **Per-worktree vs global config scoping.** v1 is keyed on `moduleId`
   only. A v2 concern.
10. **HMAC-chained audit sink.** Panel-bridge, host-call, AND now
    modules-config all route to `service:log`. When `AuditLog.append()`
    lands (Revision Log), swap all three sinks at once.

---

## What's next

Ask Martin:

> **"Phase 5a done — ready to open a PR from `feat/module-system-phase-4`
> (10 commits: Phase 4 + 5a), or keep stacking into Phase 5b?"**

If Martin says "keep stacking", proceed with Phase 5b per the Phase 5
next-session prompt — 5a's plumbing is ready for the Settings migration.

---

## Environment notes — unchanged since Phase 4

- Node ≥18; Bun for install + build + dev; vitest for tests.
- Module state under `~/.rn-dev/modules/<id>/` — now contains `disabled.flag`
  (Phase 3c) and `config.json` (Phase 5a).
- SDK `dist/` is gitignored; `vitest.global-setup.ts` rebuilds it before
  each test run — any SDK surface change (like this phase's ModuleAppInfo
  extension) is automatically picked up by vitest.

---

## Useful commands

```bash
# Just the Phase 5a tests
npx vitest run \
  src/modules/__tests__/config-store.test.ts \
  src/app/__tests__/modules-ipc.test.ts \
  electron/__tests__/modules-config.test.ts \
  packages/module-sdk/src/__tests__/module-runtime.test.ts

# Full suite — expect 653+ / 0 failed
npx vitest run

# Type check — baseline 149
npx tsc --noEmit | grep -c "error TS"

# Production build
bun run build

# GUI smoke (Phase 5b will drive Settings panel end-to-end)
bun run dev:gui
```
