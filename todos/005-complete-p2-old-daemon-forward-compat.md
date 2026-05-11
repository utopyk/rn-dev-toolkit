---
status: pending
priority: p2
issue_id: 005
tags: [plan-review, hook-system, migration, forward-compat]
dependencies: []
---

# Old Daemons Reject New Manifests with `additionalProperties: false`

## Problem Statement

The manifest schema's `additionalProperties: false` (preserved per plan) means an N-version daemon installing an N+1-published module that uses `provides.hooks` / `consumes.hooks` will fail ajv validation with `E_INVALID_MANIFEST`. The plan never addresses this forward-compatibility scenario.

## Findings

- [packages/module-sdk/manifest.schema.json](../packages/module-sdk/manifest.schema.json) has `additionalProperties: false`.
- New `provides.hooks` / `consumes.hooks` are top-level (or scoped under `provides`/`consumes` parents).
- Old daemons reject the new fields outright — modules become uninstallable cross-version.
- `host-version-range` field on manifests provides a partial answer (module declares its host version floor) but the plan doesn't say hook-bearing modules MUST set it.

## Proposed Solutions

**Option A: Relax `additionalProperties: false` for `provides`/`consumes` parents specifically.** Old daemons silently strip the new fields; module installs succeed but hooks don't fire. Effort: Small. Risk: silent degradation feels worse than hard rejection.

**Option B: Mandate `host-version-range` floor on every hook-bearing module.** Old daemons reject install with a clear "host too old" error rather than silent strip. Effort: Small. Risk: low.

**Option C: Schema versioning at manifest level (e.g. `manifestVersion: 2`).** Old daemons see version mismatch and reject explicitly. Effort: Medium.

## Recommended Action

Option B. Add to H0 deliverables: "manifests with `provides.hooks` or `consumes.hooks` MUST declare `host-version-range >= <plan's host minor>`. Validator emits `E_HOST_RANGE_REQUIRED` if missing." Document in H7 user guide.

## Acceptance Criteria

- [ ] H0 deliverable adds the mandate.
- [ ] H5 manifest validator enforces `host-version-range` presence when hook fields are present.
- [ ] Risk matrix row added.

## Work Log

- 2026-05-01 — Identified during ce:review meta-pass (Topic 3).

## Resources

- [packages/module-sdk/manifest.schema.json](../packages/module-sdk/manifest.schema.json)
