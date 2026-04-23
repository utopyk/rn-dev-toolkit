# Next-Session Prompt — Module System Phase 10 (reviewer cleanup bundle)

**Paste the block below at the start of the next session.**

---

We're continuing the module system for rn-dev-cli. **Phase 9 shipped in
PR [#8](https://github.com/utopyk/rn-dev-cli/pull/8) (squash-merged to
`main` on 2026-04-23 as commit `241b482`).** Phase 10 clears the
reviewer follow-ups parked across Phases 7 / 8 / 9 so the next major
phase lands on clean ground.

### Before writing any code

1. Read `docs/plans/2026-04-23-module-system-phase-9-handoff.md` —
   "Deferred items" is the Phase 10 punch list.
2. `git log origin/main --oneline -5` — confirm stacking on Phase 9's
   squash-merge.
3. Skim `src/core/audit-log.ts` (streaming `verify()` target),
   `src/modules/registry.ts` (`scanUserGlobalModules` split target), and
   `electron/` + `tsconfig.json` (tsc gap fix).

### Branching

```bash
git checkout main
git pull
git checkout -b feat/module-system-phase-10-cleanup
```

Target < 2000 line insertions — most of these are small refactors.

### Phase 10 scope (reviewer cleanup bundle)

**P1 / high-value:**

1. **Electron tsc gap fix** (Security P1 from Phase 8). Either extend
   the root `tsconfig.json` `include` to cover `electron/`, or create
   `electron/tsconfig.json` with its own CI step. Document in
   `memory/project_electron_tsc_gap.md` that the gap is closed. This
   is the highest-leverage fix — two P0s have slipped through it in
   two consecutive phases.
2. **Module-scoped tsc into CI** (Kieran P0 #1 preventive). Add
   `bun x tsc --noEmit -p modules/device-control/tsconfig.json` and
   `... modules/devtools-network/tsconfig.json` to whichever CI script
   runs `tsc --noEmit` today. Avoid repeating the Phase 9 near-miss
   where the module source had 2 strict-tsc errors the root check
   never saw.
3. **Agent discoverability meta-tool** (Arch P1-1 from Phase 9). Add
   `rn-dev/modules-available` that reads `docs/fixtures/modules.json`
   (or the live registry cache) and returns `{ installed: boolean, …}`
   per entry. Agents searching for "network" tools but not finding any
   then have a clear path: call `modules-available`, see
   `devtools-network` is installable, call `modules-install`.
4. **Streaming `verify()` in `AuditLog`** (Kieran TS P1 from Phase 8).
   Replace the whole-file read with a `createReadStream` + `readline`
   pipeline. Keep the existing return shape `{ ok, failedAt, reason }`.
   Add a test with a 100k-entry log to prove memory stays bounded.
5. **`scanUserGlobalModules` static-vs-instance split** (Arch P1 from
   Phase 8). Either pure function `scanManifests(opts)` +
   `registry.applyScan(result)`, or `registry.scan()` +
   `registry.applyScan()` instance pair. Pick the cleaner of the two
   and update `loadUserGlobalModules` + `rescanAction` to compose.
6. **`applyManifestChange(opts, { kind, … })` helper** (Arch P2 from
   Phase 8). Dedup the register/unregister + event-emission pattern
   across `rescanAction` / `installAction` / `uninstallAction` in
   `src/app/modules-ipc.ts`.

**P2 / medium-value:**

7. **`devtools:capture` read/mutate permission split** (Arch P2-1 from
   Phase 9). Introduce `devtools:capture:read` (list/get/status) and
   `devtools:capture:mutate` (clear/selectTarget). Update
   `createDevtoolsHostCapability` so each method checks the right
   permission via a second-level guard. Update
   `modules/devtools-network/rn-dev-module.json permissions[]` to
   declare both. Grace-period: keep `devtools:capture` as an alias
   that grants both for one minor version, with a deprecation warning.
8. **Cycle guard in `canonicalize`** (Kieran P3 from Phase 8). Throw
   with a clear error when the input has a self-reference instead of
   RangeError on stack overflow.
9. **`resolveAppId(adapter, args)` extraction** (Simplicity P1-5 from
   Phase 7). Shared between `launchApp` + `uninstallApp` in
   `modules/device-control/src/tools.ts`.
10. **`modules/device-control/src/index.ts` cast cleanup** (Kieran TS
    P2-4 from Phase 7). Replace `args as Parameters<typeof fn>[0]`
    with typed wrappers à la the Phase 9 `toListArgs` / `toGetArgs`
    pattern in `modules/devtools-network/src/index.ts`.
11. **Permission allowlist warning** (Security P2-1 from Phase 9).
    Maintain a `KNOWN_PERMISSIONS: ReadonlyArray<string>` in
    `src/core/module-host/capabilities.ts`; emit a console warning at
    `register()` time when a capability's `requiredPermission` isn't
    on the list. Similar warning at manifest-load time for
    `permissions[]` entries that no capability uses (typo detector).
12. **S6-warning lint on sensitive-permission modules** (Security P2-3
    from Phase 9). Add a host-side check at manifest-load time that
    every tool on a `devtools:capture*` / `exec:adb` / `exec:simctl`
    module includes the canonical prompt-injection warning substring in
    its `description`. Reject manifests that don't comply.

**P3 / nice-to-have:**

13. **`registerHostCapabilities(capabilities, deps)` extraction**
    (Kieran P2 #10 from Phase 9) — pull capability-registration block
    out of `startServicesAsync`.
14. **`module-commands.ts` cast cleanup** (Kieran P2 from Phase 8) —
    `reply.payload as {...}` helper if ≥5 duplicates.
15. **Drop `modules/devtools-network/panel/panel.js escapeHtml`** in
    favor of DOM-builder style (Simplicity P3 from Phase 9).
16. **`index.ts:38` regex entry-gate** → `import.meta.main` canonical
    ESM idiom (Kieran P2 #11 from Phase 9). Applies to both
    `modules/device-control/src/index.ts` and
    `modules/devtools-network/src/index.ts`.

### Do NOT do (Phase 10 deferred)

- **Second built-in → 3p extraction (Metro Logs).** Defer to Phase 11.
  Would expand review surface; keeps Phase 10 focused on cleanup.
- **Shared `@rn-dev/module-sdk-devtools` types package.** Triggers when
  a second devtools-* module lands, which isn't queued yet.
- **`keepData` retention + GC sweep.** Still its own PR.
- **Detached Ed25519 signature verification** of `modules.json`.
- **Publishing to real npm.** Separate ops task.

### Baselines

- vitest: **786+ / 0**
- tsc root: **150**
- tsc renderer: **1**
- tsc per-module: **0** (devtools-network), **0** (device-control — to
  verify)
- `bun run build`: green

### When done

1. Commit per logical unit (Electron tsc gap + module tsc into CI = one
   commit; streaming verify = another; agent discoverability = another;
   etc.). Squash at merge so the final commit message can summarize.
2. Write `docs/plans/2026-04-??-module-system-phase-10-handoff.md`.
3. Push, open PR, run parallel reviewers (Kieran TS + Architecture +
   Security + Simplicity — same as Phase 9), fix P0/P1, squash-merge.
4. Ask Martin whether Phase 11 (second built-in → 3p: Metro Logs) is
   next, or pivot to publishing `@rn-dev-modules/*` to real npm and
   baking the first production `EXPECTED_MODULES_JSON_SHA256`.

Remember:

- `vitest run`, not `bun test`.
- `bun run build` for production verification.
- `.claude/` is gitignored.
- SDK `dist/` is gitignored; `vitest.global-setup.ts` rebuilds it.
- Every 3p tool wire name carries the `<moduleId>__` prefix.
- `rn-dev/modules-config-set` is `destructiveHint` — keep it that way.
- `config-set` audit entries record patch *keys*, never *values*.
