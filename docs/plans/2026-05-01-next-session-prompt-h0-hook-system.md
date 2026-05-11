---
title: Next-session prompt — Hook system Phase H0
type: handoff
status: active
date: 2026-05-01
plan: docs/plans/2026-04-30-feat-hook-system-plan.md
---

# Next-session prompt — Hook System Phase H0

Copy-paste the section below into a fresh Claude Code session to start H0.

---

## Self-contained prompt for next session

You are picking up the rn-dev-cli hook system implementation. The plan is approved and implementation-ready. Your job this session is **Phase H0 — manifest schema additions, `@rn-dev/config` package, `rn-dev config init` scaffolder, error catalog, and lockstep CI check.** No daemon integration yet; this phase is types + schema + scaffolder.

### Read these in order before writing code

1. **The plan:** [docs/plans/2026-04-30-feat-hook-system-plan.md](docs/plans/2026-04-30-feat-hook-system-plan.md) — full design. Skim the Enhancement Summary at the top for the showstoppers + cuts; read §"Phase H0" in detail; reference §"Architecture" and §"Performance Budget" as needed.
2. **The brainstorm origin:** [docs/brainstorms/2026-04-29-acme-dev-cli-research.md](docs/brainstorms/2026-04-29-acme-dev-cli-research.md) §6 — motivation + the acme-feature-to-hook mapping. Don't re-derive; just use as context.
3. **CLAUDE.md** at repo root — verification standard, ESM/NodeNext rules, no-`any`-no-`unknown` discipline, colocated tests.
4. **Existing parallel work:** [packages/module-sdk/](../../packages/module-sdk/) is the precedent for the new `packages/config/` workspace. Mirror its structure (`package.json`, `tsconfig.json`, `src/`, `manifest.schema.json` analog).

### Settled architectural decisions (do NOT relitigate — see memory file `hook_system_plan.md`)

- **Per-module contribution points.** Hooks are tuples `(<module-id>, <hook-name>)`. NOT a fixed lifecycle enum. Each module declares `provides.hooks: string[]` and `consumes.hooks: Record<'<id>/<name>', HookEntry>`.
- **In-process for built-ins, subprocess for 3p.** Builder/Clean/Metro/DevTools/Preflight will become built-in-privileged in-process modules in H2/H3. H0 does NOT touch them.
- **Override slot hardcoded as `custom`.** No `provides.overrideHook?` configurability.
- **`session` module owns `session/init` + `session/profile-changed`.** `session/shutdown` deferred. (Module name is `session`, not `daemon-lifecycle`.)
- **No scope cuts.** All 7 H6 MCP tools, hook schema versioning, and `hooks-overrides` as separate tool are all in v1.

### H0 deliverables (from the plan)

#### `packages/config/` — new bun workspace

- `package.json`: `"name": "@rn-dev/config"`, `"type": "module"`, `"sideEffects": false`, `"version"` matching daemon's host minor, exports map with `types` first.
- `src/index.ts`: `defineConfig` helper. Generic over `BuiltInModules` const-tuple so projects get autocomplete for `'build/pre' | 'clean/pre' | …`. Uses the `HookSlotsOf<M>` template-literal type derivation from the plan.
- `src/types.ts`: `HookEntry` discriminated union — `string | { script: string; ... } | { fn: (payload) => Promise<result>; ... }`. `HookContracts` registry interface (module-augmentable). `HookRecord` discriminated union with `null` fallthrough. `OverrideSlotOf<M>` derived type. `phase: \`${string}/${string}\`` template-literal type used everywhere `phase: string` would appear.
- `manifest.schema.json` companion (or extend existing): JSON Schema for project-config validation (mirrors existing module manifest schema).
- Bundle target < 5 KB minified (it's identity-with-validation; basically zero runtime).

#### Manifest schema additions at `packages/module-sdk/manifest.schema.json`

- Additive `provides.hooks` field: `array of strings`, regex `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, max 64 chars, `uniqueItems: true`, empty array allowed. NO leading/trailing dash.
- Additive `consumes.hooks` field: `Record<'<id>/<name>', HookEntry>` shape — keys must match `^[a-z0-9-]+\/[a-z0-9-]+$`.
- Preserve existing `additionalProperties: false`.
- Mandate `host-version-range >= <plan's host minor>` on any manifest declaring hook fields. Validator emits `E_HOST_RANGE_REQUIRED` if missing. (Closes the old-daemon forward-compat gap from todo #005 risk.)

#### Error code catalog at `packages/module-sdk/src/errors.ts`

The 7-code consolidated set (NOT the original 14):
- `E_HOOK_TARGET_UNKNOWN`
- `E_HOOK_NAME_UNDECLARED`
- `E_HOOK_PATH_OUTSIDE_PROJECT`
- `E_HOOK_OVERRIDE_NOT_PERMITTED`
- `E_HOOK_CONFIG_INVALID` with `cause: 'parse-failed' | 'threw' | 'shape-invalid' | 'config-load-timeout' | 'version-mismatch'`
- `E_HOOK_FAILED` with `outcome: 'multiple-override' | 'multiple-results' | 'crashed-before-payload' | 'cycle-detected' | 'path-mutated' | 'queue-full' | 'timeout' | 'script-unreadable'`
- `E_HOOK_RUN_REAL_DENIED`

Plus `E_HOST_RANGE_REQUIRED` (manifest validator) and `E_HOOK_INTERPRETER_MISSING` (added per todo #007 risk row).

Auto-generate user-facing reference page at `docs/guides/hook-errors.md` from this file (planned for H7 but the source must be declarative now).

#### `rn-dev config init` CLI command

- Scaffolds a starter `rn-dev.config.ts` with examples for the most-used hooks (validates schema before writing).
- **Detects project's package manager via lockfile** (`bun.lock` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm) and runs `<pm> install --save-dev @rn-dev/config@^<hostMinor>`. Without this, scaffolded configs fail their own dynamic import on first session boot with `MODULE_NOT_FOUND`.
- Acceptance test: in an empty dir, `rn-dev config init` produces a project where `rn-dev config validate` succeeds without further setup.

#### Lockstep CI check

- vitest task: ajv-validates a fixture against `manifest.schema.json` round-trip.
- `expectTypeOf<ModuleManifest>().toMatchTypeOf<FromSchema<typeof schema>>()` — types match schema.
- `defineConfig` typo fixture (e.g. `'build/before'`) must fail to compile under `tsc --noEmit -p packages/config/__tests__/types/tsconfig.json`. Use `@ts-expect-error` directives or `tsd`/`expect-type` style.

### Test layer for H0

vitest only; no daemon integration:
- `defineConfig` happy path + each rejection class (single `E_HOOK_CONFIG_INVALID` with `cause` field).
- Manifest validator: `provides.hooks` + `consumes.hooks` round-trip; rejects malformed names; rejects missing `host-version-range` when hook fields present.
- `rn-dev config init` writes a parseable file in a `tmp-dir/` fixture and runs the package-manager install.
- Lockstep CI check passes.
- Negative-type tests for `defineConfig` typos.

### How to verify before pushing

Per CLAUDE.md three-layer verification standard:
1. **`npx vitest run`** — all H0 vitest green (≈25s).
2. **`npx tsc --noEmit && npx tsc --noEmit -p electron/tsconfig.json`** — clean.
3. **Playwright Electron smoke NOT REQUIRED for H0** (no daemon/IPC changes). Smoke gate kicks in at H2.

### Workflow shape

1. Read the plan H0 section in detail. Cross-reference relevant todos in `todos/` for findings (all 14 are marked `complete-` and document context behind individual decisions).
2. Use TodoWrite to break H0 into ~6 sub-tasks (`packages/config/` package, schema additions, error catalog, `rn-dev config init`, lockstep CI, error catalog auto-gen).
3. Implement each sub-task with tests. Mark todo complete as you go.
4. Conventional Commits: `feat(config): add @rn-dev/config workspace package`, `feat(modules): manifest schema gains provides.hooks + consumes.hooks`, etc.
5. Open a PR at the end of the session. Title: `feat(hooks): Phase H0 — manifest schema + @rn-dev/config + scaffolder`. Body should reference the plan + closed todos.

### What NOT to do this session

- Do NOT touch `src/core/hooks/`. That's H1.
- Do NOT wrap Builder/Clean/Metro/DevTools/Preflight as built-in modules. That's H2/H3.
- Do NOT add MCP tools. That's H2/H6.
- Do NOT extend the daemon RPC surface. That's H1+.
- Do NOT alter Builder concurrency, Metro lifecycle, or DevTools internals.

### Memory references

Before starting, the session-start memory will surface:
- `hook_system_plan.md` — full architectural context.
- `feedback_review_weighting.md` — how to handle review findings.
- `test_strategy_gap.md` — H0 doesn't need REAL_BOOT_SMOKE, but later phases do.
- `environment_setup.md` — Node + Bun versions on this machine.

### Open questions to flag if they arise

- If implementing `defineConfig` generic over `BuiltInModules` proves harder than the plan describes (TS inference complexity), pause and ask. Don't drop to `string` typing and call it done — the typed-slot autocomplete is the headline DX win.
- If the `rn-dev config init` package-manager auto-install is awkward (e.g. permissions, lockfile-edit semantics), ask before falling back to "instruct the user to install manually."
- If lockstep CI check requires libraries the workspace doesn't have, propose `json-schema-to-ts` or `expect-type` as the choice; await confirmation before adding.

Today is 2026-05-01.

---

## Notes for the resumer (you, picking this up)

- **Branch:** currently on `claude/elegant-chatelet-36d50d` — review/planning branch. For H0 implementation, create a fresh branch off `main` (e.g. `feat/hooks-h0`) so the plan-edit history doesn't pollute the implementation PR. The plan + todos can land first as their own small PR if not yet merged.
- **Plan + todos may be unmerged.** Check `git log main..HEAD` — if the plan and todos are local-only, decide whether to (a) PR them first as `docs: hook system plan + review todos` or (b) ship them as part of the H0 PR. (a) is cleaner; (b) is faster.
- **The 7 H6 MCP tools include some that can be deferred if H6 grows.** User declined scope cuts in this round, but if H0–H5 implementation runs over budget, the option of deferring `hooks-suggest` and `hooks-catalog` to v1.1 is still on the table. Reference [todos/014-rejected-p3-scope-cuts-mcp-tools-and-speculative.md](todos/014-rejected-p3-scope-cuts-mcp-tools-and-speculative.md) for the rationale; re-raise in a future session if velocity becomes an issue.
- **Do not delete** the rejected todo file — it's the durable record of the scope decision.
