---
status: pending
priority: p2
issue_id: 009
tags: [plan-review, hook-system, testing, integration]
dependencies: [002]
---

# Test Coverage Gaps Across SRP Class Boundaries

## Problem Statement

H1's vitest matrix is comprehensive within each of the 4 SRP classes (Registry, Dispatcher, SubprocessRunner, AuditWriter) but doesn't name a single test that crosses class boundaries. Integration regressions at the seams will ship undetected.

## Findings — missing tests

1. **HookRegistry → HookDispatcher contract.** Dispatcher should walk the *pre-baked sorted list* (per H1 perf optimization). Recommend `hooks-dispatcher.contract.test.ts`: register out-of-order, assert dispatcher invokes in `(priority desc, registrationOrder asc)` without calling Registry's sort path again.

2. **HookDispatcher → HookAuditWriter policy.** "failures audited, successes not" is the audit-volume keystone. Spy-on-AuditWriter test with an additive successful fire — assert zero `append` calls.

3. **HookSubprocessRunner → HookDispatcher backpressure.** Token bucket (50 KB/s, 200 records/s, drop after 100 parse failures) — fire registration A (slow subprocess) + registration B (fast in-process) against different tuples; assert B completes before A.

4. **HookManager facade public-API preservation** (covered separately in todo #002).

## Findings — H5 fixture gap

H2 fixture `smoke-rn-with-hooks` covers project-hook-only `build/pre`. H5 introduces 3p hook firing but doesn't extend the fixture. Recommend: H5 deliverables explicitly extend `smoke-rn-with-hooks` with `node_modules/fake-3p-hook-mod/` package containing manifest with `consumes.hooks: { 'build/pre': ... }` — same fixture, two registration sources.

## Findings — perf gate budget enumeration

`PERF_GATE=1` test names `perf.spec.ts` but Performance Budget section lists 11 budgets. Quality Gate references "the budgets" plural without naming one assertion per budget. Recommend: explicit one-assertion-per-budget enumeration.

## Proposed Solutions

**Option A: Add 4 named integration tests + fixture extension + budget enumeration to H1/H5/H2 deliverables.** Effort: Medium. Risk: low.

## Recommended Action

Option A.

## Acceptance Criteria

- [ ] H1 deliverable lists `hooks-dispatcher.contract.test.ts`, `hooks-audit-writer.policy.test.ts`, `hooks-runner-dispatcher-backpressure.test.ts`.
- [ ] H5 deliverable specifies fixture extension: `tests/electron-smoke/fixtures/smoke-rn-with-hooks/node_modules/fake-3p-hook-mod/`.
- [ ] H2 perf spec enumerates one assertion per Performance Budget item (11 budgets currently).

## Work Log

- 2026-05-01 — Identified during ce:review meta-pass (Topic 4).

## Resources

- [docs/plans/2026-04-30-feat-hook-system-plan.md](../docs/plans/2026-04-30-feat-hook-system-plan.md) H1, H2, H5 test layers
