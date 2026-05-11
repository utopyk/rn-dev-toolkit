---
status: pending
priority: p2
issue_id: 006
tags: [plan-review, hook-system, phase-deps]
dependencies: [001]
---

# `HookHostCapability` Forward Dependency in H2 Pre H3 Definition

## Problem Statement

H2 wraps Builder via "`HostBuildCapability`" (existing prose) but the `HookHostCapability` interface + `createBuildHostCapability` factory pattern is only documented in H3. H2 implicitly depends on a pattern shipped after it.

## Findings

- H2 deliverable: "modules/build/ — new built-in-privileged module... wraps the existing Builder class behind a `HostBuildCapability`."
- H3 deliverable: "`HookHostCapability` + `createBuildHostCapability`/`createCleanHostCapability`/...". Subsystem-first naming.
- Phase order says H0→H1→H2→H3. H2 references machinery from H3 — phase ordering violation.

## Proposed Solutions

**Option A: Hoist the interface + first factory to H2.** H3 then adds Clean/Metro/DevTools/Preflight factories. Effort: Small (text move).

**Option B: Move Builder wrap to H3.** H2 milestone becomes weaker (no e2e Builder hook). Effort: Medium (phase reshape).

**Option C: Document H2 as depending on H3 prose for the pattern only.** Confusing for implementers.

## Recommended Action

Option A.

## Acceptance Criteria

- [ ] H2 deliverable adds: "`HookHostCapability` interface + first factory `createBuildHostCapability`."
- [ ] H3 deliverable updated: "remaining factories — `createCleanHostCapability`, `createMetroHostCapability`, `createDevtoolsCoreHostCapability`, `createPreflightHostCapability`."

## Work Log

- 2026-05-01 — Identified during ce:review meta-pass (Topic 2).

## Resources

- [docs/plans/2026-04-30-feat-hook-system-plan.md](../docs/plans/2026-04-30-feat-hook-system-plan.md) H2 + H3
