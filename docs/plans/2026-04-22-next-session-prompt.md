# Next-Session Prompt — Module System Phase 1

**Paste the block below at the start of the next session.**

---

We're continuing the third-party module system work for rn-dev-cli. Phase 0 (monorepo) and Phase 0.5 (ipc-bridge split) shipped yesterday in PR #2 — branch `feat/module-system-phase-0`. Now working on **Phase 1: `@rn-dev/module-sdk` v0.1 + manifest JSON Schema + scope-aware registry**.

Before doing anything else:

1. Read the handoff doc: `docs/plans/2026-04-22-module-system-phase-0-handoff.md`. It captures everything from the last session — decisions carried forward, permanent contract choices, open questions, and a step-by-step scope for Phase 1.
2. Read the plan's **Revision Log** (top of `docs/plans/2026-04-21-feat-module-system-and-device-control-plan.md`) and its **Phase 1** section. The Revision Log has the reserved manifest fields and SDK amendments from the multi-reviewer review.
3. Skim the brainstorm at `docs/brainstorms/2026-04-21-module-system-and-device-control-brainstorm.md` only if you want the "why" behind specific decisions — the handoff covers the "what."

### Branching

PR #2 may or may not be merged. Check:

```
gh pr view 2 --json state -q .state
```

- If `MERGED`: branch from `main` — `git checkout main && git pull && git checkout -b feat/module-system-phase-1`.
- If `OPEN`: branch from the tip of `feat/module-system-phase-0` so Phase 1 can land stacked, or wait for merge if you want a clean diff. Stack is fine for an in-flight feature.

### Phase 1 scope (hard line — do not bleed into Phase 2+)

1. **`packages/module-sdk/`** — populate the skeleton from Phase 0:
   - `manifest.schema.json` with versioned `$id` URL. Field inventory is in the handoff doc's "What's next — Phase 1 > Step 1" section; do not guess — use that list verbatim, including the V2-reserved fields (`signature?`, `sandbox?`, `target?`) that schema validates but the code ignores in v1.
   - `src/types.ts` — hand-written types matching the schema.
   - `src/define-module.ts` — `defineModule(spec)` runtime validator.
   - `src/errors.ts` — full typed error-code enum (list in handoff doc).
   - `src/host-rpc.ts` — **type surface only** for `host.capability<T>(id)`. Implementation transport is Phase 2.
2. **`src/modules/registry.ts`** — extend:
   - Add `loadUserGlobalModules()` reading `~/.rn-dev/modules/*/rn-dev-module.json`, validating against the schema, checking `hostRange` via `semver`, returning `RegisteredModule[]` in `inert` state.
   - Keep existing `loadPlugins(projectRoot)` working for per-project override. Both paths feed one validation pipeline.
   - Loosen `isRnDevModule` — MCP-only or Electron-only modules valid (no `component` required).
   - Scope-aware key: `${moduleId}:${scopeUnit}`.
   - **Enforce tool-prefix policy at load time**: 3p module tool names not matching `<manifest.id>__<tool>` → reject with `E_TOOL_NAME_UNPREFIXED`. Built-ins exempt.
3. **Tests** — colocated, vitest:
   - `packages/module-sdk/src/__tests__/define-module.test.ts` — schema validation happy path + path-pointing error cases + `hostRange` mismatch.
   - `src/core/__tests__/module-registry.test.ts` — scope-aware key, prefix enforcement, valid minimal manifest loads, invalid manifest rejected.
   - Fixture: `test/fixtures/minimal-module/rn-dev-module.json` (or use an existing pattern you find in the repo).

### Do NOT do in Phase 1

- No subprocess spawning. No `vscode-jsonrpc`. No `child_process.spawn`. (All Phase 2.)
- No MCP tool proxying. No changes to `src/mcp/`. (All Phase 3.)
- No Electron panel contributions. No `WebContentsView`. (All Phase 4.)
- No `uses:` dependency resolution. No `host.call`. (Phase 10, behind `experimental: true`.)
- No marketplace code, no install flow, no `@npmcli/arborist`. (Phase 6.)
- No Device Control adapters. (Phase 7.)

### Permanent contract rules (do not drift)

- `<moduleId>__<tool>` for 3p — flat for built-ins. `__` (double underscore). Host rejects non-compliant 3p at load.
- SDK exports `host.capability<T>(id: string)` — not `host.metro` / `host.artifacts`.
- Manifest lives at `rn-dev-module.json` at package root — not `package.json#rn-dev`.
- Schema is **additive-only** within 1.x. Any removal / rename / type narrowing = major bump.
- Reserved V2 fields (`signature?`, `sandbox?`, `target?`) accepted by the schema but code paths are unimplemented in v1. Tests should verify they parse cleanly.

### Success criteria (copy straight from plan Phase 1)

- Fixture module loads end-to-end with correct scope/permissions/activation fields.
- `hostRange` mismatch rejected with a clear error.
- Invalid manifest rejected with JSON-Schema path-pointing errors.
- `npx vitest run` green for the new tests (pre-existing 18 failures in `src/core/__tests__/{clean,preflight,project}.test.ts` are unrelated — chip was spawned separately).
- `npx tsc --noEmit` — zero new type errors from Phase 1 work.
- `bun run build` still green.

### Known caveats to inherit

- `electron/ipc/services.ts` is 499 lines (plan target <400). Don't touch unless you're explicitly trimming it — not a Phase 1 concern.
- 154 pre-existing `tsc` errors in `src/ui/wizard/*` (OpenTUI JSX). Unrelated. Don't try to fix in Phase 1.
- `.claude/` is gitignored; it contains superpowers worktree state.

### When done

Commit as `feat(module-sdk): Phase 1 — manifest schema + SDK + scope-aware registry`. Open PR. Write a `docs/plans/2026-04-??-module-system-phase-1-handoff.md` for the next session in the same format as `2026-04-22-module-system-phase-0-handoff.md`.

Total estimated effort: 2–3 days.
