---
status: pending
priority: p2
issue_id: 010
tags: [plan-review, hook-system, documentation, clarity]
dependencies: [001]
---

# Documentation Clarity — Term Drift + Enhancement Summary Weight + Phase H4 Re-Anchor

## Problem Statement

Reading the plan end-to-end as a fresh reader surfaces three doc-quality issues that slow comprehension.

## Findings

1. **Term drift across "phase" / "slot" / "contribution point" / "fire" / "dispatch."** Plan uses "phase" in `E_UNKNOWN_HOOK_PHASE`, audit `phase: string`, and H1 prose, but otherwise uses "slot" / "contribution point" / "registration." `E_UNKNOWN_HOOK_PHASE` was collapsed (covered in todo #001) but the term itself drifts elsewhere. Recommend lock-down:
   - **"contribution point"** = the named slot a module exposes via `provides.hooks`.
   - **"registration"** = a hook entry consuming a contribution point (project or 3p).
   - **"slot"** = synonym for contribution point (acceptable in casual prose).
   - **"fire"** = public verb consumers use (`HookManager.fire('build/pre', ...)`).
   - **"dispatch"** = internal — the act of HookDispatcher routing to a runner.
   - Drop "phase" entirely (use "slot" or "contribution point").

2. **Enhancement Summary weight (78 lines, ~60% duplication of per-phase deliverables).** "Top showstoppers 1-10" is repeated nearly verbatim in H1/H2 with `(security-sentinel finding N — showstopper)` pointers. Recommend: keep showstoppers 1-10 as a top-level bullet list; cut "Simplifications adopted," "New work added," "Phase-ordering changes" sub-sections — that material reads as deepen-pass exhaust and belongs in a CHANGELOG comment, not the plan body. Saves ~150 lines.

3. **Phase H4 re-anchor.** H4 references "the `source` discriminator from H2" assuming reader has H2 in working memory. Recommend: H4 opens with one-line re-anchor: "H2 introduced a `source: 'builtin' | 'override'` field on every Builder event. H4 wires the override path that produces `source: 'override'`."

4. **"Why not just modules?" callout buried.** Alternative C carries the answer but is in §"Alternatives Considered" — fresh reader hits §"Proposed Solution" first and is left wondering for ~400 lines. Recommend: add a one-paragraph callout after "Proposed Solution" pointing to Alternative C.

5. **Inline code shape gaps.** `HookContracts` reference is prose-only; `HookEntry` discriminated union describes shape but no example. Recommend: add 6-line `HookEntry` snippet to H0's "Research Insights" block.

## Proposed Solutions

**Option A: Apply all 5 doc-quality fixes.** Effort: Medium. Risk: low.

**Option B: Apply only 1 (term lockdown) + 3 (H4 re-anchor) — most impactful.** Effort: Small.

## Recommended Action

Option A. The Enhancement Summary trim alone reclaims ~150 lines and improves first-read comprehension.

## Acceptance Criteria

- [ ] Term lock-down section added to plan (under Architecture or near top).
- [ ] "phase" replaced with "slot" or "contribution point" everywhere except in the (already-collapsed) `E_UNKNOWN_HOOK_PHASE` deprecation note.
- [ ] Enhancement Summary trimmed: keep showstoppers 1-10; remove or move to CHANGELOG file the Cuts/Additions/Phase-ordering sections.
- [ ] H4 opens with the one-line re-anchor.
- [ ] "Why not just modules?" callout added after Proposed Solution.
- [ ] `HookEntry` example snippet in H0 Research Insights.

## Work Log

- 2026-05-01 — Identified during ce:review meta-pass (Topic 5).

## Resources

- [docs/plans/2026-04-30-feat-hook-system-plan.md](../docs/plans/2026-04-30-feat-hook-system-plan.md)
