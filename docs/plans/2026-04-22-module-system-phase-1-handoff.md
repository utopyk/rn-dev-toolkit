# Module System — Phase 1 → Phase 2 Handoff

**Written:** 2026-04-22
**By:** Claude (Phase 1 session)
**For:** The next Claude (or human) continuing this feature

---

## Where we are

### Shipped this session

- **`@rn-dev/module-sdk` v0.1** (`packages/module-sdk/`) — manifest JSON Schema, hand-written types, `defineModule()` author helper, typed error codes, and the type surface for `host.capability<T>(id)`.
- **Scope-aware manifest registry** — `src/modules/registry.ts` gained `loadUserGlobalModules()`, `registerManifest()`, `getManifest()`, `getAllManifests()`, `unregisterManifest()` with scope-aware keys `${moduleId}:${scopeUnit}`. Enforces `hostRange` via `semver.satisfies()` and the `<moduleId>__<tool>` prefix policy for 3p at load time.
- **Fixture** — [test/fixtures/minimal-module/rn-dev-module.json](test/fixtures/minimal-module/rn-dev-module.json) — tiny canonical manifest used by the end-to-end registry test.
- **Commit**: branch `feat/module-system-phase-1` stacked on `feat/module-system-phase-0`.

### Verification

- **vitest:** 428 passed / 18 failed. **Zero new failures.** The 18 are the same pre-existing ones called out in the Phase 0 handoff (`src/core/__tests__/{clean,preflight,project}.test.ts`) — chip tracked separately. Phase 1 added 30 new tests (16 SDK + 14 registry). All 30 green.
- **tsc:** 154 pre-existing errors. **Zero new type errors from Phase 1 work.** Verified by stash-pop comparison.
- **bun run build:** produces a working 3.7 MB `dist/index.js`.

### Files touched this session

| File | Change |
|------|--------|
| `packages/module-sdk/manifest.schema.json` | **New** — JSON Schema for `rn-dev-module.json`, draft 2020-12, versioned `$id: https://rn-dev.dev/schemas/module-manifest-1.0.0.json`. |
| `packages/module-sdk/src/types.ts` | **New** — hand-written types mirroring the schema. |
| `packages/module-sdk/src/errors.ts` | **New** — `ModuleErrorCode` enum + `ModuleError` class. |
| `packages/module-sdk/src/define-module.ts` | **New** — `validateManifest()`, `defineModule()`, `enforceToolPrefix()`. Uses `Ajv2020` with `strict: false`. |
| `packages/module-sdk/src/host-rpc.ts` | **New** — type-only surface (`HostApi`, `Logger`, `AppInfo`) — transport lands in Phase 2. |
| `packages/module-sdk/src/index.ts` | **Extended** — barrel export. |
| `packages/module-sdk/package.json` | Bumped to `0.1.0`; added `ajv` dependency; exports `./manifest.schema.json`. |
| `packages/module-sdk/src/__tests__/define-module.test.ts` | **New** — 16 tests (validation happy path, V2-reserved fields, path-pointing errors, prefix enforcement, MetaMCP double-underscore). |
| `package.json` | Added `@rn-dev/module-sdk: workspace:*` + `ajv: ^8.18.0` to root deps. |
| `src/core/types.ts` | `RnDevModule.component` is now **optional** (MCP-only / Electron-only modules are valid). |
| `src/ui/layout/MainLayout.tsx` | `MainLayoutModule.component` mirrored as optional; existing `ActiveComponent ?? null` already handles it. |
| `src/modules/registry.ts` | **Extended** — new types (`RegisteredModule`, `RejectedManifest`, `LoadManifestsOptions`, `LoadManifestsResult`, `ModuleActivationState`), new methods (`loadUserGlobalModules`, `registerManifest`, `getManifest`, `getAllManifests`, `unregisterManifest`), static `manifestKey(id, scopeUnit)`, loosened `isRnDevModule` (component optional). |
| `src/modules/__tests__/registry.test.ts` | **Extended** — +14 tests: `loadUserGlobalModules` (happy path, scope pinning, scope-aware key collisions, hostRange mismatch, invalid JSON, invalid schema with path-pointing errors, unprefixed 3p tool, no-manifest dirs, real fixture load) + `registerManifest`/`getManifest`/`unregisterManifest` direct API. |
| `test/fixtures/minimal-module/rn-dev-module.json` | **New** — canonical fixture. |

---

## Permanent contract decisions made in Phase 1

All additive-only within 1.x. Any removal or type-narrowing = major bump.

- **Schema `$id` is versioned:** `https://rn-dev.dev/schemas/module-manifest-1.0.0.json`. Future 1.x revisions reuse the same id; 2.0 will use `-2.0.0.json`.
- **JSON Schema draft 2020-12** (ajv `ajv/dist/2020.js`) — chosen over draft-07 for `$defs` cleanliness. ajv instantiated with `strict: false` so unknown vocabularies don't blow up.
- **`manifest.schema.json` is `additionalProperties: false` at every level** — typos surface as validation errors instead of silently passing. This is intentional strictness.
- **V2-reserved fields** (`signature`, `sandbox`, `target`) validate against the schema and parse cleanly into `ModuleManifest` but the host ignores them in v1. Adding implementation later is non-breaking.
- **`contributes.api`** (Phase 10) and **`contributes.config`** (Phase 5) — same treatment: schema validates, host ignores.
- **Error codes added in Phase 1:** `E_INVALID_MANIFEST`, `E_HOST_RANGE_MISMATCH`. These are additive to the list originally in the plan's Revision Log. Other codes from the Revision Log (`MODULE_UNAVAILABLE`, `E_NOT_ALLOWED`, `MODULE_ACTIVATION_TIMEOUT`, `E_PERMISSION_DENIED`, `E_MISSING_DEP`, `E_MANIFEST_SHA_MISMATCH`, `E_DESTRUCTIVE_REQUIRES_CONFIRM`, `E_TOOL_NAME_UNPREFIXED`, `E_INTEGRITY_MISMATCH`, `E_METHOD_NOT_EXPOSED`) are all defined but only `E_TOOL_NAME_UNPREFIXED` is thrown in v1 (by `enforceToolPrefix`).
- **`defineModule()` does NOT enforce tool-prefix policy** — it's a pure schema validator. `enforceToolPrefix(manifest, { isBuiltIn })` is the explicit check, called by the host registry at load time. Built-ins call it with `isBuiltIn: true` (no-op); all modules from `~/.rn-dev/modules/` call with `isBuiltIn: false`.
- **`hostRange` check uses `semver.satisfies(hostVersion, range, { includePrerelease: true })`.** includePrerelease so `0.1.0-beta.1` hosts aren't locked out of `>=0.1.0` ranges. Tests verify `>=2.0.0` rejects `0.1.0`.
- **`loadUserGlobalModules` never throws** — all rejections are returned in `result.rejected[]` with a typed `code` + `message` (+ `schemaErrors[]` when applicable). This gives MCP / GUI a single stream of diagnostics without exception handling. Duplicate-registration collisions and synchronous directory errors are the only throws, and those are coding bugs, not user-data conditions.
- **`scope: "global"` pins `scopeUnit` to `"global"` regardless of the passed `scopeUnit`.** Per-worktree / workspace modules use the passed unit. Tested.

### SDK API surface (v0.1)

Exports from `@rn-dev/module-sdk`:
- `defineModule(manifest)` — throws `ModuleError(E_INVALID_MANIFEST)` on schema violation.
- `validateManifest(candidate)` → `{ valid: true, manifest } | { valid: false, errors: ManifestError[] }`.
- `enforceToolPrefix(manifest, { isBuiltIn })` — throws `ModuleError(E_TOOL_NAME_UNPREFIXED)` on first offender.
- `ModuleError` class + `ModuleErrorCode` enum.
- Types: `ModuleManifest`, `ModuleScope`, `ModuleContributions`, `McpToolContribution`, `ElectronPanelContribution`, `TuiViewContribution`, `ApiMethodContribution`, `UsesEntry`, `ModuleSignature`, `ModuleSandbox`, `ModuleTarget`.
- Host types: `HostApi`, `Logger`, `AppInfo`.
- `SDK_VERSION = "0.1.0"`.

### Host registry API additions (v0.1)

```ts
type ModuleActivationState = "inert" | "active" | "crashed" | "failed";

interface RegisteredModule {
  manifest: ModuleManifest;
  modulePath: string;       // absolute path of module root
  scopeUnit: string;        // "global" or worktreeKey
  state: ModuleActivationState;
  isBuiltIn: boolean;
}

interface LoadManifestsOptions {
  hostVersion: string;
  scopeUnit?: string;       // default "global"
  modulesDir?: string;      // default ~/.rn-dev/modules
}

interface LoadManifestsResult {
  modules: RegisteredModule[];
  rejected: RejectedManifest[];
}

class ModuleRegistry {
  // new
  static manifestKey(id: string, scopeUnit: string): string;
  loadUserGlobalModules(opts: LoadManifestsOptions): LoadManifestsResult;
  registerManifest(registered: RegisteredModule): void;
  unregisterManifest(id: string, scopeUnit: string): boolean;
  getManifest(id: string, scopeUnit: string): RegisteredModule | undefined;
  getAllManifests(): RegisteredModule[];
  // existing — unchanged
  register(module: RnDevModule): void;
  ...
}
```

---

## Deviations from the session prompt — explained

1. **Tests live at `src/modules/__tests__/registry.test.ts`, not `src/core/__tests__/module-registry.test.ts`.** The current registry file is `src/modules/registry.ts`; colocated tests belong in `src/modules/__tests__/`. The plan's original filename pointed to a future `src/core/module-registry.ts` location (see plan lines 104–111) that Phase 1 chose not to introduce yet (Phase 2 will create `src/core/module-host/`). Tests extend the existing file with new describe blocks for the new methods — pattern matches the session-prompt goal.
2. **Fixture location: `test/fixtures/minimal-module/` (per session prompt).** CLAUDE.md forbids a top-level `tests/` dir; `test/` (singular, for fixtures not tests) is distinct and matches the explicit session-prompt instruction. If the convention should be tightened, a future PR can move it under `src/modules/__tests__/fixtures/`.
3. **`E_INVALID_MANIFEST` + `E_HOST_RANGE_MISMATCH` added to the error enum.** The Revision Log list didn't include a "bad schema" code. Adding these is additive — existing codes unchanged.
4. **`isRnDevModule` loosening also required making `RnDevModule.component` optional** (type-level). `MainLayoutModule.component` mirrored. UI already guards with `ActiveComponent ?? null`, so TUI behavior is unchanged for any module that *does* have a component.

---

## Key decisions carried forward (must respect in Phase 2+)

All Phase 0 / 0.5 decisions still apply. Phase 1 adds:

- **Manifest format is frozen for 1.x as additive-only.** If you need to make a tool field required (e.g. demand `destructiveHint` always present), that's a 2.0 change, not a 1.x change.
- **Registry's `loadUserGlobalModules` is sync** (uses `readdirSync` / `readFileSync`). Phase 2's subprocess spawning will be async. If you need a parallel load path that `await`s network calls (marketplace Phase 6), introduce `loadUserGlobalModulesAsync` — don't retrofit the sync one.
- **`RegisteredModule.state` starts at `"inert"`.** Phase 2's `ModuleHostManager` transitions it to `"active"` / `"crashed"` / `"failed"`. Keep the state machine out of `ModuleRegistry` — registry knows only the current state; the manager owns transitions.
- **`modulePath` is the directory that contains `rn-dev-module.json`**, not the path to the JSON itself. Phase 2 spawns the module's entry from this directory.
- **Built-ins are exempt from `enforceToolPrefix`.** When Phase 3 refactors built-ins to adopt the manifest shape (`dev-space`, `metro-logs`, `lint-test`, `settings`, `devtools-network`, `marketplace`), their manifest-load path must pass `isBuiltIn: true`.

---

## What's next — Phase 2

Per the plan's Phase 2 section: **Subprocess module host + JSON-RPC protocol.**

### Recommended scope for the next PR

Branch from `main` **after** PRs #2 and this one merge. If stacking, branch from `feat/module-system-phase-1`.

#### Step 1 — `src/core/module-host/`

- `instance.ts` — per-subprocess state machine (`IDLE → SPAWNING → HANDSHAKING → ACTIVE → UPDATING → RESTARTING → CRASHED → FAILED → STOPPING → IDLE`). `FAILED` is terminal; `CRASHED` is transient.
- `rpc.ts` — `vscode-jsonrpc` v8 wrapper for stdio Content-Length framing.
- `supervisor.ts` — LSP-style restart policy (≥5 crashes in 3 min → `FAILED`).
- `lockfile.ts` — `~/.rn-dev/modules/<id>/.lock` for `global`-scope arbitration (PID + UID stamped, stale-detection).
- `manager.ts` — per-daemon `ModuleHostManager` (EventEmitter + scope-keyed Map, mirroring `MetroManager`/`DevToolsManager`). `acquire(consumerId)` / `release(consumerId)` refcounting + 60s idle-shutdown on `global` scope.
- `capabilities.ts` — host-side capability registry. `register(id, impl, requiredPermission?)` / `resolve<T>(id, grantedPermissions)`. SDK's `host.capability<T>(id)` forwards to this.
- Orphan prevention: process groups (POSIX) / Job Object (Windows).

#### Step 2 — Daemon process integration

- Per Revision Log: `ModuleHostManager` runs in the **long-lived daemon process** (same process as `MetroManager`/`DevToolsManager`), NOT Electron main. Electron main and MCP server are both clients over IPC. Verify the daemon process entry point — I did not touch that in Phase 1.

#### Step 3 — Tests

- `src/core/module-host/__tests__/instance.test.ts` — state machine transitions.
- `src/core/module-host/__tests__/supervisor.test.ts` — crash-loop detection.
- `src/core/module-host/__tests__/lockfile.test.ts` — global-scope arbitration.
- `test/fixtures/echo-module/` — fixture used across all three.

#### Step 4 — SDK `host-rpc.ts` transport wiring

The type surface is set. Phase 2 implements:
- How a module subprocess receives its `HostApi` at startup (handshake-provided JSON-RPC methods bundled into a proxy).
- How `host.capability<T>(id)` makes a JSON-RPC call to the host and returns typed result.
- Error code surfacing: `MODULE_UNAVAILABLE` / `MODULE_ACTIVATION_TIMEOUT` at the RPC boundary.

### Things to NOT do in Phase 2

- No MCP tool proxying yet (Phase 3).
- No Electron panel integration yet (Phase 4).
- No marketplace install flow (Phase 6).
- No device code (Phase 7+).

### Rough size estimate

Phase 2 is ~3–5 days. Subprocess framing + supervisor + lockfile + capability registry + integration tests is genuinely hard because of process-group / Job-Object concerns and crash-loop state machine testing.

---

## Open questions (carry over from Phase 0 handoff + new)

From Phase 0 handoff, still open:

1. Host ↔ module RPC protocol — vscode-jsonrpc is the plan choice; confirm on first spawn in Phase 2.
2. ServiceBus generalization (declaration-merge helper for `module:<id>:<topic>` topics).
3. SDK versioning policy — whether to auto-emit deprecation warnings when `hostRange` includes *pre-release* ranges the module author didn't intend.
4. Device mirror transport detail (Phase 7).
5. `electron/ipc/services.ts` is still 499 lines. Defer to pre-Phase-4.

New in Phase 1:

6. **Should `loadUserGlobalModules` treat a bad manifest as a REJECTION (current) or raise a `tools/listChanged`-like signal?** Phase 3 will answer — probably both: a rejected install causes a UI toast + marketplace surface surfaces the error. Current registry stays passive.
7. **Is `additionalProperties: false` at the schema root too strict?** It forbids forward-compat with host-side additions. Agents iterating on the schema during Phase 2–10 may want `additionalProperties: true` at the top level with targeted `unevaluatedProperties` or similar. Revisit if Phase 3 needs it.
8. **Host-version passing.** `loadUserGlobalModules` takes `hostVersion` explicitly. The daemon startup needs a single source of truth — probably reading `root package.json#version` at boot. Phase 2 should wire this.

---

## Environment notes

- Node ≥18; bun for install + build + dev; vitest for tests.
- Branch: `feat/module-system-phase-1`, stacked on `feat/module-system-phase-0` (PR #2).
- `.claude/` still gitignored (superpowers worktree state).
