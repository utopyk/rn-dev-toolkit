# Multi-session supervisor — dual-API pattern

**Phase:** D1 of the multi-session daemon plan
([docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md](../plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md))
**Commit:** `0dde48e`
**Date:** 2026-05-12

## Problem

The supervisor at `src/daemon/supervisor.ts` held one session per
daemon via flat singleton fields (`state`, `wired`, `activeProfile`,
`bootEpoch`, `bootInFlight`, `sessionWorktreeKey`,
`attachedConnections`). Two sessions on the same worktree (different
profiles, different Metro ports) were not representable.

The plan calls for `Map<SessionId, SessionEntry>` storage and
sessionId-first public methods. But every caller in `src/daemon/index.ts`
still operates in the single-session world — `session/start` takes no
sessionId, `events/subscribe` identifies by profile, `session/stop`
takes no sessionId. The plan defers the RPC dispatcher rewrite to
Phase D2.

So D1 needs to land the storage refactor without touching the
dispatchers. Naive approaches:

- **Rewrite dispatchers anyway** — explodes the D1 blast radius into D2.
  Every change to the public surface forces a coordinated RPC update.
- **Keep singleton fields and add a parallel Map** — two sources of
  truth, the worst of both. Future-D2 has to reconcile.
- **Mint a synthetic sessionId in the dispatcher per call** — pushes
  multi-session logic into the dispatcher prematurely; D2's actual
  sessionId-routing logic would have to undo it.

## Approach — dual API on one Map

The supervisor exposes **two APIs** over the same internal Map:

1. **Primary per-session API** — sessionId-first methods that the
   forthcoming D2 dispatchers will call:
   - `startSession(sessionId, profile)`
   - `attachToSession(sessionId, connId, profile)`
   - `stopSession(sessionId)`
   - `getSessionServices(sessionId)`, `getSessionState(sessionId)`,
     `getSessionEntry(sessionId)`
   - `listSessions()`, `findSessionByProfile(name, worktree)`
   - `releaseConnectionFromAllSessions(connId)`
   - `shutdown()`

2. **Legacy single-session facade** — wraps the per-session API in the
   pre-D1 method signatures so `src/daemon/index.ts` works
   unchanged. Each facade enforces a single-session invariant
   (`E_SESSION_ALREADY_RUNNING` on a second concurrent `start()`),
   maps to "the first / only entry," or walks every entry as
   appropriate:
   - `start(opts)` → mints a sessionId, refuses if any entry exists.
   - `stop()` → tears down the first non-stopped entry.
   - `attach(connId, opts)` → joins the first non-stopped entry (if
     profiles match) or mints + boots a new one.
   - `release(connId)` → routes to
     `releaseConnectionFromAllSessions` so socket-close behaves
     correctly even after multi-session lands.
   - `getServices()`, `getState()`, `getAttachedCount()`,
     `getSessionWorktreeKey()` → return the first-running session's
     view, or the equivalent "nothing running" sentinel.

D2 calls the per-session API directly; the legacy facade is then
deleted.

## Why this works

- **Single source of truth.** The Map is the only state. Facade
  methods are thin wrappers that perform exactly the same
  bookkeeping the pre-D1 supervisor did, plus accept multi-entry
  Maps gracefully.
- **Bounded scope.** D1 touches three files in the daemon (`supervisor.ts`,
  `session.ts`, two test files). The wire protocol, the RPC dispatcher,
  the client-side parser, the Electron renderer, and the MCP server
  are all unchanged.
- **Tests pin both worlds.** The existing single-session integration
  test (`session-boot.test.ts:rejects session/start when a session is
  already running`) keeps passing through the legacy facade. The new
  `supervisor-multi.test.ts` exercises two concurrent sessions through
  the per-session API.

## Lifecycle invariants worth pinning

These came out of the plan's deepening review (§ A architecture
findings) and are easy to lose in a future refactor.

### 1. `bootEpoch` validated against fresh map lookup, not local capture

`bootAsync` captures `myEpoch` from `entry.bootEpoch` at entry, then
re-reads `this.sessions.get(entry.sessionId)?.bootEpoch` at publish
time. If the entry was deleted and re-created with the same
sessionId between entry and publish, the lookup either returns
`undefined` (deleted) or a fresh `bootEpoch` (re-created), both of
which fail the equality check and trigger dispose.

Without the fresh lookup, a `stopSession → startSession(sameSid)`
pair could let a stale boot's `services` overwrite the new entry's
`wired` slot. Symptom: the new session looks running but its services
fire events tagged with the wrong sessionId (the stale one). Hard
to spot in tests because the sessionIds match.

### 2. `releaseConnectionFromAllSessions` walks every entry

`release(connId)` historically operated on a single session's
attached set. With multiple entries it must walk all of them — a
client whose socket closes mid-boot may have entries in 0..N
sessions' sets depending on the race. Each empty-set transition
schedules a separate teardown so an orphan session can't survive a
flaky-reconnect cycle.

### 3. Port-collision detection at `startSession`, not at Metro spawn

Two sessions on the same daemon can't share a Metro port. Plan
§ DR-6 chose to reject explicitly at start time with `E_PORT_CONFLICT`
rather than letting Metro fail later with a less-actionable
spawn error. The check is a simple linear scan of `this.sessions`;
the simplicity is intentional given the small N (≤ ~10 in practice).

### 4. `acquiredModules: []` pre-allocated on every entry

D4 (ModuleHost cross-session refcount) needs a place to track which
`per-worktree` modules a session has acquired so `stopEntry` can
release them on crash-cleanup paths. Allocated empty in D1 so D4 can
populate without touching `supervisor.ts`.

## What the facade hides — risks for D2

The legacy facade enforces "one session at a time" on its own surface:
`start()` returns `E_SESSION_ALREADY_RUNNING` whenever any entry is
non-stopped. **The per-session API does not enforce this** — that's
the entire point. D2 must:

- Rewrite each `index.ts` dispatcher to take the per-session API.
- Replace the legacy facade callers with the per-session equivalents
  before deleting the facade.
- Verify the existing `session-boot.test.ts:rejects session/start when
  a session is already running` test gets repurposed (per D8: flipped
  to "two distinct sessionIds → both succeed").

The match predicate `profileMatches(active, incoming)` in
`supervisor.ts` is the load-bearing equality check — `(name,
worktree)` pair, with `worktree ?? ""` normalisation. `findSessionByProfile`
uses the same predicate. D2's lock at `events/subscribe { profile }`
must hash on the same pair to avoid a race where two subscribers boot
two sessions for what the supervisor would treat as one profile.

## References

- Plan: [docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md](../plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md)
  — § A architecture findings #1, #2, #3, #5 + § B5 (no E_SESSION_LIMIT_REACHED)
  + § DR-6 (port conflict) + § H lifecycle edge cases.
- Foundation: D0.5 commit `7c9f7a2` — branded `SessionId` / `WorktreeKey`,
  `SessionErrorCode` union, RPC payload narrowers.
- Tests: `src/daemon/__tests__/supervisor-multi.test.ts` +
  `src/daemon/__tests__/supervisor-refcount.test.ts` (per-session-isolation case).
