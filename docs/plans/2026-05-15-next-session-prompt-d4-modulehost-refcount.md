# Next session — handoff (2026-05-15) — Multi-session daemon D4

**State:** `main` is at commit `9f584f7` ("feat(core): Phase D3 — per-session Metro/DevTools/Builder + Promise-returning build"), **7 commits ahead of origin** (D0.5 + D1 + D1 docs + D2 + D2 docs + D3 + D3 docs to land). Local-only per `memory/workflow_local_only_personal_account.md` — do not push.

**Gate status at handoff:**
- vitest: 1412 passed, 2 skipped — 1399 baseline + 13 new D3 specs
- tsc root: 4 baseline preserved (App.tsx + AppContext.tsx + host-capability.test.ts + validated-profile-brand.test.ts)
- tsc electron: clean
- playwright smoke: 13/13 + 4 REAL_BOOT skipped

**Predecessor work:**
- Plan: [docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md](2026-05-12-feat-multi-session-daemon-and-electron-plan.md).
- D1 solution: [docs/solutions/2026-05-12-multi-session-supervisor-pattern.md](../solutions/2026-05-12-multi-session-supervisor-pattern.md).
- D2 solution: [docs/solutions/2026-05-13-d2-sessionid-rpc-envelopes.md](../solutions/2026-05-13-d2-sessionid-rpc-envelopes.md).
- D3 solution: [docs/solutions/2026-05-15-d3-per-session-services.md](../solutions/2026-05-15-d3-per-session-services.md).

---

## What landed in Phase D3

The in-process state machines (MetroManager / DevToolsManager / Builder) now key by SessionId alone. worktreeKey is metadata. Builder's `build()` returns a `BuildHandle = { buildId, promise, cancel }`; `client-rpcs.ts:308` awaits `handle.promise` for the `build/post` hook fire, closing the pre-D3 `.once("done")` cross-talk + listener-leak vectors. SessionServices gains a `sessionId` field; `bootSessionServices` threads it from the supervisor's `entry.sessionId`.

| Item | Location | Purpose |
|---|---|---|
| `Map<SessionId, MetroInstance>` | `src/core/metro.ts` | start({ sessionId, worktreeKey, ... }); stop/reload/devMenu/getInstance take SessionId. |
| `Map<SessionId, SessionState>` | `src/core/devtools.ts` | start(sessionId) lifts worktreeKey off the resolved MetroInstance. listNetwork/getNetwork/clear/status/cursor/selectTarget/restart take SessionId. |
| `BuildHandle` | `src/core/builder.ts` | { buildId, promise, cancel }. Internal per-build deferred. dispose() awaits the resolver chain. |
| `services.sessionId` | `src/core/session/boot.ts` | New `SessionServices` field; sessionId required on `BootSessionServicesOptions`. |
| Devtools host-capability per-session | `src/core/devtools/host-capability.ts` | Capability constructed with a sessionId; routes every call to it; worktreeKey check survives as cross-worktree leak guard. |
| 13 new specs | `src/core/__tests__/metro-multi-session.test.ts` + `devtools-multi-session.test.ts` + `builder-per-session.test.ts` | Pin the Map-key flip, promise contract, concurrency-guard correctness. |

**Use the per-session API in D4 — call sites pass `services.sessionId` or thread it via the supervisor.**

---

## What's next — Phase D4: cross-session ModuleHost refcount

`src/core/module-host/manager.ts` already has the `keyFor(moduleId, scopeUnit)` composite-key plumbing (D4 is intentionally a different scope axis from the M-phase MCP work). The supervisor's `SessionEntry.acquiredModules: Array<{ moduleId; scopeUnit; consumerId }>` was pre-allocated in D1 specifically for this phase — D3 left it empty.

### What D4 actually does

Two sessions for the same worktree both end up acquiring the same `(moduleId, scopeUnit)` modules during boot. The current ModuleHostManager spawns the subprocess on first acquire and shuts it down on last release. With multi-session, "last release" must be a refcount-style walk: track every (sessionId, moduleId, scopeUnit) acquire on the consumer side, decrement when the session disposes, only spawn-down on zero refs across all sessions.

### Files to touch

| File | What changes |
|---|---|
| `src/core/module-host/manager.ts` | Refactor `acquire`/`release` to maintain a refcount per `keyFor(moduleId, scopeUnit)`. Spawn-up on first acquire (rc=1); spawn-down on last release (rc=0). Idempotent re-acquire by the same `consumerId` is a no-op (prevents double-count from a session that re-attaches mid-boot). |
| `src/core/session/boot.ts` | When `bootSessionServices` triggers initial module activation, record each acquire on `entry.acquiredModules` via a new supervisor callback or by passing the supervisor reference into the boot factory. The cleanest seam: surface `services.acquiredModules` as the canonical list and have the supervisor `stopEntry` walk it on teardown. |
| `src/daemon/supervisor.ts` | `stopEntry` walks `entry.acquiredModules` and calls `services.moduleHost.release({ moduleId, scopeUnit, consumerId })` for each. Order matters: release modules BEFORE `services.dispose()` so the module subprocess shutdown sees the refcount drop before the host capability registry tears down. |
| `src/core/module-host/__tests__/refcount-cross-session.test.ts` (NEW) | Two sessions acquire the same `(moduleId, scopeUnit)`. First session releases — subprocess stays alive (rc=1). Second session releases — subprocess shuts down (rc=0). Asserts no spurious spawn churn in between. |
| `src/core/module-host/__tests__/refcount-same-session-reacquire.test.ts` (NEW) | One session re-acquires the same `(moduleId, scopeUnit, consumerId)` triple — no double-count. Release-once still drops to rc=0. |
| `src/daemon/__tests__/supervisor-module-cleanup.test.ts` (NEW) | `stopEntry` walks acquiredModules in order. Concurrent stop of two sessions both holding the same module → only the second teardown emits `state-changed: idle`. |

### Key implementation decisions (carried from plan deepening)

Read [plan § A architecture finding refinement on D4](2026-05-12-feat-multi-session-daemon-and-electron-plan.md) before coding. The non-obvious ones:

1. **Consumer-id is `sessionId`, not a derived key.** The supervisor mints sessionIds; ModuleHostManager treats them as opaque strings. Same-session re-acquire of the same `(moduleId, scopeUnit)` is idempotent because the consumerId already exists in the holder set.

2. **acquiredModules is populated by the manifest-activation step inside `createModuleSystem`**, not bootSessionServices directly. The cleanest hook: pass a `recordAcquire(moduleId, scopeUnit, consumerId)` callback into createModuleSystem; default impl is no-op for fake-boot.

3. **Refcount is per `keyFor(moduleId, scopeUnit)`, not per moduleId alone.** Two scopeUnits of the same moduleId are independent subprocesses (one per worktree+module pair).

4. **stopEntry teardown order:** await `bootInFlight` → release acquiredModules → `services.dispose()` → delete entry. The await-bootInFlight is already in place from D1 (`memory/single_branch_single_worktree.md` references the bug class this fixes); the new step slots between bootInFlight and dispose.

### What NOT to touch in D4

- `src/core/metro.ts` / `src/core/devtools.ts` / `src/core/builder.ts` — D3's per-session shape is stable.
- `src/daemon/index.ts` + `src/daemon/client-rpcs.ts` — D2/D3's RPC layer is stable.
- `electron/ipc/*` — Phase E.
- `src/mcp/*` — Phase M.
- `src/app/service-bus.ts` — D5.
- Real-boot — D7.

D4 is `src/core/module-host/*` + a supervisor seam + boot wiring + 3 new tests. ~300 lines new + ~50 sites touched.

---

## Validation gate (per CLAUDE.md three-layer rule)

Before claiming D4 complete:

1. `npx vitest run` — preserve the 1412 baseline + new specs green. The new specs should add at minimum the three files listed under "Files to touch."
2. `npx tsc --noEmit` — no NEW errors beyond today's baseline (4 total). Confirm with `npx tsc --noEmit 2>&1 | grep -v "src/ui/" | grep "error TS" | wc -l` returning ≤ 4.
3. `npx tsc --noEmit -p electron/tsconfig.json` — clean.
4. `npm run test:smoke` — 13/13 green. The refcount path touches teardown, which the smoke fixture exercises through `await daemon.stop()` between scenarios.
5. **D4 specifically does NOT require real-boot.** That's D7.

Pre-flight cleanup:
```
pkill -9 -f "src/index.tsx daemon"
lsof -aP -i :8081 -sTCP:LISTEN -t | xargs -r kill -9
lsof -aP -i :8082 -sTCP:LISTEN -t | xargs -r kill -9
```

**Note the `-a` flag** — per `memory/lsof_gotchas.md`, omitting it ORs the selectors on macOS and returns wrong PIDs.

---

## Constraints carried forward

- **Single branch (`main`), single worktree (repo root).** Never create `claude/*`, `feat/*`, `fix/*` branches. Never `git worktree add`. Per `memory/single_branch_single_worktree.md`.
- **Local-only on this account.** No push, no PR, no review chain. Per `memory/workflow_local_only_personal_account.md`.
- **No `any` / `unknown`** in production code (one documented escape hatch in `src/app/service-bus.ts`). D0.5 brands + narrowers prevent leakage at the new boundaries.
- **Conventional Commits.** `feat(core): Phase D4 — cross-session ModuleHost refcount`.
- **Imports use `.js` extension** (ESM NodeNext rule).

## Effort estimate

D4: ~1 day focused per the plan's phase decomposition table. The refcount logic is mechanical; the integration point with `bootSessionServices` is where the surface area expands. The supervisor teardown order is already half-built (the bootInFlight await), so D4 mostly adds the release-walk in between.

## After D4

D5 (ServiceBus per-session payloads — TUI's React fan-out) → D6 (fake-boot harness multi-session — smoke fixture boots two sessions) → D7 (real-boot multi-session probe — the merge gate for the multi-session arc) → D8 (flip singleton-pin test from "only one session" → "many sessions").

Then Phases M1-M6 + E1-E6.5 + T1-T2 + X1-X3 in parallel as the plan allows.

The full sequence + dependency graph lives in [the plan § Implementation Phases](2026-05-12-feat-multi-session-daemon-and-electron-plan.md#implementation-phases) and the consolidated decomposition in [§ I](2026-05-12-feat-multi-session-daemon-and-electron-plan.md#i-phase-decomposition-consolidation).
