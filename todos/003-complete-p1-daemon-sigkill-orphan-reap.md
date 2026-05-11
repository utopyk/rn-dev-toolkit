---
status: pending
priority: p1
issue_id: 003
tags: [plan-review, hook-system, security, lifecycle]
dependencies: []
---

# Daemon SIGKILL → Orphaned Hook Subprocess Groups

## Problem Statement

Plan covers session/stop dispose order (SIGTERM → 1s grace → SIGKILL of group) but never covers daemon-process SIGKILL. If the daemon is itself SIGKILLed (OOM, kernel panic, ops kill), in-flight hook subprocess groups become orphans because the process-group leader (the daemon) dies without running the SIGKILL escalation.

POSIX detached process groups specifically mean those groups won't receive the daemon's death as a signal. The `setpriv --pdeathsig SIGKILL` mention is Linux-only; macOS has no equivalent.

## Findings

- [src/core/module-host/manager.ts:71-95](../src/core/module-host/manager.ts:71) — `NodeSpawner` uses `detached: true` on POSIX, which is correct for orderly shutdown but creates orphans on hard kill.
- Plan's H1 dispose order assumes daemon runs `dispose()`. Hard kill bypasses dispose.
- Existing module-host has the same issue but mitigated via the orphan-sweep at [src/daemon/orphan-sweep.ts](../src/daemon/orphan-sweep.ts). Hooks need parity.

## Proposed Solutions

**Option A: Extend orphan-sweep at next daemon boot.** New daemon scans for hook subprocesses via PID file or socket marker; SIGKILLs orphans before booting session. Mirrors the existing module-host orphan-sweep pattern.

**Option B: `pdeathsig` on Linux only; document macOS limitation.** Best-effort group reaping; macOS hooks become zombies until OS reaps. Acceptable if rare.

**Option C: Hook subprocess writes a heartbeat file; orphan-sweeper kills any process whose heartbeat is stale.** More complex; not worth v1.

## Recommended Action

Option A + Option B together. Linux gets `pdeathsig` (already partially specified). Both platforms get orphan-sweep at next daemon boot. Add a fixture test that SIGKILLs the daemon mid-fire and asserts the hook group is dead within 2s of the next daemon boot.

## Acceptance Criteria

- [ ] H1 deliverable adds: "Hook orphan-sweep on daemon boot — scans for stray hook process groups, SIGKILLs them. Mirrors existing [src/daemon/orphan-sweep.ts](../src/daemon/orphan-sweep.ts)."
- [ ] H2 test layer adds: `tests/electron-smoke/hook-orphan.spec.ts` — SIGKILLs daemon with a sleeping hook, boots fresh daemon, asserts `process.kill(-pgid, 0)` throws `ESRCH` within 2s.
- [ ] Risk matrix adds row: "Daemon SIGKILL leaves hook group as zombie until next boot."
- [ ] Linux: hook subprocess uses `setpriv --pdeathsig SIGKILL` when available (already mentioned for module-host). macOS: documented as best-effort.

## Work Log

- 2026-05-01 — Identified during ce:review meta-pass (Topic 6).

## Resources

- [src/daemon/orphan-sweep.ts](../src/daemon/orphan-sweep.ts)
- [src/core/module-host/manager.ts:71-95](../src/core/module-host/manager.ts:71)
