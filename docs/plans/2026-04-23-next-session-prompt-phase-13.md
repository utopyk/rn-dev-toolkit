# Next-Session Prompt — Module System Phase 13 (or Phase 12 continuations)

**Paste the block below at the start of the next session.**

---

We're continuing the module system for rn-dev-cli. **Phase 12 SDK
arg-narrowers shipped** in [PR #11](https://github.com/utopyk/rn-dev-cli/pull/11)
(squash-merged to `main` on 2026-04-23 as `8b3f54f`). The extraction
promoted six arg-narrower primitives (`str`, `num`, `strArr`,
`requireStr`, `requireNum`, `ringCursor` + the `Args` type) out of the
three modules and into `packages/module-sdk/src/args.ts`. Net `-65`
LoC across the modules.

**Phase 12 Option C (npm publishing)** is still partially queued — blocked
on external setup. Below are four candidates; pick based on what's
unblocked and what's most pressing.

### Option A — Phase 12 Option C (npm publishing) — requires Martin's setup

Unblocks if:
1. `@rn-dev-modules` scope exists on npmjs.org.
2. `rn-tools.com` DNS is live with a static host serving `modules.json`.
3. Version decision made (publish at `0.1.0` or cut a pre-release first).

Full steps documented in
[docs/plans/2026-04-23-next-session-prompt-phase-12.md](2026-04-23-next-session-prompt-phase-12.md)
under "If Option C (npm publishing)". No code changes since Phase 12
— that prompt is still accurate.

### Option B — Phase 12.1 — `extractFilter` double-validation collapse

**Out-of-scope finding from Phase 12's Kieran TS + Simplicity reviewers.**
Each module's `tools.ts::extractFilter` re-runs validation on data that
`index.ts::toXArgs` already narrowed — `isCursor`, `Array.isArray +
.filter(typeof === "string")`, etc. That redundancy was correct before
Phase 12 (when `toXArgs` forwarded raw `Args`), now it's dead weight.

**Scope:**
1. Add `boundedInt(args, key, {min, max})` to
   `packages/module-sdk/src/args.ts` — the one narrowing `extractFilter`
   does that `toXArgs` doesn't (integer + positive + `<= MAX_LIMIT`).
2. Update `metro-logs` + `devtools-network` `toListArgs` to use
   `boundedInt(args, "limit", {min: 1, max: MAX_LIMIT})` instead of
   `num(args, "limit")`.
3. Delete `extractFilter` from both modules' `tools.ts` — the typed
   `ListArgs` IS the filter.
4. Verify `modules/**/src/tools.ts` handlers now receive already-narrowed
   data and pass it straight to the capability.

Estimated net LoC: `-50` across the two modules. No behavior change —
both layers narrow identically today.

**Files:**
- `modules/metro-logs/src/tools.ts:41-76` (`isCursor`, `isStream`,
  `extractFilter`).
- `modules/devtools-network/src/tools.ts:51-93` (`isCursor`,
  `extractFilter`).
- `modules/metro-logs/src/index.ts::toListArgs`.
- `modules/devtools-network/src/index.ts::toListArgs`.
- `packages/module-sdk/src/args.ts` — add `boundedInt`.

### Option C — Phase 12.2 — `loadManifest` + `invokedAsEntry` SDK extraction

**Architecture reviewer P2-A/B from Phase 12.** Each module's `index.ts`
carries two verbatim triplicates that are NOT wire narrowers:

```ts
// invokedAsEntry — identical in all three modules, comment and all
const invokedAsEntry =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

// loadManifest — identical in all three modules
async function loadManifest(entryDir: string): Promise<ModuleManifest> {
  const manifestPath = join(entryDir, "..", "rn-dev-module.json");
  const raw = await readFile(manifestPath, "utf-8");
  return JSON.parse(raw) as ModuleManifest;
}
```

**Scope:**
1. Add to `packages/module-sdk/src/`:
   - `isModuleEntry(importMetaUrl: string): boolean` — wraps the
     `process.argv` comparison.
   - `loadModuleManifest(importMetaUrl: string): Promise<ModuleManifest>`
     — takes `import.meta.url` (not `entryDir`) so the SDK owns the
     `fileURLToPath` + `dirname` plumbing.
2. Re-export from `index.ts`.
3. Migrate all three modules to use them.
4. Unit tests at `packages/module-sdk/src/__tests__/entry.test.ts` for
   the entry-gate logic (process.argv edge cases).

Estimated net LoC: `-30` across the three modules + `+50` in SDK (docs +
tests make this net-positive on LoC but net-negative on surface area
3p authors have to understand).

### Option D — Phase 13 — Security P2 prototype-chain hardening

**Security reviewer P2 from Phase 12.** All six SDK narrowers use
`args[key]` bracket access which walks `Object.prototype`. Not
wire-reachable today (`JSON.parse` rejects `__proto__`), but a latent
amplifier if subprocess-local code ever pollutes `Object.prototype`.
Follow-up task chip was already spawned — this would claim it.

**Scope:**
1. Gate every `args[key]` read in `packages/module-sdk/src/args.ts` with
   `Object.prototype.hasOwnProperty.call(args, key)` first.
2. In `ringCursor`, gate `c.bufferEpoch` / `c.sequence` the same way.
3. Apply the same fix to pre-existing `isCursor` helpers:
   - `modules/metro-logs/src/tools.ts:41-50`
   - `modules/devtools-network/src/tools.ts:51-60`
4. Add tests covering polluted-prototype + getter-bearing class instances.

Symmetric with Phase 10's `isCapabilityMethod` chain-walk fix at
`src/core/module-host/host-rpc.ts:29-39`.

### Before writing any code

1. Read [docs/plans/2026-04-23-module-system-phase-12-sdk-arg-narrowers-handoff.md](2026-04-23-module-system-phase-12-sdk-arg-narrowers-handoff.md)
   — "Intentionally deferred" table.
2. `git log origin/main --oneline -5` — confirm stacking on
   `8b3f54f feat(modules): Phase 12 — SDK arg-narrowers extraction`.
3. Ask Martin whether `@rn-dev-modules` + `rn-tools.com` are ready (to
   decide Option A eligibility).

### Branching

```bash
git checkout main
git pull
git checkout -b feat/module-system-<phase>-<slug>
```

### Baselines to match or improve on (Phase 12 close state)

- vitest: **873 / 0**
- tsc root: **150** (pre-existing wizard errors)
- tsc electron: **0**
- tsc per-module: **0 / 0 / 0**
- `bun run build`: green
- `bun run typecheck`: green

### When done

1. Commit per logical unit (extraction, migration, verify).
2. Write `docs/plans/2026-04-??-<phase>-handoff.md`.
3. Push, open PR, run parallel reviewers (Kieran TS + Architecture +
   Security + Simplicity), fix P0/P1, squash-merge.
4. Queue the next-session prompt; ask Martin which of the remaining
   candidates to tackle next.

### Remember

- `vitest run`, not `bun test`.
- `bun run build` + `bun run typecheck` for production verification.
- `.claude/` is gitignored; SDK `dist/` is gitignored and rebuilt by
  `vitest.global-setup.ts`.
- Every 3p tool wire name carries the `<moduleId>__` prefix.
- `rn-dev/modules-config-set` is `destructiveHint`.
- `config-set` audit entries record patch *keys*, never *values*.
- S6 warning is regex-gated (Phase 10 P2-A).
- `SENSITIVE_PERMISSION_PREFIXES` currently holds `metro-logs`;
  widen the S7 startup-banner wording if a new family gets added.
