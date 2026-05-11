---
status: pending
priority: p2
issue_id: 007
tags: [plan-review, hook-system, risk-analysis]
dependencies: []
---

# Risk Matrix Missing Seven Failure Modes

## Problem Statement

The Risk Analysis & Mitigation table has 8 entries. Seven realistic failure modes are not covered — most are operational/edge-case but high-impact when hit.

## Findings — gaps to add

1. **Module-host vs hook-host shutdown handler race.** Both classes install `process.exit`/`SIGINT`/`SIGTERM` handlers ([src/core/module-host/manager.ts:221-223](../src/core/module-host/manager.ts:221)). Ordering unspecified. Mitigation: HookManager registers `process.once('SIGTERM', ...)` ordering — module-host first (drains JSON-RPC), HookManager second (drains hook subprocesses), AuditWriter last. Document in `src/core/spawn-utils.ts`.

2. **Multi-daemon concurrent audit-log fire.** Active-daemon registry at [src/daemon/registry.ts](../src/daemon/registry.ts) — acme norm is 3+ worktrees. `build/pre` fires concurrently across daemons; audit log uses HMAC-chained fcntl-locked writes. Plan mentions briefly but doesn't pin behavior under contention. Mitigation: explicit lock-fairness assertion in perf spec under 4-daemon `build/pre`.

3. **`@rn-dev/config` version skew.** Project pinned 1.0.0, daemon ships 2.0.0 with breaking type changes. Mitigation: version-handshake at boot — daemon reads config package's `package.json` version, rejects with `E_HOOK_CONFIG_VERSION_MISMATCH { expected, got, migrationDoc }`. Mirrors version-handshake from PR #25.

4. **Hook script unreadable mid-session** (`chmod 000`, `rm`, fs unmount). TOCTOU re-check (path mutation) doesn't catch readability. Mitigation: `fs.accessSync(path, fs.constants.R_OK | fs.constants.X_OK)` at fire-time; on `EACCES`/`ENOENT`, fail with `E_HOOK_FAILED { outcome: "script-unreadable" }`.

5. **Slow `rn-dev.config.ts` dynamic import blocks daemon boot.** Network-bound import (e.g. `import('https://...')`) hangs daemon. Mitigation: 5s wall-clock timeout on initial import; on timeout → `E_HOOK_CONFIG_INVALID { cause: 'config-load-timeout' }`; daemon boots with empty registry + one-time warn.

6. **`allowModuleOverrides` typo silently strips.** Schema `additionalProperties: false` drops unknown keys without warning. Mitigation: `defineConfig` validates known top-level keys at import time; unknown key → log warn `[rn-dev] ignored unknown config key 'allowModuleOverride' — did you mean 'allowModuleOverrides'?` (Levenshtein-1 suggestion).

7. **Hook script needs Bun, project on plain Node — `ENOENT` confusion.** Spawn fails with kernel `ENOENT` of the interpreter. Mitigation: wrap spawn errors; on `ENOENT` of interpreter, raise `E_HOOK_INTERPRETER_MISSING { interpreter, hint: 'install bun or use a Node-compatible script' }`.

## Proposed Solutions

**Option A: Add all 7 rows to Risk Analysis table.** Effort: Small. Risk: low.

**Option B: Add only the 3 most likely (1, 2, 4) and defer rest.** Effort: smaller; risk: under-documented.

## Recommended Action

Option A. Each is a real ops scenario.

## Acceptance Criteria

- [ ] 7 new rows in Risk Analysis & Mitigation table with Likelihood / Impact / Mitigation.
- [ ] Per-row references to file paths where mitigation lives.
- [ ] Mitigations 3 + 4 + 7 produce new error codes — extend the H0 error catalog accordingly.

## Work Log

- 2026-05-01 — Identified during ce:review meta-pass (Topic 7).

## Resources

- [src/core/module-host/manager.ts:221-223](../src/core/module-host/manager.ts:221)
- [src/daemon/registry.ts](../src/daemon/registry.ts)
