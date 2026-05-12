# Next session — handoff (2026-05-13) — Multi-session daemon D1

**State:** `main` is at commit `7c9f7a2` ("feat(daemon): Phase D0.5 — multi-session foundation types + plan"), **1 commit ahead of origin**. Local-only per `memory/workflow_local_only_personal_account.md` — do not push.

**Gate status at handoff:**
- vitest: 1378 passed, 2 skipped (PROBE-only)
- tsc root: 137 pre-existing baseline errors in `src/ui/*`, **zero in new/modified files**
- tsc electron: clean
- playwright smoke: 13/13 passed

**Predecessor plan:** [docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md](2026-05-12-feat-multi-session-daemon-and-electron-plan.md). This prompt drives Phase D1.

---

## What landed in Phase D0.5 (today, 2026-05-12)

Six TypeScript-foundation items the deepening review identified as prerequisites for D1+. **None change behavior** — all additive or transparent refactor.

| Item | Location | Purpose |
|---|---|---|
| Branded `SessionId` + `WorktreeKey` | `src/core/identifiers.ts` | UUID-minted SessionId, brand-enforced ids (mirrors `ValidatedProfile`) |
| `SessionErrorCode` union + `RpcResult<T>` + `SessionAmbiguousData` | `src/daemon/error-codes.ts` | Central error-code declaration so D1+ renames don't land silently |
| `requireSessionId` / `optionalSessionId` / `requireProfile` / `parseEventsSubscribeInput` / `RpcArgError` | `src/daemon/rpc-args.ts` | RPC payload narrowers in the `packages/module-sdk/src/args.ts` idiom |
| `EventsSubscribeInput` discriminated union | `src/daemon/rpc-args.ts` (alongside parser) | Makes `{ profile && sessionId }` cell unrepresentable; replaces 4-cell matrix with 2-cell |
| Exhaustive switch on `ModuleScope` | `src/core/module-host/manager.ts:278-298, 460-478` | Catches future scope-union additions; also catches the silent `"workspace"` fallthrough that already exists today |
| Plan + deepening insights | `docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md` | 8-agent review, 11-12 day total estimate |

**Use these in D1+ — don't recreate them.**

---

## What's next — Phase D1: lift `DaemonSupervisor` singleton → `Map<SessionId, SessionEntry>`

The supervisor at [src/daemon/supervisor.ts](../../src/daemon/supervisor.ts) currently has flat singleton fields (`state`, `wired`, `activeProfile`, `bootEpoch`, `bootInFlight`, `attachedConnections`). Phase D1 lifts these into a per-session `SessionEntry` keyed by `SessionId`.

### Files to touch

| File | What changes |
|---|---|
| `src/daemon/supervisor.ts` | Replace singleton fields with `sessions: Map<SessionId, SessionEntry>`. Every public method (`attach`, `start`, `stop`, `getServices`, `getStatus`) takes `sessionId: SessionId` as first arg. |
| `src/daemon/session.ts` | `SessionEvent` envelope gains `sessionId: SessionId` on every variant. ~14 variants — extract a generic envelope per plan § A (kieran finding #3). |
| `src/daemon/__tests__/supervisor-refcount.test.ts` | Extend — per-session `attachedConnections` sets are isolated (releasing connId from session A doesn't affect B). |
| `src/daemon/__tests__/supervisor-multi.test.ts` (NEW) | Two concurrent `start()` calls with distinct sessionIds + distinct ports both reach `running`; events arrive tagged with sessionId. |
| `src/daemon/__tests__/session-boot.test.ts:287` | DO NOT flip yet — that's D8. Currently asserts `E_SESSION_ALREADY_RUNNING`. D1's supervisor can still emit that code for "same sessionId twice" or rename to `E_SESSION_ALREADY_EXISTS` here. |

### Key implementation decisions (from the deepening review)

Read [plan § A1-A8 + § B + § H](2026-05-12-feat-multi-session-daemon-and-electron-plan.md) before coding. The non-obvious ones:

1. **`bootInFlight` lifetime** (plan § A architecture finding #1) — entry deletion happens **only after** `bootInFlight` settles. `bootEpoch` per-entry, validated against `this.sessions.get(sessionId)?.bootEpoch` at publish time (not the entry's local copy) so a stale boot can't leak into a fresh entry.

2. **`attachedConnections` cleanup mid-boot** (plan § A architecture finding #2) — `release(connId)` iterates ALL sessions and removes the connId from each. If `attachedConnections.size === 0` after boot completes, schedule teardown. Without this, a flaky renderer creates orphan sessions over time.

3. **`findSessionByProfile` race** (plan § A8 / spec-flow finding #1) — read-then-write without synchronization races two simultaneous `events/subscribe { profile }` calls. Add a per-`(worktreeKey, profile.name)` lock or check-and-set returning `E_PROFILE_BOOT_IN_FLIGHT` (already in `SessionErrorCode` union from D0.5) with the in-flight sessionId so the loser joins instead of double-booting.

4. **Same-`(worktree, profile.name)` invariant** (plan § A architecture finding #5) — `findSessionByProfile` is unambiguous only if two active sessions can't share `(worktree, name)`. Add this as an invariant in D1; the existing `E_PORT_CONFLICT` from the plan is necessary but not sufficient (profiles can differ only in `platform`, not just `metroPort`).

5. **`SessionEntry` shape:**
   ```ts
   type SessionEntry = {
     sessionId: SessionId;
     state: SessionState;
     wired: WiredServices | null;
     activeProfile: ValidatedProfile;  // brand from profile-guard
     bootEpoch: number;
     bootInFlight: Promise<void> | null;
     sessionWorktreeKey: WorktreeKey;  // brand from identifiers.ts
     attachedConnections: Set<string>;
     acquiredModules: Array<{ moduleId: string; scopeUnit: string; consumerId: string }>; // NEW per § A architecture #3 — track for crash-cleanup
   };
   ```

6. **NO `E_SESSION_LIMIT_REACHED` daemon cap.** Per § B5, the cap is cut. Daemon trusts the caller; OS-level resources / `E_PORT_CONFLICT` are the limits.

7. **NO `per-session` module scope.** Per § B4, DR-9 is cut. `ModuleScope` union stays `"global" | "per-worktree" | "workspace"`. Existing `per-worktree` modules share subprocesses across sessions on the same worktree (consumer-set semantics already support this).

8. **Use the D0.5 brands + narrowers** at every RPC handler. Example:
   ```ts
   // Before
   const sessionId = payload.sessionId; // unknown
   // After (using D0.5 narrowers)
   const sessionId = requireSessionId(payload, "session/stop");
   ```

### What NOT to touch in D1

- `src/daemon/index.ts` RPC dispatchers — that's D2 (thread sessionId through RPC envelopes).
- `src/core/metro.ts` and `src/core/devtools.ts` — that's D3 (per-session services with composite or sessionId-only keying; simplicity reviewer recommended sessionId-only, see § A2).
- `src/core/builder.ts` — that's D3 (Promise-returning `build()` per § B3).
- Electron `electron/ipc/*` — that's Phase E.
- MCP `src/mcp/*` — that's Phase M.

D1 is the supervisor only. Keep the blast radius small.

---

## Validation gate (per CLAUDE.md three-layer rule)

Before claiming D1 complete:

1. `npx vitest run` — all new specs + existing baseline preserved (today: 1378 passed, 2 skipped).
2. `npx tsc --noEmit` — no NEW errors beyond the 137-error pre-existing baseline in `src/ui/*`. Confirm with `npx tsc --noEmit 2>&1 | grep -v "src/ui/" | grep "error TS" | wc -l` returning the same count as before (or zero if D1 incidentally cleans some up).
3. `npx tsc --noEmit -p electron/tsconfig.json` — must stay clean.
4. `npm run test:smoke` — 13/13 passed at handoff; verify D1 doesn't regress.
5. **D1 specifically does NOT require real-boot.** That's D7 (Real-boot daemon multi-session probe). D1's contract is the supervisor's wire shape and state machine; real-boot proves product behavior at D7.

Pre-flight cleanup (per the existing pattern):
```
pkill -9 -f "src/index.tsx daemon"
lsof -aP -i :8081 -sTCP:LISTEN -t | xargs -r kill -9
lsof -aP -i :8082 -sTCP:LISTEN -t | xargs -r kill -9
```

**Note the `-a` flag** — per `memory/lsof_gotchas.md`, omitting it ORs the selectors on macOS and returns wrong PIDs. Two real bugs have hit this.

---

## Constraints carried forward

- **Single branch (`main`), single worktree (repo root).** Never create `claude/*`, `feat/*`, `fix/*` branches. Never `git worktree add`. Per `memory/single_branch_single_worktree.md`.
- **Local-only on this account.** No push, no PR, no review chain. Per `memory/workflow_local_only_personal_account.md`.
- **No `any` / `unknown`** in production code (one documented escape hatch in `src/app/service-bus.ts`). Brands + narrowers from D0.5 prevent leakage.
- **Conventional Commits.** `feat(daemon): Phase D1 — supervisor multi-session Map`.
- **Imports use `.js` extension** (ESM NodeNext rule). The D0.5 files already do this; mirror.

## Effort estimate

D1 alone: ~1 day focused. The supervisor is ~700 lines; the refactor is mechanical now that the types exist, but the lifecycle invariants (#1, #2, #3 above) take care. Budget ~150 lines of new code + ~50 sites touched in supervisor.ts.

## After D1

D2 (RPC envelopes through `src/daemon/index.ts`) → D3 (per-session services + Promise-Builder) → D4 (cross-session ModuleHost refcount) → D7 (real-boot multi-session probe) → D8 (flip singleton-pin test). Then Phases M1-M6 + E1-E6.5 + T1-T2 + X1-X3 in parallel as the plan allows.

The full sequence and dependency graph lives in [the plan § Implementation Phases](2026-05-12-feat-multi-session-daemon-and-electron-plan.md#implementation-phases) and the consolidated decomposition in [§ I](2026-05-12-feat-multi-session-daemon-and-electron-plan.md#i-phase-decomposition-consolidation).
