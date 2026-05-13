# Next session — handoff (2026-05-15) — Multi-session daemon D3

**State:** `main` is at commit `63a0dd2` ("feat(daemon): Phase D2 — thread sessionId through RPC envelopes"), **5 commits ahead of origin** (D0.5 `7c9f7a2` + D1 handoff `9b82555` + D1 `0dde48e` + D1 docs `13d5789` + D2 `63a0dd2`). Local-only per `memory/workflow_local_only_personal_account.md` — do not push.

**Gate status at handoff:**
- vitest: 1399 passed, 2 skipped (PROBE-only) — 1387 baseline + 12 new D2 specs
- tsc root: 4 pre-existing baseline (App.tsx + AppContext.tsx + host-capability.test.ts + validated-profile-brand.test.ts); zero in modified files
- tsc electron: clean
- playwright smoke: 13/13 passed + 4 REAL_BOOT skipped

**Predecessor work:**
- Plan: [docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md](2026-05-12-feat-multi-session-daemon-and-electron-plan.md).
- D1 solution: [docs/solutions/2026-05-12-multi-session-supervisor-pattern.md](../solutions/2026-05-12-multi-session-supervisor-pattern.md).
- D2 solution: [docs/solutions/2026-05-13-d2-sessionid-rpc-envelopes.md](../solutions/2026-05-13-d2-sessionid-rpc-envelopes.md).

---

## What landed in Phase D2 (today, 2026-05-13)

The wire-protocol-shape phase is done. The supervisor only speaks SessionId; the dispatcher layer threads sessionId through every RPC; `sessions/list` is live; the client-side `DaemonSession` exposes `.sessionId`; observer mode is CUT.

| Item | Location | Purpose |
|---|---|---|
| Legacy facade deleted | `src/daemon/supervisor.ts` | `start/stop/attach/release/getServices/getState/getAttachedCount/getSessionWorktreeKey` gone. `activeProfile: ValidatedProfile`. |
| Per-session dispatchers | `src/daemon/index.ts` | All RPC handlers use per-session API + `optionalSessionId`/`parseEventsSubscribeInput` narrowers. |
| `sessions/list` RPC | `src/daemon/index.ts` | Sync snapshot — closes spec-flow gaps. |
| Boot-in-flight lock | `src/daemon/index.ts` | `bootLocks: Map<key, Promise<BootLockResult>>` at dispatcher layer (plan § A8). |
| `events/subscribe` matrix | `src/daemon/index.ts` | 2 cells: `{profile}` boot-or-join, `{sessionId}` attach-by-id; both/neither → `E_SUBSCRIBE_INVALID_ARGS`. |
| Client `.sessionId` | `src/app/client/session.ts` | Branded `SessionId` from subscribe ack; `parseSessionEventEnvelope` requires sessionId. |
| Per-session services resolver | `src/daemon/client-rpcs.ts` | `resolveSessionServices` with 0/1/2+ active fallback (`E_SESSION_AMBIGUOUS` with candidates). |
| 12 new specs | `src/daemon/__tests__/subscribe-semantics.test.ts` + `sessions-list.test.ts` + `session-events-envelope.test.ts` | Pin the 2-cell input matrix, sessions/list shape, every-event-tagged invariant. |

**Use the per-session API in D3 — the supervisor only speaks SessionId now.**

---

## What's next — Phase D3: per-session services + Promise-returning Builder + composite-key Metro/DevTools

The daemon-side wire is in place. D3 lights up the in-process services so concurrent sessions for the same worktree (different profiles, different Metro ports) can coexist without their per-worktree Maps colliding.

### Files to touch

| File | What changes |
|---|---|
| `src/core/metro.ts` | `MetroManager` Map keyed by `SessionId` alone (per simplicity reviewer's stronger cut, plan § A architecture finding refinement). `worktreeKey` becomes metadata on the value, not part of the key. `startMetro({ sessionId, worktreeKey, ... })` is the new signature. |
| `src/core/devtools.ts` | Same refactor — `Map<SessionId, DevToolsState>` keyed by sessionId, `worktreeKey` is a value field. |
| `src/core/builder.ts` | **Promise-returning `Builder.build()`** (plan § B3, DR-8 augmentation): `build(opts): BuildHandle` where `BuildHandle = { buildId; promise: Promise<BuildResult>; cancel() }`. Internal `.once("done")` is wrapped, so the listener-leak vector at the API boundary disappears. Per-session Builder lifecycle: one Builder instance per session; `dispose()` kills any in-flight build subprocess. |
| `src/core/session/boot.ts` | `bootSessionServices` returns services keyed by sessionId. The `worktreeKey` field stays on `SessionServices` for downstream consumers; key identity flips to sessionId. |
| `src/daemon/client-rpcs.ts:201` | `services.builder.build(opts)` returns a `BuildHandle`. Replace the `services.builder.once("done", ...)` post-hook wiring with `await handle.promise`. The hook fire still runs after the build settles — but as the awaited continuation, not a leaked listener. |
| `src/core/__tests__/metro-multi-session.test.ts` (NEW) | Two `MetroManager.startMetro` calls with same worktreeKey but different sessionIds, two MetroInstance entries appear, ports don't collide. |
| `src/core/__tests__/devtools-multi-session.test.ts` (NEW) | Same pattern. |
| `src/core/__tests__/builder-per-session.test.ts` (NEW) | Two Builder instances run concurrent builds; `BuildHandle.promise` resolves correctly for each. Asserts iOS+Android in same session both fire from one Builder without `.once("done")` cross-talk. |

### Key implementation decisions (carried from plan deepening)

Read [plan § A architecture finding refinement](2026-05-12-feat-multi-session-daemon-and-electron-plan.md) + [§ B3 DR-8 augmentation](2026-05-12-feat-multi-session-daemon-and-electron-plan.md#b3-dr-8--augment-with-promise-returning-builder-not-replace) before coding. The non-obvious ones:

1. **Map key is `SessionId` alone, not composite `(worktreeKey, sessionId)`** — simplicity reviewer pushed for the stronger cut. SessionId is unique by construction; `worktreeKey` is metadata, not identity. Plan was updated to adopt this. Avoid the composite-key trap from the original plan text.

2. **Promise-returning Builder kills two birds** — per-session ownership alone doesn't fix the existing `.once("done")` cross-talk: `auto-build.ts:triggerBuildsIfNeeded` already fires iOS+Android concurrently against one Builder, and the listener-leak vector at `client-rpcs.ts:201` survives whether Builder is per-session or shared. The Promise wrapping closes the API-boundary leak for free.

3. **Dispose kills in-flight subprocesses** — when `stop(sessionId)` fires, `SessionServices.dispose()` must terminate any in-flight build subprocess owned by that session's Builder. The supervisor already awaits `entry.bootInFlight` before disposing in `stopEntry`; the symmetric pattern is `services.dispose()` awaits build subprocess termination.

4. **Existing single-session callers keep working** — every session has exactly one Metro/DevTools/Builder per sessionId, so single-session call sites (one session at a time) see no behavior change. The key flip is invisible at the call site.

### What NOT to touch in D3

- `src/daemon/index.ts` + `src/daemon/client-rpcs.ts` — D2's dispatchers + service resolver are stable. D3 changes happen one layer down.
- `electron/ipc/*` — that's Phase E.
- `src/mcp/*` — that's Phase M.
- `src/core/module-host/*` — that's D4 (cross-session refcount).
- `src/app/service-bus.ts` — that's D5 (per-session payloads).
- Real-boot — that's D7.

D3 is `src/core/metro.ts` + `src/core/devtools.ts` + `src/core/builder.ts` + `src/core/session/boot.ts` + one callsite in `client-rpcs.ts`. In-process state-machine changes only.

---

## Validation gate (per CLAUDE.md three-layer rule)

Before claiming D3 complete:

1. `npx vitest run` — all new specs + existing baseline preserved (today: 1399 passed, 2 skipped). Add at minimum the three new test files listed under "Files to touch."
2. `npx tsc --noEmit` — no NEW errors beyond today's baseline (4 total: App.tsx + AppContext.tsx + host-capability.test.ts + validated-profile-brand.test.ts). Confirm with `npx tsc --noEmit 2>&1 | grep -v "src/ui/" | grep "error TS" | wc -l` returning ≤ 4.
3. `npx tsc --noEmit -p electron/tsconfig.json` — must stay clean.
4. `npm run test:smoke` — 13/13 must stay green. D3's Metro/DevTools/Builder rewires are high risk here because the smoke fixture boots the daemon end-to-end.
5. **D3 specifically does NOT require real-boot.** That's D7. D3's contract is the in-process state machine; real-boot proves product behavior at D7.

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
- **Conventional Commits.** `feat(core): Phase D3 — per-session Metro/DevTools/Builder + Promise-returning build`.
- **Imports use `.js` extension** (ESM NodeNext rule). D0.5 + D1 + D2 files already follow this; mirror.

## Effort estimate

D3: ~1.5 days focused per the plan's phase decomposition table. The Map-key flip in Metro + DevTools is mechanical (~150 lines + ~30 callsites each). The Promise-returning Builder is the load-bearing change — wrapping `.once("done")` internally, threading `buildId` through events, and rewiring the `auto-build.ts` + `client-rpcs.ts:201` post-hook callsite. Budget ~400 lines of new code + ~100 sites touched.

## After D3

D4 (cross-session ModuleHost refcount — `acquiredModules: []` is already pre-allocated on every entry, just needs the consumer-set walk) → D5 (ServiceBus per-session payloads) → D6 (fake-boot harness multi-session) → D7 (real-boot multi-session probe — the merge gate) → D8 (flip singleton-pin test).

Then Phases M1-M6 + E1-E6.5 + T1-T2 + X1-X3 in parallel as the plan allows.

The full sequence + dependency graph lives in [the plan § Implementation Phases](2026-05-12-feat-multi-session-daemon-and-electron-plan.md#implementation-phases) and the consolidated decomposition in [§ I](2026-05-12-feat-multi-session-daemon-and-electron-plan.md#i-phase-decomposition-consolidation).
