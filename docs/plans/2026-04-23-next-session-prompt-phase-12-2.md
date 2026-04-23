# Next-Session Prompt — Module System Phase 12.2 (Bootstrap Surface Bundle)

**Paste the block below at the start of the next session.**

---

We're continuing the module system for rn-dev-cli. **Phase 12.1
extractFilter collapse shipped** in [PR #12](https://github.com/utopyk/rn-dev-cli/pull/12)
(squash-merged to `main` on 2026-04-23 as `e104e0e`).

**Phase 12.2 consolidates four convergent reviewer findings** into
one coherent "module author ergonomics" PR. Each item has been
flagged by at least one reviewer across PRs #11 and #12; the bundle
narrative is "move the remaining module-bootstrap plumbing into the
SDK, and resolve the one remaining cross-boundary constant."

### Scope

**1. `loadModuleManifest(importMetaUrl: string): Promise<ModuleManifest>`**

Every module's `src/index.ts` carries the same `loadManifest` helper
(Architecture P2-A from PR #11):

```ts
async function loadManifest(entryDir: string): Promise<ModuleManifest> {
  const manifestPath = join(entryDir, "..", "rn-dev-module.json");
  const raw = await readFile(manifestPath, "utf-8");
  return JSON.parse(raw) as ModuleManifest;
}
```

Take `import.meta.url` instead of `entryDir` — hides the
`fileURLToPath` + `dirname` plumbing too.

**2. `isModuleEntry(importMetaUrl: string): boolean`**

Same triplicate across all three modules (Architecture P2-B from PR #11):

```ts
const invokedAsEntry =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
```

This encodes the Phase 10 P3-16 "canonical Node-ESM idiom" — it
should live in one place.

**3. `requireCapability<T>(ctx: ModuleToolContext, id: string, label: string): T`**

Two verbatim copies today in `tools.ts` (Architecture P2-A from PR #12):

```ts
function resolveCapability(ctx: ModuleToolContext): MetroLogsHostCapability {
  const cap = ctx.host.capability<MetroLogsHostCapability>(METRO_LOGS_CAPABILITY_ID);
  if (!cap) throw new Error("metro-logs capability unavailable");
  return cap;
}
```

The generic error message ("denied permission vs. missing capability
are indistinguishable") is a security property — library-enforcing
it is better than documentation-enforcing it.

**4. `MAX_LIST_LIMIT` deduplication (three copies)**

- `modules/metro-logs/src/tools.ts:33` — `export const MAX_LIST_LIMIT = 1000`
- `modules/devtools-network/src/tools.ts:29` — same
- `src/core/metro-logs/buffer.ts:29` — same

Simplicity P1 from PR #12 recommends pushing the cap to each module's
`rn-dev-module.json` `inputSchema.maximum`. That's the cleanest fix:
MCP validates upstream, `boundedInt` becomes single-defense-in-depth,
agents can read the bound from the manifest.

Alternative: elevate to SDK as `DEFAULT_LIST_LIMIT_RANGE = { min: 1, max: 1000 }`.

### Before writing any code

1. Read [docs/plans/2026-04-23-module-system-phase-12-1-extractfilter-collapse-handoff.md](2026-04-23-module-system-phase-12-1-extractfilter-collapse-handoff.md)
   — "Intentionally deferred" table.
2. Read [docs/plans/2026-04-23-module-system-phase-12-sdk-arg-narrowers-handoff.md](2026-04-23-module-system-phase-12-sdk-arg-narrowers-handoff.md)
   — Architecture P2-A/B provenance.
3. `git log origin/main --oneline -5` — confirm stacking on
   `e104e0e refactor(modules): Phase 12.1 — extractFilter double-validation collapse (#12)`.
4. Ask Martin whether `@rn-dev-modules` + `rn-tools.com` are ready
   (Phase 12 Option C unblocker).

### Branching

```bash
git checkout main
git pull
git checkout -b feat/module-system-phase-12-2-bootstrap-surface
```

### Work plan

**Commit 1 — SDK additions.**
- Add `packages/module-sdk/src/bootstrap.ts` (or extend `module-runtime.ts`)
  with `loadModuleManifest` + `isModuleEntry`.
- Add `requireCapability` to an appropriate SDK file. Decide: own
  file (`capability.ts`) or alongside existing `module-runtime.ts`?
  Suggestion: own file for semantic cohesion.
- Re-export from `packages/module-sdk/src/index.ts`.
- Unit tests at `packages/module-sdk/src/__tests__/bootstrap.test.ts`
  + `.../capability.test.ts`.

**Commit 2 — Module migrations.**
- `modules/{metro-logs,devtools-network,device-control}/src/index.ts`
  — replace local `loadManifest` / `invokedAsEntry` with SDK imports.
- `modules/{metro-logs,devtools-network}/src/tools.ts` — replace
  local `resolveCapability` with SDK import.

**Commit 3 — `MAX_LIST_LIMIT` resolution.**
- Decide: manifest `inputSchema.maximum` (Simplicity's pick) OR SDK
  constant. Recommend manifest — aligns with "manifest is source of
  truth" posture.
- If manifest: update `rn-dev-module.json` files, remove the local
  constants, keep `boundedInt(args, "limit", { min: 1, max: 1000 })`
  inline (the bound is now documented in the manifest + enforced
  client-side via MCP + module-side via boundedInt + host-side
  via `clampLimit` — the three layers agree via the manifest).

### Baselines to match or improve on (Phase 12.1 close state)

- vitest: **883 / 0**
- tsc root: **150** (pre-existing wizard errors)
- tsc electron: **0**
- tsc per-module: **0 / 0 / 0**
- `bun run build`: green
- `bun run typecheck`: green

### When done

1. Commit per logical unit.
2. Write `docs/plans/2026-04-??-module-system-phase-12-2-bootstrap-surface-handoff.md`.
3. Push, open PR, run parallel reviewers (Kieran TS + Architecture +
   Security + Simplicity), fix P0/P1, squash-merge.
4. Queue the next-session prompt. The remaining queued items after
   12.2 are:
   - **Phase 12 Option C** — npm publishing (blocked on Martin's DNS +
     `@rn-dev-modules` scope).
   - **Phase 13 D** — prototype-chain hardening across all narrowers
     (Security P2 follow-up from PR #11 + the `...filter` `__proto__`
     survival case closed incidentally by PR #12 — needs a pass
     across the remaining `args[key]` bracket-access surface).

### Remember

- `vitest run`, not `bun test`.
- `bun run build` + `bun run typecheck` for production verification.
- SDK `dist/` is gitignored, rebuilt by `vitest.global-setup.ts`.
- Every 3p tool wire name carries the `<moduleId>__` prefix.
- Manifest is `rn-dev-module.json` at package root (not
  `package.json#rn-dev`).
- `config-set` audit entries record patch *keys*, never *values*.
- S6 warning is regex-gated (Phase 10 P2-A).
- The security property behind `requireCapability`'s generic
  `"${label} capability unavailable"` message: denied permission vs.
  missing capability must not be distinguishable to the caller.
  Preserve this when extracting.
