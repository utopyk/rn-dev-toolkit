# Phase 12.1 Handoff — `extractFilter` Double-Validation Collapse

**Shipped**: 2026-04-23 via
[PR #12](https://github.com/utopyk/rn-dev-cli/pull/12). Squash-merged
to `main`.

## Context

Phase 12 (SDK arg-narrowers extraction, shipped as `8b3f54f` via
[PR #11](https://github.com/utopyk/rn-dev-cli/pull/11)) left behind
a double-validation pass: each module's `tools.ts::extractFilter`
re-ran validation on data that `index.ts::toListArgs` had already
narrowed via the SDK helpers. That redundancy was correct pre-Phase 12
(when `toXArgs` forwarded raw `Args`); dead weight afterwards. Both
Kieran TS (P1-1) and Simplicity (P1.1) flagged it for Phase 12.1.

## What shipped

### SDK addition

`packages/module-sdk/src/args.ts` gains `boundedInt(args, key, {min, max})`
— narrows + range-checks an integer wire field. Throws on inverted
range (caller-config bug → fail-loud). 7 unit tests.

### metro-logs

- `toListArgs` uses `boundedInt(args, "limit", { min: 1, max: MAX_LIST_LIMIT })`.
- `tools.ts::list()` explicitly rebuilds the filter literal (not
  rest-spread) — TS's fresh-literal excess-property check catches
  future divergence between `ListArgs` and `MetroLogsFilter`.
- Deleted from `tools.ts`: `extractFilter`, `isCursor`, `isStream`,
  local `MAX_LIMIT` constant.
- `MAX_LIST_LIMIT` exported from `tools.ts` (matches host naming).
- `tools.test.ts`: dropped the `extractFilter` describe block (coverage
  moved to SDK `args.test.ts`); adjusted empty-filter dispatch test.

### devtools-network

- `toListArgs` uses `boundedInt` for `limit`.
- `tools.ts::list()` explicit-literal rebuild.
- Deleted: `extractFilter`, `isCursor`, local `MAX_LIMIT`.
- New: `modules/devtools-network/src/__tests__/tools.test.ts` with
  8 handler-dispatch tests (Kieran P1 — closes the test-coverage gap
  that metro-logs had but devtools-network didn't).

Net LoC across the PR: **`+244 / -32`** (dominated by the new
devtools-network test file and the `boundedInt` helper + tests); the
*module source* is `-37` net, the intended win.

## Reviewer round

Four parallel reviewers — **all approved. No P0. Two P1s fixed
in-branch.**

### Applied pre-merge

- **Kieran P1** (+ Architecture implicitly, + Security incidentally): explicit
  literal rebuild in both `list()` handlers. Forces a compile error
  if `ListArgs` gains a non-filter field. Incidentally drops
  `__proto__` own-data-properties that `JSON.parse` may create.
- **Kieran P1**: devtools-network `tools.test.ts` added (8 tests).
- **Kieran P2**: `boundedInt` throws on `min > max`.
- **Simplicity P2**: dropped the `min === max` YAGNI test.
- **Simplicity P2**: de-phased the "Post Phase 12.1" comments to
  phase-free wording.

### Intentionally deferred

| Finding | Source | Rationale |
|---|---|---|
| `MAX_LIST_LIMIT` duplicated in `modules/{metro-logs,devtools-network}/src/tools.ts` + `src/core/metro-logs/buffer.ts` | Simplicity P1 + Architecture P2-B | Simplicity recommends pushing the cap to each module's `rn-dev-module.json` `inputSchema.maximum` (agents read manifests, not source). Bundling this with the Phase 12.2 bootstrap-surface extraction keeps the narrative coherent. |
| Extract `resolveCapability` to SDK as `requireCapability<T>(ctx, id, label)` | Architecture P2-A | Two verbatim copies today (metro-logs + devtools-network), same generic-parameter pattern, same generic error message. Queue alongside `loadManifest` + `invokedAsEntry` for the "bootstrap surface" Phase 12.2. |
| `loadManifest` + `invokedAsEntry` SDK extraction | Architecture P2-A/B (PR #11) | Still the right bundle. Natural fit with `requireCapability`. |
| `boundedInt` options-object → positional scalars | Simplicity P2 | Kieran P2 argues keep — self-documenting, extensible, guards against silent min/max swap (both are `number`). Consensus with Kieran. |
| Prototype-chain hardening (the remaining `args[key]` bracket-access) | Security P2 (pre-existing, PR #11 carry-over) | Follow-up task chip already spawned from PR #11 review. Now also closes the `...filter` `__proto__` survival case that this PR's explicit-literal rebuild incidentally fixed at the spread site. |
| Branded `NarrowedListArgs` type | Architecture P3 | Overkill for the current 1-caller-per-module shape. Revisit if a 2nd external caller into `tools.ts::list` ever lands. |
| Subpath export for `@rn-dev/module-sdk/args` | Architecture P2 | Stay barrel-only. Revisit at ~15+ SDK exports. |

## Behavior note on empty filters

Capability call-site shape changed from `filter: undefined` (old,
pre-Phase 12.1) to `filter: { substring: undefined, stream: undefined,
since: undefined, limit: undefined }` (new). Vitest's `toEqual`
ignores undefined properties, so assertions still read as
`filter: {}`. Host-side (`buffer.ts`, `devtools.ts`) uses `filter?.x`
optional chaining on every field access — functionally identical.
Explicit in the handoff so the contract shift isn't invisible to
future maintainers.

## Baselines (Phase 12.1 close state)

- **vitest**: 883/0 (Phase 12 baseline was 875 — this PR adds +8
  devtools-network handler tests, +7 boundedInt tests, -1 YAGNI
  test, +1 inverted-range throw test, -5 metro-logs extractFilter
  tests; net `+10`)
- **tsc root**: 150 (pre-existing wizard errors, unchanged)
- **tsc electron**: 0
- **tsc per-module**: 0/0/0
- **`bun run build`**: green
- **`bun run typecheck`**: green

## Commits on the branch

- `e5ae436 feat(module-sdk): add boundedInt(args, key, {min, max}) narrower`
- `1487563 refactor(modules): collapse extractFilter double-validation in metro-logs + devtools-network`
- `17f93d4 fix(modules): address Phase 12.1 reviewer feedback`

Squash-merged as a single commit on `main`.

## What's next

Phase 12.2 candidate is the **bootstrap-surface bundle** — three
related SDK extractions that together form the complete "module
author ergonomics" story:

1. `loadModuleManifest(importMetaUrl)` — from Architecture P2-A/B
   in PR #11.
2. `isModuleEntry(importMetaUrl)` — same.
3. `requireCapability<T>(ctx, id, label)` — from Architecture P2-A
   in PR #12.
4. Resolve `MAX_LIST_LIMIT` duplication — Simplicity's manifest
   `inputSchema.maximum` approach OR SDK-hosted constant.

Alternative next-phase candidates (all from PR #11 deferred):
- **Phase 13 D**: Prototype-chain hardening (`hasOwnProperty.call`
  gating across all narrowers).
- **Phase 12 Option C** (still blocked): npm publishing once
  `rn-tools.com` DNS + `@rn-dev-modules` npm scope are ready.
