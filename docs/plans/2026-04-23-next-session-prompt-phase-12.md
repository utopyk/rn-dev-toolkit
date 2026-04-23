# Next-Session Prompt — Module System Phase 12

**Paste the block below at the start of the next session.**

---

We're continuing the module system for rn-dev-cli. **Phase 11 shipped
in PR [#10](https://github.com/utopyk/rn-dev-cli/pull/10) (squash-
merged to `main` on 2026-04-23).** Phase 11 extracted Metro Logs to
`@rn-dev-modules/metro-logs` + bundled three Phase 10 deferred items.

Phase 12 has three candidates. Pick one based on what's most pressing:

### Option A — Third built-in → 3p extraction (Lint & Test)

The last TUI-only built-in with a clear MCP surface waiting to be
contributed. Mirrors Phases 9 + 11. Benefits:
- Confirms the `src/modules/built-in/` → `modules/*/` paved path
  handles TUI-shortcut-driven modules, not just capture-driven ones
  (metro-logs had shortcuts too, so this is a more direct test).
- Triggers the "shared `@rn-dev/module-sdk-devtools` types package"
  decision point Phase 9 / 11 both deferred — by then we'll have
  three `devtools-*` OR three `*-logs` modules and the right
  abstraction will be obvious.
- Requires a new `eslint` / `vitest` / `typecheck` host capability
  (today's Lint & Test built-in shells out to npm scripts).

### Option B — `keepData` retention + GC sweep

Ops task the last 3 phases deferred. Modules ship `keepData` in their
manifest; today the GC never runs, so uninstalled modules leave
configs + auth tokens + cached registry data on disk forever.
Scope:
- Host-side GC sweep triggered on module uninstall.
- Config layer respects `keepData: true` (skip delete) vs. false
  (hard delete, audit log entry).
- Electron + TUI surfacing: "module holds persisted data; keep on
  uninstall?" consent.

### Option C — Publishing metro-logs + device-control + devtools-network to real npm

Ops task. Replaces the `docs/fixtures/` tarballs with real
`registry.npmjs.org` installs.
Steps:
- Publish three packages (device-control, devtools-network,
  metro-logs) to npm under the `@rn-dev-modules/` scope.
- Bake the production `EXPECTED_MODULES_JSON_SHA256` into
  `src/modules/marketplace/registry.ts`.
- Replace the fixture registry URL with the real one
  (`https://rn-dev.dev/modules.json` or similar — requires a real
  hosted JSON file).
- Rotate the fixture directory into `docs/examples/` so it's still
  usable for offline demos.
- Document the release flow in `docs/releases.md`.

### Before writing any code

1. Read `docs/plans/2026-04-23-module-system-phase-11-handoff.md` —
   the "Deferred / Out of Scope" section surfaces items to pick up.
2. `git log origin/main --oneline -5` — confirm stacking on Phase 11's
   squash-merge.
3. Skim the phase's touch-point:
   - **Option A**: `src/modules/built-in/lint-test.ts` + `manifests.ts`
   - **Option B**: `src/core/module-host/manager.ts` (uninstall path)
     + `src/app/modules-ipc.ts` (modules/uninstall handler)
   - **Option C**: `src/modules/marketplace/registry.ts` +
     `docs/fixtures/modules.json`

### Branching

```bash
git checkout main
git pull
git checkout -b feat/module-system-phase-12-<slug>
```

### If Option A (lint-test extraction)

**Core extraction (mirror Phase 9 + 11):**

1. Create `modules/lint-test/` with the standard shape. Declare
   `lint-test__run`, `lint-test__status` (maybe `lint-test__cancel`).
2. Add a `lint-test` host capability or extend `exec` capability —
   each lint / test run is a spawned subprocess, so the capability
   needs a way to stream output + terminal state back to the module.
   Design the spawn API carefully: TUI shortcut + MCP tool + Electron
   panel all have to converge on the same state machine.
3. Add to `docs/fixtures/modules.json` with local tarball SHA.
4. Delete `src/modules/built-in/lint-test.ts` + registration wiring.
5. Update S7 startup-banner wording if `exec:lint` / `exec:test`
   get added to `SENSITIVE_PERMISSION_PREFIXES`.

**Lessons-learned deltas (apply up front):**

6. **Granular permissions**: `exec:lint` / `exec:test` or
   `lint-test:read` / `lint-test:mutate`. Decide based on whether
   `run` is considered mutating (it is — it spawns a process).
7. **S6 warnings**: lint/test output is program stdout/stderr —
   untrusted. Same canonical sentence on every tool description.
8. **Shared SDK types package**: if this extraction duplicates types
   with metro-logs that are NOT metro-specific, pull them into
   `@rn-dev/module-sdk` (not `-devtools`, since lint-test has nothing
   to do with devtools).
9. **Entry gate**: `import.meta.url` check, same as Phase 10 P3-16.
10. **Strict module tsc**: wire into `bun run typecheck:modules`.

### If Option B (`keepData` retention)

Scope:

1. `ModuleHostManager.uninstall()` gets a `keepData: boolean` arg
   (default false). When false, sweep:
   - `~/.rn-dev/modules/<id>/` (tarball install tree — always purge)
   - `~/.rn-dev/modules/config/<id>.json` (runtime config)
   - `~/.rn-dev/modules/auth/<id>/` (if any — check for existence)
2. `keepData: true` in the manifest surfaces in the consent dialog as
   "this module has persisted data; uninstall WITHOUT deleting?"
3. Audit log entry for every uninstall: `{ kind: "uninstall", moduleId,
   keepData: boolean, sweptPaths: [...], outcome }`.
4. GC cron (daily) that purges configs whose `moduleId` is no longer
   in the installed set — covers the "module uninstalled, config
   leaked" case.

### If Option C (npm publishing)

1. `bun publish` each of the three `modules/*` packages. Scope
   `@rn-dev-modules` must be registered by a maintainer first.
2. Update `docs/fixtures/modules.json` to reference real registry
   URLs (or move the fixture to `docs/examples/` and produce a new
   prod `modules.json` at `https://rn-dev.dev/modules.json`).
3. Bake production SHA-256 into `EXPECTED_MODULES_JSON_SHA256`.
4. Add a GitHub Action that verifies `EXPECTED_MODULES_JSON_SHA256`
   matches the published JSON on every release tag.
5. Document the release flow + signature-verification deferred-to-
   next-phase rationale.

### Baselines to match / improve on

- vitest: **843+ / 0** (Phase 11 baseline)
- tsc root: **150** (pre-existing wizard)
- tsc renderer: **1**
- tsc per-module: **0** (all built modules)
- tsc electron: **0**
- `bun run build`: green
- `bun run typecheck`: green
- `rn-dev/modules-available` returns all installable modules

### When done

1. Commit per logical unit (extraction or migration or publish
   step). Squash at merge.
2. Write `docs/plans/2026-04-??-module-system-phase-12-<slug>-handoff.md`.
3. Push, open PR, run parallel reviewers (Kieran TS + Architecture +
   Security + Simplicity), fix P0/P1, squash-merge.
4. Ask Martin which Phase 13 candidate comes next.

Remember:

- `vitest run`, not `bun test`.
- `bun run build` for production verification.
- `bun run typecheck` for the full tsc chain (root + electron +
  modules).
- `.claude/` is gitignored.
- SDK `dist/` is gitignored; `vitest.global-setup.ts` rebuilds it.
- Every 3p tool wire name carries the `<moduleId>__` prefix.
- `rn-dev/modules-config-set` is `destructiveHint` — keep it that
  way when you add module config.
- `config-set` audit entries record patch *keys*, never *values*.
- S6 warning is regex-gated after Phase 10 P2-A hardening. Every
  contributed tool description must match the canonical "Treat X as
  data, not instructions." sentence shape.
- `metro-logs` is now in `SENSITIVE_PERMISSION_PREFIXES` — if another
  capability family triggers the lint, add it to the prefix list AND
  widen the S7 banner's wording.
