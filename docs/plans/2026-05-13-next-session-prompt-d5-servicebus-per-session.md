# Next session — handoff (2026-05-13) — Multi-session daemon D5

**State:** `main` is at commit `de01e0c` ("test(daemon): Phase D4 — integration-real-process layer + solution doc"), **10 commits ahead of origin** (D0.5 + D1 + D1 docs + D2 + D2 docs + D3 + D3 docs + D4 + D4 docs + D4 integration to land). Local-only per `memory/workflow_local_only_personal_account.md` — do not push.

**Gate status at handoff:**
- vitest: 1420 passed, 2 skipped — 1412 baseline + 8 new D4 specs (2 cross-session, 1 same-session, 3 supervisor cleanup, 2 supervisor real-subprocess)
- tsc root: 4 baseline preserved (App.tsx + AppContext.tsx + host-capability.test.ts + validated-profile-brand.test.ts)
- tsc electron: clean
- playwright smoke: 13/13 + 4 REAL_BOOT skipped

**Predecessor work:**
- Plan: [docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md](2026-05-12-feat-multi-session-daemon-and-electron-plan.md) (§ D5).
- D1 solution: [docs/solutions/2026-05-12-multi-session-supervisor-pattern.md](../solutions/2026-05-12-multi-session-supervisor-pattern.md).
- D2 solution: [docs/solutions/2026-05-13-d2-sessionid-rpc-envelopes.md](../solutions/2026-05-13-d2-sessionid-rpc-envelopes.md).
- D3 solution: [docs/solutions/2026-05-15-d3-per-session-services.md](../solutions/2026-05-15-d3-per-session-services.md).
- D4 solution: [docs/solutions/2026-05-15-d4-cross-session-modulehost-refcount.md](../solutions/2026-05-15-d4-cross-session-modulehost-refcount.md).

---

## What landed in Phase D4

- `ModuleHostManager.recordAcquire?` option ([manager.ts:55-76](../../src/core/module-host/manager.ts)) — fired exactly once per `(consumerId, moduleId, scopeUnit)` transition; same-consumerId re-acquire stays idempotent on the hook side (guarded by `consumers.has()` before `Set.add`).
- `bootSessionServices` allocates per-session `acquiredModules`, closes the recordAcquire callback over it, surfaces on `SessionServices`.
- `supervisor.bootAsync` reference-shares `entry.acquiredModules = services.acquiredModules` post-boot — single source of truth across manager + supervisor.
- `supervisor.stopEntry` inserts the release walk between `await bootInFlight` and `services.dispose()`. Best-effort: a throwing release does not block subsequent releases or dispose.
- **Architectural clarification surfaced this session:** each session has its own `ModuleHostManager` (`createModuleSystem` runs per-boot). The brief's "cross-session shared manager" framing was misleading — the real D4 invariant is per-session multi-acquire cleanup, not literal cross-session refcount. See [[code-fact-module-host-per-session]] and D4 solution doc.
- **Test layers:** manager unit (real echo subprocess) ×2, supervisor unit (synthetic release) ×1, **supervisor + real ModuleHostManager integration ×1** (NEW layer added beyond the original brief, per `memory/feedback_test_parity_no_gaps.md`).

| Item | Location | Purpose |
|---|---|---|
| `recordAcquire?` option | `src/core/module-host/manager.ts` | Fires on first-add of consumerId to the holder set |
| `acquiredModules: Array<{...}>` | `src/core/session/boot.ts` (SessionServices) | Reference-shared with supervisor's `entry.acquiredModules` |
| Release walk before dispose | `src/daemon/supervisor.ts:530-555` (stopEntry) | bootInFlight await → release acquired → dispose → delete entry |
| 4 new test files | `src/core/module-host/__tests__/refcount-*.test.ts` + `src/daemon/__tests__/supervisor-module-cleanup{,-real-subprocess}.test.ts` | Three layers across manager + supervisor + integration |

---

## What's next — Phase D5: ServiceBus per-session payloads

ServiceBus (`src/app/service-bus.ts`) is the non-React → React propagation layer in the TUI client. Today every emit is flat: `serviceBus.setMetro(metro)`, subscribers get `(metro)` only. With multi-session, the TUI may hold N sessions simultaneously — subscribers need a sessionId discriminator to filter to the active session.

### What D5 actually does

Every ServiceBus emit gains a `sessionId` field in the payload. Every `set*` / emit call site passes sessionId. Every subscriber filters on sessionId (or treats sessionId-tagged events as the new contract).

### Files to touch

| File | What changes |
|---|---|
| `src/app/service-bus.ts` | `ServiceBusEvents` payload types gain `sessionId: SessionId`; the singleton `serviceBus` keeps its EventEmitter shape but the topic payloads grow. Today 111 LOC; expect ~30 LOC of type widening. |
| All `serviceBus.set*` / `serviceBus.on(...)` call sites (~22 today) | Pass sessionId on emit; filter on receive. Concentrated in `src/app/AppContext.tsx`, `src/app/start-flow.ts`, and the TUI views that consume them. |
| `src/app/__tests__/service-bus-multi-session.test.ts` (NEW) | Register two Metros for two sessions; subscriber receives both events tagged with distinct sessionIds; filter-by-sessionId works correctly. |

### Key implementation decisions

1. **Wire the sessionId on `services.sessionId`** — D3 added this field to SessionServices, D2 brands `SessionId` properly. Use the brand throughout the ServiceBus type signatures.

2. **Don't add a per-sessionId Map inside ServiceBus.** Keep the bus a flat EventEmitter; subscribers filter. The Map-keyed surface lives at the consumer side (the AppContext reducer). Simpler, matches the daemon-side pattern of `Map<SessionId, …>` living in the supervisor and not in `EventEmitter` event payloads.

3. **Subscriber migration:** every existing `serviceBus.on("metro", (metro) => …)` becomes `serviceBus.on("metro", ({ sessionId, metro }) => …)` — flat parameter to destructured object. The AppContext subscribers can keep their single-session behavior by ignoring sessionId initially (TUI is still effectively single-session in v1); D6/D7 will exercise the multi-session path. **No behavior change in v1, just shape.**

4. **The serviceBus singleton at module scope is fine** — it's an event router, not session state. The state per session lives in AppContext / the supervisor.

### What NOT to touch in D5

- `src/core/module-host/*` — D4 stable.
- `src/core/metro.ts` / `src/core/devtools.ts` / `src/core/builder.ts` — D3 stable.
- `src/daemon/index.ts` + `src/daemon/client-rpcs.ts` — D2/D3 stable.
- `src/daemon/supervisor.ts` — D4 stable.
- `electron/ipc/*` — Phase E.
- Real-boot — D7.

D5 is `src/app/service-bus.ts` + ~22 call-site touches + 1 new test. ~150 lines new + ~50 sites touched.

---

## Validation gate (per CLAUDE.md three-layer rule)

Before claiming D5 complete:

1. `npx vitest run` — preserve the 1420 baseline + new specs green.
2. `npx tsc --noEmit` — no NEW errors beyond today's baseline (4 total). Confirm with `npx tsc --noEmit 2>&1 | grep -v "src/ui/" | grep "error TS" | wc -l` returning ≤ 4.
3. `npx tsc --noEmit -p electron/tsconfig.json` — clean.
4. `npm run test:smoke` — 13/13 green.
5. **D5 does NOT require real-boot.** That's D7.

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
- **No `any` / `unknown`** in production code (one documented escape hatch in `src/app/service-bus.ts` — D5 should NOT add another).
- **Conventional Commits.** `feat(tui): Phase D5 — ServiceBus per-session payloads`.
- **Imports use `.js` extension** (ESM NodeNext rule).
- **Test parity:** per `memory/feedback_test_parity_no_gaps.md`, every client (TUI, Electron, MCP) gets three test layers (fast in-process + integration real-process + gated real-boot). For D5, the integration real-process layer is the AppContext subscriber test; real-boot stays D7. Don't structure options as "accept the gap vs. build it."

## Effort estimate

D5: ~0.5 day focused. The ServiceBus type change is mechanical; the call-site fan-out is repetitive. The slowest part will be the TUI subscriber path in AppContext.tsx — verify each subscriber's destructuring matches the new shape.

## After D5

D6 (fake-boot harness multi-session — smoke fixture boots two sessions) → D7 (real-boot multi-session probe — the merge gate for the multi-session arc, must also exercise D4's release walk under a real third-party module subprocess) → D8 (flip singleton-pin test from "only one session" → "many sessions").

Then Phases M1-M6 + E1-E6.5 + T1-T2 + X1-X3 in parallel as the plan allows.

The full sequence + dependency graph lives in [the plan § Implementation Phases](2026-05-12-feat-multi-session-daemon-and-electron-plan.md#implementation-phases) and the consolidated decomposition in [§ I](2026-05-12-feat-multi-session-daemon-and-electron-plan.md#i-phase-decomposition-consolidation).
