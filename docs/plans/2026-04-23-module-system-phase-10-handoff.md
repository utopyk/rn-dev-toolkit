# Module System Phase 10 — Reviewer Cleanup Bundle — Handoff

**Branch:** `feat/module-system-phase-10-cleanup`
**Target:** `main` (will stack on Phase 9's squash-merge `241b482`)
**Scope:** Reviewer follow-ups parked across Phases 7 / 8 / 9. No
second built-in → 3p extraction — that stays in Phase 11.

---

## Summary

Cleared 15 of the 16 reviewer follow-ups queued in the Phase 9 handoff.
One was skipped with rationale (see Deferred).

| # | Priority | Title | Commit |
|---|---|---|---|
| P1-1 | P1 | Electron tsc gap fix | 142245f |
| P1-2 | P1 | Module-scoped tsc into CI | 142245f |
| P1-3 | P1 | `rn-dev/modules-available` meta-tool | 0f395eb |
| P1-4 | P1 | Streaming `verify()` in `AuditLog` | 734d738 |
| P1-5 | P1 | `scanUserGlobalModules` static-vs-instance split | f2df5dc |
| P1-6 | P1 | `applyManifestChange` helper dedup | 229e590 |
| P2-7 | P2 | `devtools:capture` → `:read` + `:mutate` split | d4cc099 |
| P2-8 | P2 | Cycle guard in `canonicalize()` | 18b7ce6 |
| P2-9 | P2 | `resolveAppId` helper extraction | f8b2279 |
| P2-10 | P2 | device-control cast cleanup (typed arg wrappers) | f8b2279 |
| P2-11 | P2 | Permission allowlist warning | 22e70e1 |
| P2-12 | P2 | S6-warning lint on sensitive-permission modules | ec7d29c |
| P3-13 | P3 | `registerHostCapabilities` extraction | d8424ee |
| P3-14 | P3 | `module-commands.ts` cast cleanup | skipped |
| P3-15 | P3 | Drop `panel.js` `escapeHtml` for DOM builders | 08f2c6c |
| P3-16 | P3 | `import.meta`-url entry gate | 268ed64 |

### Stats

- 13 commits, 24 files, +1,567 / -207
- 0 new public APIs removed / retired
- 1 new MCP tool: `rn-dev/modules-available`
- 1 new error code: `HOST_METHOD_DENIED` (per-method permission gate)
- 2 new granular permissions: `devtools:capture:read`,
  `devtools:capture:mutate` (old umbrella `devtools:capture` stays
  valid for the grace period)

---

## Baselines (all preserved or improved)

- **vitest:** 811 / 0 failed (was 786 before this branch; +25)
- **root tsc `--noEmit`:** 150 errors (unchanged baseline)
- **electron tsc:** 0 errors — **NEW, was uncovered**
- **device-control tsc:** 0 errors (confirmed)
- **devtools-network tsc:** 0 errors (preserved)
- **`bun run build`:** green

`bun run typecheck` now chains all four tsc projects so CI has a
single entry point and the Electron-tsc-gap regression that landed two
P0s in Phases 8/9 cannot recur.

---

## Per-task details

### P1-1 — Electron tsc gap fix
New `electron/tsconfig.json` (strict, noEmit, `include: ["./**/*.ts"]`)
scopes tsc to the electron tree. Caught one real bug in passing:
`InstanceState.mode` was `string` while downstream code assigned it to
`Profile.mode: RunMode` — tightened to `RunMode`.

Also fixed the `ajv/dist/2020.js` default-import in the SDK so that
`moduleResolution: NodeNext` consumers (modules/*) typecheck cleanly
alongside the SDK's own `moduleResolution: bundler` build.

Memory file `project_electron_tsc_gap.md` updated to reflect the closed
gap.

### P1-2 — Module-scoped tsc into CI
`package.json` gained `typecheck` (chains all four), plus
`typecheck:electron` and `typecheck:modules` for targeted runs.

### P1-3 — `rn-dev/modules-available` discoverability
Read-only wrapper over `marketplace/list` surfaced as MCP tool. Returns
one entry per module with `{ id, description, permissions, installed,
installedVersion, installedState }`, plus `filter` (case-insensitive
substring on id+description) and `installedOnly` knobs. Tool count 30 → 31.
5 new handler tests; the `ToolResult` type is now exported from
`src/mcp/tools.ts` so tests don't need to duplicate the shape cast.

### P1-4 — Streaming `verify()` in `AuditLog`
`verify()` is now async (was sync). Uses `createReadStream` +
`readline` so peak memory stays bounded on multi-hundred-MB logs. API
shape unchanged — callers `await` instead of calling directly. New
regression test: 100k-entry log verifies cleanly with RSS delta
< 500 MiB.

### P1-5 — scan-vs-apply split on the registry
Added instance method `applyScan(scan: LoadManifestsResult)`. Pure
`ModuleRegistry.scanUserGlobalModules()` + `applyScan()` compose into
the existing `loadUserGlobalModules()` one-liner. Opens the door for
callers that produce manifests other ways (fixtures, cross-worktree
scans) to reuse the apply logic. 3 new tests covering the split.

### P1-6 — `applyManifestChange` helper
Extracted the add/update/remove branches of `rescanAction` into a
discriminated-union helper `applyManifestChange(opts, { kind, … })`.
`rescanAction`'s body is now a straight-line diff loop.
install/uninstall actions deliberately don't route through it — they
delegate the filesystem + register/unregister to installer/uninstaller
and only emit events, so `applyManifestChange` would double-register.

### P2-7 — `devtools:capture` → `:read` + `:mutate`
`CapabilityRegistry.register()` now accepts a `methodPermissions:
Record<string, string>` map. Baseline `requiredPermission` still gates
`resolve()`; per-method overrides are checked by a new
`requiredPermissionForMethod()` that `host-rpc` uses after resolving
the impl. Denied methods reject with new code `HOST_METHOD_DENIED` and
an error message naming the specific permission the module needs.

Grace period: `devtools:capture` still grants both granular
permissions at `host/call` time via an alias expansion in `host-rpc`,
with a one-time-per-module deprecation warning. Registry itself stores
only the granular names.

`modules/devtools-network/rn-dev-module.json` now declares both
granular permissions directly. The `SENSITIVE_PERMS` startup-banner
set was extended to include both.

### P2-8 — Cycle guard in `canonicalize()`
WeakSet-based cycle detector throws `AuditCanonicalizationError`
(exported) on self-references rather than exploding with `RangeError:
Maximum call stack size exceeded`. `_canonicalizeForTests` re-export
makes the guard exercisable without routing through `append()` (which
TypeScript wouldn't let pass a cyclic input anyway).

### P2-9 / P2-10 — device-control helpers + typed wrappers
- `resolveAppId(adapter, args, toolName)` dedups the Android /
  applicationId vs. iOS / bundleId dance shared by `launchApp` +
  `uninstallApp`.
- Replaced the `args as Parameters<typeof fn>[0]` casts in
  `modules/device-control/src/index.ts` with `toXArgs(args)` narrowers
  (same pattern as Phase 9 devtools-network). Exports the arg
  interfaces (`ScreenshotArgs`, `TapArgs`, `SwipeArgs`, `TypeTextArgs`,
  `LaunchAppArgs`, `LogsTailArgs`, `InstallApkArgs`, `UninstallAppArgs`)
  from `tools.ts` so the narrowers can name them.

### P2-11 — Permission allowlist warning
New `KNOWN_PERMISSIONS` canonical list in
`src/core/module-host/capabilities.ts` + `warnIfUnknownPermission()`
helper (dedups per context+permission). Wired into two sites:

- `CapabilityRegistry.register()` — capability-side: catches typos in
  `requiredPermission` and any `methodPermissions` values.
- `ModuleRegistry.loadSingleManifest()` — module-side: scans 3p
  manifest `permissions[]` at load time.

Advisory only — v1 permissions aren't enforced by the host; this is a
lint, not a gate. Built-ins skipped.

### P2-12 — S6-warning lint on sensitive modules
Non-built-in manifests that hold any
`devtools:capture*` / `exec:adb` / `exec:simctl` permission are
rejected (`E_INVALID_MANIFEST`) at `loadSingleManifest()` time if any
contributed tool description misses the canonical substring
`"as data, not instructions"`. Error message lists which tools failed
+ the expected substring.

`modules/device-control/rn-dev-module.json` updated so every tool
carries the warning (phrased per surface — logs, screenshots, UI
responses — while keeping the canonical substring in every description).
Without the manifest update the module would have been rejected by its
own host after the lint landed.

Exported constant: `S6_WARNING_SUBSTRING`.

### P3-13 — `registerHostCapabilities` extraction
`startServicesAsync` had grown three inline `capabilities.register()`
calls with their own `requiredPermission` / `methodPermissions`
options. Extracted into `registerHostCapabilities({ metro, artifactStore,
devtools, worktreeKey })` + a `HostCapabilityDeps` interface.
`startServicesAsync` is now one line here where it was eighteen.

### P3-15 — panel.js DOM builders
Replaced the three `innerHTML` sites with `createElement` /
`textContent` (escape-by-construction) + tiny factory helpers
`labelSpan()` / `valueSpan()`. Removed the `escapeHtml()` function
outright — the escape is now the DOM API itself.

### P3-16 — ESM canonical entry gate
Both 3p modules replaced the fragile
`/devtools-network[\\/](dist|src)[\\/]index\.(js|ts)$/` regex-on-argv[1]
with `import.meta.url === pathToFileURL(process.argv[1]).href`.
Location-independent and exact; the old pattern would silently refuse
to boot if the module got relocated (e.g. under a pnpm hoisted layout).

---

## Deferred

### P3-14 — `module-commands.ts` cast cleanup
**Skipped by scope.** The plan said "if ≥5 duplicates" of the same
`reply.payload as {...}` shape. Actual shapes in
`src/cli/module-commands.ts`:
- `{ status?: string; error?: string }` — 2×
- `{ status?: string; pid?: number; error?: string }` — 1×
- `{ modules?: Array<Record<string, unknown>> }` — 1×
- Multi-field install/uninstall reply — 2× (`InstallReplyShape` /
  `UninstallReplyShape` — already typed)

No single shape hit the 5× threshold. A generic `payloadAs<T>(reply)`
helper would save one `.payload` keystroke per site, not justifying
the churn. Documenting the skip so the reviewer knows it was a
deliberate read.

---

## Follow-ups queued for Phase 11

From the Phase 9 handoff's "Do NOT do" list, still queued:

- **Second built-in → 3p extraction (Metro Logs).** Natural next phase
  — the first extraction (devtools-network, Phase 9) + this cleanup
  round together give us the paved path.
- **Shared `@rn-dev/module-sdk-devtools` types package.** Triggers
  when a second `devtools-*` module lands, which isn't queued.
- **`keepData` retention + GC sweep.** Own PR.
- **Detached Ed25519 signature verification of `modules.json`.**
- **Publishing to real npm + baking the first production
  `EXPECTED_MODULES_JSON_SHA256`.**

One new follow-up discovered during Phase 10:

- **Memory file `project_electron_tsc_gap.md`** — consider archiving
  once Phase 10 merges and the gap has stayed closed for two consecutive
  phases. Keeping it as history is fine either way.

---

## Review focus

Four parallel reviewers (Kieran TS, Architecture, Security,
Simplicity) will catch most issues. If they parallelize differently:

- **Security** should focus on P2-7 (grace-period alias expansion —
  can anything besides `devtools:capture` unexpectedly widen?),
  P2-11 (KNOWN_PERMISSIONS list — are any real permissions missing?),
  and P2-12 (rejection gate — is the canonical substring chosen
  narrowly enough that a benign description won't ever contain it?).
- **Architecture** should focus on P1-5 (is `applyScan` the right
  seam — should `rescanAction` compose through it too?) and P1-6
  (discriminated union `ManifestChange` — any fourth kind coming?).
- **Kieran TS** should focus on P1-4 (async/await propagation through
  the 6 call sites), P2-9/P2-10 (the narrower helpers — could they
  be generated from the JSON Schema instead?).
- **Simplicity** should focus on P3-13 (is the `HostCapabilityDeps`
  interface pulling its weight?), P3-15 (DOM builder approach vs.
  alternatives).
