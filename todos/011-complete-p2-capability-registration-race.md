---
status: pending
priority: p2
issue_id: 011
tags: [plan-review, hook-system, lifecycle]
dependencies: []
---

# Capability Registration Race at Session Boot

## Problem Statement

Plan says "registry rebuilt at session boot" but doesn't specify ordering between (a) `HookHostCapability` registration, (b) wrapped-Builder capability registration, and (c) module activation that may fire `session/init`. If `session/init` fires before all built-in capabilities are registered, hooks targeting them resolve as orphaned.

## Findings

- H1 introduces `session/init` namespace.
- H2 wraps Builder; H3 wraps Clean/Metro/DevTools/Preflight.
- 3p modules can register `consumes.hooks: { 'build/pre': ... }` — these depend on Builder capability being registered first.
- No deterministic boot phase split documented.

## Proposed Solutions

**Option A: Three-phase boot.** Phase 1: register all built-in capabilities (no firing). Phase 2: register HookManager + walk `consumes.hooks` from project + module manifests. Phase 3: fire `session/init`. Vitest assertion via boot-trace.

**Option B: Lazy registration.** Capabilities register on first reference. More complex; harder to debug.

## Recommended Action

Option A.

## Acceptance Criteria

- [ ] H1 deliverable adds: "Deterministic boot phase split: phase 1 = built-in capability registration; phase 2 = HookManager + consumes-walk; phase 3 = `session/init` fire."
- [ ] H1 vitest adds: boot-trace assertion verifying all built-in capabilities registered before any `session/init` fire.
- [ ] [src/core/session/boot.ts](../src/core/session/boot.ts) integration site documented.

## Work Log

- 2026-05-01 — Identified during ce:review meta-pass (Topic 6).

## Resources

- [src/core/session/boot.ts](../src/core/session/boot.ts)
