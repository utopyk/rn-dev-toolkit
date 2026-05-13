# D4 — Cross-session ModuleHost refcount

**Branch + ref:** `main` @ `f1d6cd2` (impl) + this doc commit; local-only on personal account per `memory/workflow_local_only_personal_account.md`.

**Predecessors:** [D0.5](2026-05-12-multi-session-supervisor-pattern.md) (foundation), [D1](2026-05-12-multi-session-supervisor-pattern.md) (supervisor `Map<SessionId, SessionEntry>` + `acquiredModules` placeholder), [D2](2026-05-13-d2-sessionid-rpc-envelopes.md) (RPC envelopes), [D3](2026-05-15-d3-per-session-services.md) (per-session services).

---

## What D4 actually was

The brief framed D4 as "cross-session ModuleHost refcount." The phrase implied two sessions on the same worktree share one `ModuleHostManager` and both register consumers against the same `(moduleId, scopeUnit)` key. **That architecture does not currently exist** — `createModuleSystem` runs per-boot, so each session has its own `ModuleHostManager` and its own subprocess set.

What D4 actually fixes:

> A single session may hold multiple outstanding `moduleHost.acquire()` results when `session/stop` fires. The supervisor's `stopEntry` must release every one before `services.dispose()` runs, or the subprocess leaks past the session's lifetime.

This is the bug class plan § F2 names as the "crash-mid-acquire consumer-set leak." The fix has two parts:

1. **`ModuleHostManager.recordAcquire` hook** ([manager.ts:55-76](../../src/core/module-host/manager.ts)) — fires exactly once per `(consumerId, moduleId, scopeUnit)` transition (absent→present in the holder set). Same-consumerId re-acquire is idempotent because the guard checks `consumers.has(consumerId)` before the `Set.add`, so the hook never duplicates an entry in the supervisor's array.

2. **Supervisor release walk** ([supervisor.ts:530-555](../../src/daemon/supervisor.ts)) — between `await bootInFlight` and `services.dispose()`, walks `entry.acquiredModules` and calls `services.moduleHost.release(...)` for each triple. Best-effort: a throwing release does not block subsequent releases or `dispose()`.

The reference-share between `entry.acquiredModules` (supervisor) and `services.acquiredModules` (boot factory) is set up in `bootAsync` at [supervisor.ts:507-513](../../src/daemon/supervisor.ts) — assigning `entry.acquiredModules = services.acquiredModules` post-boot. The same array reference is what the manager's `recordAcquire` callback closes over in `boot.ts:411-428`, so the three sites read/write one source of truth.

---

## Files touched

| File | Change |
|---|---|
| `src/core/module-host/manager.ts` | `recordAcquire?` option + hook firing on first-add transition |
| `src/modules/create-module-system.ts` | Forwards `recordAcquire` to the manager |
| `src/core/session/boot.ts` | Allocates `acquiredModules`, closes the recordAcquire callback over it, surfaces on `SessionServices` |
| `src/daemon/supervisor.ts` | `bootAsync` reference-shares the array; `stopEntry` inserts the release walk before `dispose()` |
| `src/daemon/fake-boot.ts` | Returns `acquiredModules: []` for the fake path |
| 3 daemon test fixtures (`supervisor-multi`, `supervisor-refcount`, `builder-build-hooks`) | Carry `acquiredModules: []` |

## Tests added

| File | Layer | Subprocess |
|---|---|---|
| `src/core/module-host/__tests__/refcount-cross-session.test.ts` | Manager unit (refcount + recordAcquire firing) | **Real** (echo fixture) |
| `src/core/module-host/__tests__/refcount-same-session-reacquire.test.ts` | Manager unit (idempotence) | **Real** (echo fixture) |
| `src/daemon/__tests__/supervisor-module-cleanup.test.ts` | Supervisor unit (release-before-dispose ordering, best-effort error handling) | Synthetic `release()` |
| `src/daemon/__tests__/supervisor-module-cleanup-real-subprocess.test.ts` | **Integration: supervisor + real `ModuleHostManager`** | **Real** (echo fixture) |

The fourth file is the integration-real-process layer the original D4 brief did not ask for. It catches:
- The reference-share between `entry.acquiredModules` and `services.acquiredModules` (a typo there silently breaks the walk because fake-boot's array stays empty regardless).
- The SIGTERM → 1s poll → SIGKILL ladder inside `ModuleHostManager.stopEntry` actually firing in response to the release walk's refcount drop.

---

## Validation gate

| Gate | Target | Result |
|---|---|---|
| vitest | 1412 baseline + new | **1420 passed + 2 skipped** (+8: 2 cross-session, 1 same-session, 3 supervisor cleanup, 2 supervisor real-subprocess) |
| tsc root non-ui | ≤ 4 baseline | **4** (App.tsx + AppContext.tsx + host-capability.test.ts + validated-profile-brand.test.ts) |
| tsc electron | clean | **clean** |
| playwright smoke | 13/13 + 4 REAL_BOOT skipped | **13 passed + 4 skipped** |

---

## Coverage matrix vs. `memory/feedback_test_parity_no_gaps.md`

The memory rule: every client (TUI, Electron, MCP) gets three layers — fast in-process, integration real-process, gated real-boot.

| Layer | Status | Notes |
|---|---|---|
| Fast in-process (manager refcount logic) | ✅ Covered | `refcount-cross-session` + `refcount-same-session-reacquire` — real subprocess, but in-process orchestration |
| Fast in-process (supervisor release walk) | ✅ Covered | `supervisor-module-cleanup` |
| Integration real-process (supervisor + real ModuleHostManager) | ✅ Covered | `supervisor-module-cleanup-real-subprocess` (NEW this session) |
| Per-client wire (TUI/Electron/MCP → daemon → supervisor) | ✅ Covered transitively | TUI is itself a daemon client per `src/app/client/`. All clients funnel into the same `session/stop` RPC → `supervisor.stopEntry`. D2's per-client `session/stop` wire is already tested in `client-rpcs.test.ts` and the existing per-client e2e suites; D4 sits behind that wire. |
| Gated real-boot (real daemon process + real third-party module subprocess + Metro alive) | ❌ Deferred to D7 | None of the bundled built-in modules currently exercise the per-worktree refcount path (built-ins are in-process or `global`-scope idle-shutdown), so a Playwright real-boot scenario for D4 specifically would require inventing fixture infrastructure beyond D4's scope. The right home is the multi-session real-boot probe in D7. |

The "cross-session ModuleHost refcount" name in the original brief was misleading: the production architecture has one manager per session, not one manager shared across sessions. The genuine D4 invariant is **per-session multi-acquire cleanup**, and that is fully covered above.

---

## Open work for D5+

- **D5 — ServiceBus per-session payloads.** Plan reference: [docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md § D5](../plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md#d5-servicebus-per-session-payloads).
- **D6 — fake-boot harness multi-session.** Smoke fixture boots two sessions.
- **D7 — real-boot multi-session probe.** Should explicitly include a scenario that exercises D4's release walk under a real third-party module subprocess. Update the D7 brief when written.
- **D8 — singleton-pin test flip.**

## Smoke-time orphan daemons — pre-existing, NOT D4

`npm run test:smoke` leaves orphan daemon processes (parent Playwright exits, daemons spawned in tmp worktrees stay alive). Reproduced before D4 changes; the smoke fixture's daemon-process lifecycle is separate from the session-supervisor `stopEntry` path D4 touched. Tracking via the D7 work-item — the multi-session real-boot probe should also assert "no daemon leaks after the harness exits."
