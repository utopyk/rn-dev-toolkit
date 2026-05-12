# Next session — handoff (2026-05-14) — Multi-session daemon D2

**State:** `main` is at commit `0dde48e` ("feat(daemon): Phase D1 — supervisor multi-session Map<SessionId, SessionEntry>"), **3 commits ahead of origin** (D0.5 `7c9f7a2` + handoff `9b82555` + D1 `0dde48e`). Local-only per `memory/workflow_local_only_personal_account.md` — do not push.

**Gate status at handoff:**
- vitest: 1387 passed, 2 skipped (PROBE-only)
- tsc root: 137 pre-existing baseline errors (133 in `src/ui/*` + 4 elsewhere — all pre-existing); **zero in new/modified files**
- tsc electron: clean
- playwright smoke: 13/13 passed

**Predecessor plan:** [docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md](2026-05-12-feat-multi-session-daemon-and-electron-plan.md). D1 detail captured in [docs/solutions/2026-05-12-multi-session-supervisor-pattern.md](../solutions/2026-05-12-multi-session-supervisor-pattern.md). This prompt drives Phase D2.

---

## What landed in Phase D1 (today, 2026-05-12)

The `DaemonSupervisor` now stores `Map<SessionId, SessionEntry>` and exposes a per-session API alongside the legacy single-session facade. Wire protocol unchanged — D2 lights it up.

| Item | Location | Purpose |
|---|---|---|
| `Map<SessionId, SessionEntry>` storage | `src/daemon/supervisor.ts` | One entry per session; flat singleton fields removed |
| Per-session primary API | `src/daemon/supervisor.ts` | `startSession`, `attachToSession`, `stopSession`, `getSessionServices`, `getSessionState`, `getSessionEntry`, `listSessions`, `findSessionByProfile`, `releaseConnectionFromAllSessions`, `shutdown` |
| Legacy single-session facade | `src/daemon/supervisor.ts` | `start`, `stop`, `attach`, `release`, `getServices`, `getState`, `getAttachedCount`, `getSessionWorktreeKey` — preserve today's `index.ts` behavior; **D2 deletes these** |
| `SessionEvent.sessionId` on every variant | `src/daemon/session.ts` | Generic `SessionEventEnvelope<K, D>` — both `worktreeKey` and `sessionId` (DR-5) |
| `acquiredModules: []` placeholder on every entry | `src/daemon/supervisor.ts` | D4 ModuleHost cross-session refcount will populate |
| 8 new unit tests | `src/daemon/__tests__/supervisor-multi.test.ts` | Concurrent sessions, event tagging, `E_SESSION_ALREADY_EXISTS`, `E_PORT_CONFLICT`, `E_UNKNOWN_SESSION`, isolation, `findSessionByProfile`, `shutdown` |
| 1 new per-session-isolation test | `src/daemon/__tests__/supervisor-refcount.test.ts` | Architecture finding #2 invariant pinned |

**Use the per-session API in D2 — don't touch the legacy facade except to delete it.**

---

## What's next — Phase D2: thread sessionId through RPC envelopes

[src/daemon/index.ts](../../src/daemon/index.ts) RPC dispatchers still consume the single-session world: `session/start` mints in the supervisor, `session/stop` takes no sessionId, `events/subscribe` identifies by profile. D2 threads sessionId through every dispatcher and lights up the multi-session wire protocol.

### Files to touch

| File | What changes |
|---|---|
| `src/daemon/index.ts` | Every RPC dispatcher at `:339-660` reads sessionId (`requireSessionId` / `optionalSessionId`) and forwards to the per-session supervisor API. `events/subscribe` adopts the `parseEventsSubscribeInput` discriminated union (D0.5 narrower). Add `sessions/list` handler. Add `daemon/shutdown` → `supervisor.shutdown()` (currently `supervisor.stop()`). |
| `src/daemon/client-rpcs.ts` | `handleClientRpc` resolves services via `supervisor.getSessionServices(sessionId)` instead of `getServices()`. Every action under `CLIENT_RPC_ACTIONS` reads `requireSessionId(payload, action)`. |
| `src/app/client/session.ts` | `parseSessionEventEnvelope` parses `sessionId` field (currently drops it). `DaemonSession` exposes `.sessionId` (server-minted, returned by `events/subscribe`). |
| `src/daemon/supervisor.ts` | **Delete** the legacy single-session facade once index.ts uses the per-session API. Tighten `SessionEntry.activeProfile` to `ValidatedProfile`. |
| `src/daemon/__tests__/session-boot.test.ts:287` | DO NOT flip yet — that's D8. Keep asserting `E_SESSION_ALREADY_RUNNING` for the single-session world by routing through whatever back-compat shape D2 keeps for that test until D8. |
| `src/daemon/__tests__/subscribe-semantics.test.ts` (NEW) | Two-cell `events/subscribe` matrix: `{ profile }` boot-or-join, `{ sessionId }` attach-by-id. Both-fields rejection with `E_SUBSCRIBE_INVALID_ARGS`. Neither-fields rejection (observer mode CUT per § B2). |
| `src/daemon/__tests__/sessions-list.test.ts` (NEW) | `sessions/list` returns a snapshot of every active entry; status, profile name, worktreeKey, services snapshot. |
| `src/daemon/__tests__/session-events-envelope.test.ts` (NEW) | Every fanned-out `SessionEvent` carries a non-empty `sessionId`; client-side parser routes correctly. |

### Key implementation decisions (carried from D1 deepening review)

Read [plan § A8 + § B2 + § C1.A4](2026-05-12-feat-multi-session-daemon-and-electron-plan.md) before coding. The non-obvious ones:

1. **`findSessionByProfile` race lock** (plan § A8) — `events/subscribe { profile }` is read-then-write. Two simultaneous subscribers for the same `(worktreeKey, profile.name)` can both miss the existing match and both boot. Solution: per-`(worktreeKey, profile.name)` lock or check-and-set returning `E_PROFILE_BOOT_IN_FLIGHT` (already in `SessionErrorCode` union from D0.5) with the in-flight sessionId so the loser joins.

   Lock state lives at the index.ts dispatcher layer (a `Map<string, Promise<SessionId>>` keyed by `${worktreeKey}:${profileName}`), NOT in the supervisor. The supervisor's `findSessionByProfile` stays a pure read.

2. **`events/subscribe` matrix shrinks from 4 cells to 2** (plan § B2):
   - `{ profile }` → boot-or-join, returns `{ subscribed: true, sessionId }`
   - `{ sessionId }` → attach-by-id, returns `{ subscribed: true, sessionId }`
   - `{ profile && sessionId }` → `E_SUBSCRIBE_INVALID_ARGS`
   - `{ neither }` → `E_SUBSCRIBE_INVALID_ARGS` (observer mode CUT — rehydration goes through `sessions/list`)

3. **New `sessions/list` RPC** (plan § B2) — synchronous snapshot, no events, no subscription:
   ```ts
   sessions/list { } → {
     sessions: Array<{
       sessionId: SessionId;
       profileName: string;
       worktreeKey: string;
       status: SessionStatus;
       services: ServicesSnapshot | null;
     }>
   }
   ```
   Closes spec-flow gaps from D0.5 deepening (renderer-rehydration, MCP cold-start, `E_UNKNOWN_SESSION` recovery).

4. **`E_SESSION_AMBIGUOUS` payload carries candidates** (plan § B2):
   ```ts
   { code: "E_SESSION_AMBIGUOUS", message: "...", data: { availableSessions: [{ sessionId, profileName }] } }
   ```
   So a client that calls `session/stop` without `sessionId` against a multi-session daemon gets the list back in the same round-trip. `SessionAmbiguousData` is already exported from `src/daemon/error-codes.ts` (D0.5).

5. **session/start returns the minted sessionId** (plan wire-protocol):
   ```ts
   session/start { profile } → { status: "starting", sessionId }
   ```
   Today's clients ignore sessionId; D2 client (`src/app/client/session.ts`) reads + stores it.

6. **Delete the legacy facade carefully.** After all `index.ts` call sites use the per-session API, audit the supervisor for the methods listed under "Legacy single-session facade" in the D1 commit and delete them. Run vitest + tsc to confirm nothing outside index.ts/client-rpcs.ts/tests was calling them.

### What NOT to touch in D2

- `src/core/metro.ts`, `src/core/devtools.ts` — that's D3 (per-session services, composite/sessionId-only Map keying).
- `src/core/builder.ts` — that's D3 (Promise-returning `build()`).
- `electron/ipc/*` — that's Phase E.
- `src/mcp/*` — that's Phase M.
- `src/core/module-host/*` — that's D4 (cross-session refcount).

D2 is `src/daemon/index.ts` + `src/daemon/client-rpcs.ts` + the client-side parser + supervisor cleanup. Wire-protocol-shape and dispatcher logic only.

---

## Validation gate (per CLAUDE.md three-layer rule)

Before claiming D2 complete:

1. `npx vitest run` — all new specs + existing baseline preserved (today: 1387 passed, 2 skipped). Add at minimum the three new test files listed under "Files to touch."
2. `npx tsc --noEmit` — no NEW errors beyond today's baseline (137 total, 133 in `src/ui/*` + 4 elsewhere). Confirm with `npx tsc --noEmit 2>&1 | grep -v "src/ui/" | grep "error TS" | wc -l` returning ≤ 4.
3. `npx tsc --noEmit -p electron/tsconfig.json` — must stay clean.
4. `npm run test:smoke` — 13/13 must stay green. The smoke suite drives the daemon-spawn + boot path; D2's index.ts rewire is the highest risk for a smoke regression.
5. **D2 specifically does NOT require real-boot.** That's D7. D2's contract is the wire protocol; real-boot proves product behavior at D7.

Pre-flight cleanup (per the existing pattern):
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
- **No `any` / `unknown`** in production code (one documented escape hatch in `src/app/service-bus.ts`). Brands + narrowers from D0.5 prevent leakage at the new RPC boundaries.
- **Conventional Commits.** `feat(daemon): Phase D2 — thread sessionId through RPC envelopes`.
- **Imports use `.js` extension** (ESM NodeNext rule). D0.5 + D1 files already follow this; mirror.

## Effort estimate

D2: ~1 day focused. Per-handler refactor is mechanical (8-10 RPC dispatchers × ~10 lines each); the load-bearing work is the `events/subscribe` race lock, the new `sessions/list` handler, and the client-side `sessionId` plumbing through `DaemonSession`. Budget ~250 lines of new code + ~80 sites touched across index.ts + client-rpcs.ts + client/session.ts.

## After D2

D3 (per-session services + composite/sessionId-only Metro/DevTools keying + Promise-returning Builder) → D4 (cross-session ModuleHost refcount) → D7 (real-boot multi-session probe) → D8 (flip singleton-pin test). Then Phases M1-M6 + E1-E6.5 + T1-T2 + X1-X3 in parallel as the plan allows.

The full sequence + dependency graph lives in [the plan § Implementation Phases](2026-05-12-feat-multi-session-daemon-and-electron-plan.md#implementation-phases) and the consolidated decomposition in [§ I](2026-05-12-feat-multi-session-daemon-and-electron-plan.md#i-phase-decomposition-consolidation).
