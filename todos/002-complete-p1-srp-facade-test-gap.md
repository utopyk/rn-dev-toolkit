---
status: pending
priority: p1
issue_id: 002
tags: [plan-review, hook-system, testing, srp]
dependencies: []
---

# HookManager Facade Public-API Preservation Test — Missing

## Problem Statement

H1's SRP split breaks `HookManager` into 4 internal classes (`HookRegistry`, `HookDispatcher`, `HookSubprocessRunner`, `HookAuditWriter`) plus a thin `HookManager` facade. No test pins the facade's public API, so H2 callers (e.g. [src/daemon/client-rpcs.ts:130](../src/daemon/client-rpcs.ts:130)) will silently break if the re-export drifts during the split.

## Findings

H1's vitest matrix covers each of the 4 internal classes well, but doesn't verify:
- The facade re-exports the same `fire`, `dispose`, etc. shape callers depend on.
- The TypeScript signatures are backwards-compatible (`fire<S extends keyof HookContracts>(...)` doesn't break existing call sites).

## Proposed Solutions

**Option A: Snapshot test of facade public API.** `hook-manager-facade.test.ts` imports `HookManager` from `@rn-dev/module-sdk` (or wherever it lands), constructs an instance, and snapshots the method names + signatures. Regression-detects accidental API drift.

**Option B: Type-level expectTypeOf assertion.** Pin facade type at H1; expect-type tests verify `HookManager['fire']` matches the contract.

**Option C: Skip; rely on tsc + integration tests.** Risk: tsc errors only fire when callers update; H2 might land before discovering the regression.

## Recommended Action

Both A + B. Snapshot covers runtime; expectTypeOf covers types. Cheap (≈30 lines combined) and pins the contract.

## Acceptance Criteria

- [ ] H1 deliverable list adds: "`hook-manager-facade.test.ts` — snapshots public method names + signatures."
- [ ] H1 TypeScript Quality Gates add: `expectTypeOf<HookManager['fire']>().parameter(0).toEqualTypeOf<keyof HookContracts>()`.
- [ ] H2 test plan asserts at least one call site (e.g. `client-rpcs.ts builder/build` test) consumes the facade post-split.

## Work Log

- 2026-05-01 — Identified during ce:review meta-pass (Topic 4).

## Resources

- [docs/plans/2026-04-30-feat-hook-system-plan.md](../docs/plans/2026-04-30-feat-hook-system-plan.md) H1 SRP split
