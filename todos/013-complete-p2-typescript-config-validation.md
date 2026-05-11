---
status: pending
priority: p2
issue_id: 013
tags: [plan-review, hook-system, typescript, ux]
dependencies: []
---

# TypeScript Errors in `rn-dev.config.ts` Become Runtime Errors

## Problem Statement

Bun's runtime TS-import is permissive: a wrong payload shape compiles fine and explodes at first hook fire. The plan's "lockstep CI check" only tests the manifest schema, not the user's config file. Type errors in `rn-dev.config.ts` (e.g. wrong slot name, wrong payload shape) don't surface until the hook actually fires.

## Findings

- `defineConfig` is generic over `BuiltInModules` — typo `'build/before'` SHOULD compile-error.
- But `bun build`/`bun run` don't strict-type-check by default; user's IDE might also be lenient.
- Daemon imports the config at runtime; the type error becomes a runtime crash mid-build.

## Proposed Solutions

**Option A: `rn-dev config validate` runs `tsc --noEmit` against `rn-dev.config.ts` with daemon's `BuiltInModules` types injected via generated `node_modules/@rn-dev/config/types-augment.d.ts`.** Catches typos at validate time, not at fire time. Effort: Medium.

**Option B: Daemon strict-type-checks the config at boot.** Adds 100-300ms boot cost. More user-friendly but heavier.

**Option C: Document only; don't validate.** User catches via IDE.

## Recommended Action

Option A. Already aligned with `hooks-config-validate` MCP tool.

## Acceptance Criteria

- [ ] H6's `hooks-config-validate` deliverable lists: "runs `tsc --noEmit` with the daemon's `BuiltInModules` types injected; reports TS errors in JSON-line format pointing at `rn-dev.config.ts`."
- [ ] H0 ships the `types-augment.d.ts` generation as part of the `@rn-dev/config` package's install hook (or `rn-dev config init` post-step).
- [ ] H6 acceptance test: a config with `'build/before'` typo fails `rn-dev config validate` with a TS error pointing at the typo.

## Work Log

- 2026-05-01 — Identified during ce:review meta-pass (Topic 6).

## Resources

- [docs/plans/2026-04-30-feat-hook-system-plan.md](../docs/plans/2026-04-30-feat-hook-system-plan.md) H6 `hooks-config-validate`
