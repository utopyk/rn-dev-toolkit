---
status: pending
priority: p2
issue_id: 008
tags: [plan-review, hook-system, testing, acceptance-criteria]
dependencies: []
---

# Acceptance Criteria Has Several Unmeasurable / Ambiguous Items

## Problem Statement

Acceptance Criteria mixes well-defined functional gates with prose that has no clear test shape. Implementer can't verify whether the criterion is met without inventing the test on the fly.

## Findings — items lacking concrete test shape

1. **"HookManager dispatches in-process and subprocess hooks via a single registry keyed on `<module-id>/<hook-name>`"** — what's the assertion? Recommend: `dumpRegistry()` debug API exposed for tests; vitest after a boot fixture asserts exactly one Map with composite keys.

2. **NFR "Hook subprocess timeout reaps the entire process group (no orphaned grandchildren)"** — recommend: vitest spawns hook = `node -e "setInterval(()=>{},1e9); spawn('node',['-e','setInterval(()=>{},1e9)']);"`; sets `timeoutMs:200`; after fire asserts `process.kill(-pgid, 0)` throws `ESRCH` within 2s. Both macOS + Linux in CI.

3. **NFR "build/pre-to-build-start latency under 500ms for trivial hook fixture"** — fixture named, hardware/percentile not. Recommend: state "p95 over 20 runs on macOS arm64 GitHub runner, fixture `smoke-rn-with-hooks`, hook = `node -e 'process.stdout.write(JSON.stringify({kind:\"result\",data:{}}))'`."

4. **NFR "stderr fork-bomb rate-limited at 10 KB/s"** — testable without actual fork-bomb. Hook = `node -e "while(1)process.stderr.write('x'.repeat(1024))"` with 1s timeout; assert collected stderr ≤ 12KB; assert `[truncated]` marker.

5. **Quality gate `PERF_GATE=1`** — when does it run? Recommend: nightly on `main` only, plus opt-in local `npm run test:perf`. Document in `.github/workflows/`.

6. **"defineConfig typo for 'build/before' fails to compile"** — needs separate compile-check. Recommend: `packages/config/__tests__/types/typo.fixture.ts` + vitest task running `tsc --noEmit -p packages/config/__tests__/types/tsconfig.json`; assert non-zero exit + expected `TS2322`. Use `tsd` or `expect-type`-style with `@ts-expect-error` directives.

7. **"successful additive hook fires are NOT audited"** — needs assertion. Test: 100× passing hook fires; `audit.log` line count unchanged.

## Proposed Solutions

**Option A: Add concrete test shape per criterion.** Effort: Medium. Risk: low.

**Option B: Soften unmeasurable items into "best effort" prose.** Effort: zero. Risk: implementer ignores them.

## Recommended Action

Option A. Each criterion needs an explicit test path.

## Acceptance Criteria

- [ ] Each NFR / TS Quality Gate has a vitest path (file + assertion shape) named in the plan.
- [ ] `PERF_GATE=1` cadence documented (nightly on main + opt-in local).
- [ ] `dumpRegistry()` debug API specified in H1 deliverables.
- [ ] Negative-type-test fixture pattern documented in H0 (mirrors `tsd`/`expect-type`).

## Work Log

- 2026-05-01 — Identified during ce:review meta-pass (Topic 8).

## Resources

- [docs/plans/2026-04-30-feat-hook-system-plan.md](../docs/plans/2026-04-30-feat-hook-system-plan.md) Acceptance Criteria
