---
status: pending
priority: p1
issue_id: 004
tags: [plan-review, hook-system, ux, bootstrap]
dependencies: []
---

# `rn-dev config init` Doesn't Install `@rn-dev/config`

## Problem Statement

H0 ships a `rn-dev config init` scaffolder that writes `rn-dev.config.ts` containing `import { defineConfig } from "@rn-dev/config"`. The plan never says it also runs `npm install --save-dev @rn-dev/config`. Without that step, the scaffolded config fails its own dynamic import on the first session boot with `MODULE_NOT_FOUND`.

This is a day-1 adoption blocker — the entire acme-style "from `npm install rn-dev-cli` to running hook" flow breaks at step 2.

## Findings

- Plan H0: "`rn-dev config init` CLI command that scaffolds a starter `rn-dev.config.ts` with examples for the most-used hooks (validates the schema before writing)."
- No `pm install` step.
- Dynamic import resolves against project's `node_modules`. If `@rn-dev/config` isn't there, runtime error on every `rn-dev start` until the user manually installs.
- Forward-compat issue: scaffolder pinned to `^1.0.0` while daemon ships at `2.0.0` would silently version-skew.

## Proposed Solutions

**Option A: Detect package manager + install.** Scaffolder reads project's lockfile (bun.lock, package-lock.json, yarn.lock, pnpm-lock.yaml), runs the matching install command with `--save-dev` and pinned to the daemon's host version (e.g. `^<daemon major>.0.0`). Effort: Small. Risk: low.

**Option B: Inline the `defineConfig` helper in the scaffolded file.** No external dep. Effort: Small. Risk: defeats the published-package design — users lose IDE autocomplete via `@rn-dev/config` types.

**Option C: Document manual install step in `rn-dev config init` output; don't auto-install.** Effort: zero. Risk: violates "easy day-1 adoption" goal; one-step UX becomes two.

## Recommended Action

Option A. Add to H0 deliverables explicitly. Acceptance test: `rn-dev config init` in an empty dir produces a project where `bun run rn-dev config validate` succeeds without further setup.

## Acceptance Criteria

- [ ] H0 deliverable adds: "scaffolder detects package manager via lockfile + runs `<pm> install --save-dev @rn-dev/config@^<hostMinor>` after writing the config."
- [ ] H0 test layer adds: integration test against `tmp-dir/` fixture — init, then validate, asserting zero errors.
- [ ] Document in H7 user guide: how to upgrade `@rn-dev/config` when daemon major bumps.
- [ ] Risk matrix adds row: "`@rn-dev/config` version skew between project pin and daemon (covered in todo #007 risk-matrix-gaps)."

## Work Log

- 2026-05-01 — Identified during ce:review meta-pass (Topic 6).

## Resources

- [docs/plans/2026-04-30-feat-hook-system-plan.md](../docs/plans/2026-04-30-feat-hook-system-plan.md) H0 deliverables
