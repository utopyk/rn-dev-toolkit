---
status: rejected
priority: p3
issue_id: 014
tags: [plan-review, hook-system, scope, simplicity]
dependencies: []
resolved: 2026-05-01
resolution: User declined scope cuts — keeping all 7 MCP tools, hooks-overrides as separate tool, hook schema versioning. Module name kept as `session` (separate decision, not a scope cut).
---

# Scope Cuts — MCP Tools + Speculative v1 Items

## Problem Statement

The deepen-plan pass added 7 new MCP tools + hook schema versioning + `daemon-lifecycle` rename. Critical evaluation surfaces several items that should defer to v1.1 or merge.

## Findings — MCP tool triage

| Tool | Verdict | Rationale |
|------|---------|-----------|
| `hooks-config-validate` | **Must (already H2)** | Closes agent-write loop's correctness check. |
| `hooks-diagnose-all` | **Must** | Sweep mode of `hooks-diagnose`. ~50 LOC. |
| `hooks-config-read` | **Must** | Symmetric with `-write`. |
| `hooks-config-write` | **Must** | Headline of the deepen pass. |
| `hooks-suggest` | **Defer to v1.1** | Speculative agent-native gilding. 200+ LOC of pattern matching with no ground truth for "confidence." Ship after telemetry on what agents fail to discover. |
| `hooks-repair` | **Ship if cheap** | If just "diagnose+propose-edit stitched together" (~80 LOC), keep. If grows recommendation engine, defer. |
| `hooks-overrides` | **Merge into `hooks-list?filter=overrides`** | Filtered view; zero new code if collapsed into `hooks-list`. |
| `hooks-catalog` | **Defer to v1.1** | Marketplace integration adds dependency on curated `modules.json` fetch path. Ship when marketplace has >5 modules. |
| `session-profile-update` | **Must** | THE consumer for `session/profile-changed`. Without it, the namespace is read-only. |

## Findings — speculative items

- **Hook schema versioning (`version: "1.0.0"` per provides entry)** — host has one version in v1; nothing to version against. `peerDependencies` covers the case. **Defer to v1.1.**
- **`maxRegistrations: 16` cap** — earning its keep (one length check, prevents real failure mode). **Keep.**
- **`daemon-lifecycle` rename from `session`** — speculative naming churn. Hook namespace `session/*` stays; renaming the module while the namespace stays is confusing. Plan already caps namespace at 3 hooks. **Drop the rename; keep `session`.**

## Proposed Solutions

**Option A: Apply all cuts.** Net delta: −2 MCP tools (defer suggest/catalog), −1 merge (overrides into list), −1 rename (keep `session`), −1 speculative (drop hook versioning). ~3 days saved.

**Option B: Keep suggest + catalog as "stretch goals" within v1; flag as best-effort.** Risk: stretch goals tend to ship anyway and bloat scope.

## Recommended Action

Option A.

## Acceptance Criteria

- [ ] H6 drops `hooks-suggest`, `hooks-catalog`. Adds note: "v1.1 candidates."
- [ ] H6 merges `hooks-overrides` into `hooks-list?filter=overrides`.
- [ ] Plan reverts `daemon-lifecycle` → `session` module name throughout.
- [ ] Hook schema versioning (`version` per `provides.hooks` entry, `E_HOOK_VERSION_MISMATCH` code) removed; documented in "Future Considerations" instead.
- [ ] `maxRegistrations: 16` retained.

## Work Log

- 2026-05-01 — Identified during ce:review meta-pass (Topic 9).

## Resources

- [docs/plans/2026-04-30-feat-hook-system-plan.md](../docs/plans/2026-04-30-feat-hook-system-plan.md)
