---
status: complete
priority: p1
issue_id: 001
tags: [plan-review, hook-system, contradictions]
dependencies: []
---

# Plan Internal Contradictions — Cuts not Propagated

## Problem Statement

The deepen-plan pass added an Enhancement Summary listing "Cuts adopted" but several cuts didn't propagate to per-phase deliverables. Implementer can't tell which version is canonical, leading to wrong code shipping.

## Findings

Six contradictions in [docs/plans/2026-04-30-feat-hook-system-plan.md](../docs/plans/2026-04-30-feat-hook-system-plan.md):

1. **Error code list contradicts itself within H0.** Line ~265 lists the pre-consolidation 14 codes (`E_HOOK_TARGET_UNKNOWN`, `E_HOOK_NAME_UNDECLARED`, `E_HOOK_PATH_OUTSIDE_PROJECT`, …, `E_UNKNOWN_HOOK_PHASE`, `E_HOOK_MULTIPLE_OVERRIDE`, `E_HOOK_MULTIPLE_RESULTS`, `E_HOOK_CRASHED_BEFORE_PAYLOAD`, `E_HOOK_CYCLE_DETECTED`, `E_CONFIG_PARSE_FAILED`, `E_CONFIG_THREW`, `E_CONFIG_SHAPE_INVALID`). Line ~288 (Research Insights) lists the consolidated 7 codes. Acceptance Criteria + Interaction Graph reference the obsolete list.

2. **`provides.overrideHook?: string` configurability** dropped in summary but still in H0 deliverable + Architecture section (`HookManager — the contribution-point registry`). Dead code: `OverrideSlotOf<M>` derived type still keys off `M['provides'] extends { overrideHook: infer O }`.

3. **`session/profile-changed` and `session/shutdown` deferred** in summary, but H6 ships `rn-dev/session-profile-update` MCP tool that fires `session/profile-changed`. Acceptance Criteria still mandates session module owns all three. Either un-defer or remove the tool.

4. **`hooks/override-fell-through` event** listed in H6 stable kind vocabulary directly contradicts "no fall-back on missing ack" cut in H4 (missing ack = hard fail, not fall-back).

5. **`hooks-history` collapsed** into `hooks-list?include=history` but Acceptance Criteria + H6 test layer still register the standalone tool.

6. **`customN` override fire** wording in audit-log section + migration CLI helper test bullet in H7 — both are dead per the cuts list.

## Proposed Solutions

**Option A: Direct Edit pass on the plan.** Apply 6 surgical edits. Effort: Small. Risk: low — text-only fixes.

**Option B: Re-run deepen-plan with stricter "remove obsoleted text" instruction.** Effort: Medium. Risk: high — could re-introduce the deepen-pass exhaust the simplicity reviewer flagged.

**Option C: Leave as-is; treat Enhancement Summary as authoritative; let reviewers catch in PR review.** Effort: zero. Risk: high — implementer wastes a session on the wrong code shape.

## Recommended Action

Option A. Apply the 6 edits in one pass. See acceptance criteria below for line-level changes.

## Acceptance Criteria

- [ ] H0 deliverable list reduced to 7 codes (matching line ~288 Research Insights consolidation).
- [ ] All `provides.overrideHook?` mentions stricken; `OverrideSlotOf<M>` simplified to `\`${M['id']}/custom\``.
- [x] **RESOLVED 2026-05-01:** `session/profile-changed` un-deferred per user decision (option A). Consumer is H6's `rn-dev/session-profile-update` MCP tool. `session/shutdown` stays deferred. Module name reverted to `session` (no `daemon-lifecycle` rename).
- [ ] `hooks/override-fell-through` removed from H6 event vocabulary; `hooks/failed` covers the missing-ack case.
- [ ] `hooks-history` references replaced with `hooks-list?include=history` (Acceptance Criteria + H6 test layer).
- [ ] `customN` wording corrected to single-override-allowed; migration helper test bullet removed from H7.

## Work Log

- 2026-05-01 — Identified during ce:review meta-pass.
- 2026-05-01 — User chose option A on `session/profile-changed` un-defer. Plan updated: H1 ships `init` + `profile-changed`; `shutdown` deferred. `daemon-lifecycle` rename reverted (kept as `session`). All other contradictions (error-code list, hooks-history, customN, hooks/override-fell-through, provides.overrideHook, migration helper) fixed inline in the plan during ce:review pass.
- 2026-05-01 — All acceptance criteria met. Marking complete.

## Resources

- [docs/plans/2026-04-30-feat-hook-system-plan.md](../docs/plans/2026-04-30-feat-hook-system-plan.md)
- Source review: meta-reviewer Topic 1 findings
