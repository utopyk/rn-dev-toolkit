---
status: pending
priority: p3
issue_id: 015
tags: [plan-review, hook-system, scope, phase-boundaries]
dependencies: []
---

# Phase H7 Rebalance — Hoist Test Helpers, Slim H7 to Docs-Only

## Problem Statement

H7 mixes surfaces (docs + code + examples + helpers + READMEs). Walking each, only docs/examples really fit H7's "tie off" profile. Test helpers belong with the contracts they test (H1).

## Findings

- **`runHookInProcess`, `MockHookRuntime` test helpers** — test the contracts defined in H0/H1. Should ship with their contracts. Otherwise H1 can't dogfood the helpers, and H5 module authors writing 3p hooks lack test infra. `runHookInProcess` is ~70% the same code path as `HookSubprocessRunner`'s in-process branch — building it in H7 means rewriting tests already written in H1.
- **`examples/firebase-swap/`** — minimal version is in H2 (smoke fixture). Full acme-style version is doc-grade. Keep H7 ownership of doc walkthrough; H2 owns executable fixture.
- **`examples/local-package-link/`** — placeholder against unimplemented `pre-install` hook. Shipping example registering a phantom hook is a footgun. Defer to v1.1.
- **`docs/guides/hook-system.md`, `docs/guides/onSaveAction-migration.md`** — keep in H7.
- **`rn-dev config init` scaffolder template content** — code lives in H0 (`packages/config/templates/starter.ts`); content choices (which 3 hooks demo) are docs decisions and live in H7's review.
- **Missing from H7:** error catalog reference page (Markdown auto-generated from `errors.ts`); `@rn-dev/config` package README.

## Proposed Solutions

**Option A: Hoist test helpers into H1; slim H7 to docs+examples; consider folding into H6 tail.** Net: H7 becomes a half-day phase or absorbs into H6 polish track.

**Option B: Split H7 into H7a (helpers) + H7b (docs).** More phases, more PR overhead.

## Recommended Action

Option A.

## Acceptance Criteria

- [ ] H1 deliverable adds: "`runHookInProcess` + `MockHookRuntime` test helpers in `@rn-dev/module-sdk`."
- [ ] H7 deliverable removes test helpers; adds: "error catalog reference page (auto-generated from `errors.ts`); `@rn-dev/config` package README."
- [ ] `examples/local-package-link/` removed from H7; documented as v1.1.
- [ ] `examples/firebase-swap/` H2-vs-H7 split documented (executable fixture vs doc walkthrough).
- [ ] Plan-level decision: keep H7 standalone (half-day) or fold into H6 tail. Either acceptable; recommend folding.

## Work Log

- 2026-05-01 — Identified during ce:review meta-pass (Topic 10).

## Resources

- [docs/plans/2026-04-30-feat-hook-system-plan.md](../docs/plans/2026-04-30-feat-hook-system-plan.md) H7
