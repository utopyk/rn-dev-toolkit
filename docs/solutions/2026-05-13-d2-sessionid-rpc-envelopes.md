# Phase D2 — sessionId threaded through every RPC envelope

**Phase:** D2 of the multi-session daemon plan
([docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md](../plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md))
**Commit:** `63a0dd2`
**Date:** 2026-05-13
**Predecessor:** D1 (`0dde48e`) — supervisor `Map<SessionId, SessionEntry>` + dual API.

## Problem

D1 grew the supervisor to multi-session storage but kept the legacy
single-session facade so `src/daemon/index.ts` dispatchers could
remain unchanged. The wire protocol was still single-session:

- `session/start { profile }` minted no sessionId and rejected the
  second concurrent boot.
- `session/stop` / `session/status` took no sessionId.
- `events/subscribe` identified a session by `profile`, with two
  bonus "observer-mode" cells (no profile, or session-status snapshot
  only) that bypassed refcount entirely.
- `SessionEvent` carried `worktreeKey` but the client-side parser
  silently dropped the new `sessionId` field even though D1's
  envelope shape included it.
- Every client RPC handler (`metro/reload`, `devtools/*`,
  `builder/build`, etc.) resolved services via
  `supervisor.getServices()` — the legacy first-running-session
  fallback that doesn't survive multi-session.

D2's job: light up the wire protocol. Thread sessionId through every
dispatcher, delete the legacy facade, expose `sessions/list`, surface
the minted sessionId on the client-side `DaemonSession`, and adopt the
D0.5 narrowers (`optionalSessionId`, `parseEventsSubscribeInput`) at
every callsite.

## Approach — five coordinated layers

D2 isn't a single refactor; it's five coordinated changes that have to
land together for the wire protocol to stay internally consistent.

### Layer 1 — Supervisor: delete the facade, tighten the brand

`SessionEntry.activeProfile` becomes `ValidatedProfile` (was `Profile`).
`startSession` + `attachToSession` take `ValidatedProfile`. The legacy
methods `start`, `stop`, `attach`, `release`, `getServices`,
`getState`, `getAttachedCount`, `getSessionWorktreeKey` are gone
along with their private helpers (`hasAnyActiveSession`,
`firstNonStoppedEntry`, `legacyAggregateStatus`).

The supervisor now only speaks SessionId. Back-compat
single-session shortcuts ("stop the only active session") live one
layer up at the dispatcher.

### Layer 2 — Dispatcher: per-session API + back-compat fallbacks

`src/daemon/index.ts` rewires each RPC handler to:

1. Read `sessionId` from payload via `optionalSessionId` (the
   D0.5 narrower).
2. If present → call the per-session supervisor API.
3. If absent → fall back to "the only active session" via
   `supervisor.listSessions()`:
   - 0 active → `{ status: "stopped" }` ok (session/stop) or
     `E_SESSION_NOT_RUNNING` (client RPCs).
   - 1 active → use that session.
   - 2+ active → `E_SESSION_AMBIGUOUS` with `availableSessions`
     payload (`SessionAmbiguousData` from `error-codes.ts`).

`session/start` keeps the single-session-invariant guard
(`E_SESSION_ALREADY_RUNNING` on any active session) for back-compat
with `session-boot.test.ts:287` — D8 flips that test once adapters
thread sessionId through every send.

`events/subscribe` adopts `parseEventsSubscribeInput` (D0.5
discriminated union) and routes to `boot-or-join` or `attach-by-id`
branches. Observer mode is cut — `{neither}` rejects with
`E_SUBSCRIBE_INVALID_ARGS`. The matrix shrinks from 4 cells to 2.

`sessions/list { }` is the new RPC: synchronous snapshot of
`(sessionId, profileName, worktreeKey, status, services)` per entry.
Closes the spec-flow gap from D0.5 deepening (renderer rehydration,
MCP cold-start, `E_UNKNOWN_SESSION` recovery).

The shutdown handler now calls `supervisor.shutdown()` (was
`supervisor.stop()` — the facade method). `shutdown` walks every
session.

### Layer 3 — Boot-in-flight lock (plan § A8)

`events/subscribe { profile }` is read-then-write — `findSessionByProfile`
is a pure read, then `startSession` mints a new entry. Two concurrent
subscribers for the same `(worktree, profileName)` pair can both miss
the existing match and both race a fresh boot.

The lock lives at the dispatcher layer, NOT in the supervisor:

```ts
const bootLocks = new Map<string, Promise<BootLockResult>>();
```

Keyed by `${profile.worktree ?? ""}:${profile.name}` (same normalisation
as `profileMatches`). Race-free in single-threaded JS because the
check-and-set sequence between `findSessionByProfile` /
`bootLocks.get` / `bootLocks.set` / `startSession` contains zero
awaits. Self-cleanup via `lockPromise.finally(() => bootLocks.delete(key))`
so the next boot for the same key can proceed.

Three boot-or-join branches in the dispatcher:

1. **Existing match** — `findSessionByProfile` returns an entry →
   `attachToSession`, done.
2. **Lock held** — `bootLocks.get` returns a pending promise →
   `await` it, then `attachToSession` with the resolved sessionId.
3. **Neither** — mint a fresh sessionId, store the lock promise,
   `startSession`, then `attachToSession`.

### Layer 4 — Client RPCs: optional sessionId with single-session fallback

`src/daemon/client-rpcs.ts` `handleClientRpc` was using the deleted
`supervisor.getServices()` facade. The replacement `resolveSessionServices`:

1. `optionalSessionId(payload)` — D0.5 narrower.
2. If present → `getSessionEntry(sid)` →
   `E_UNKNOWN_SESSION` if missing, `E_SESSION_NOT_RUNNING` if
   entry exists but not yet wired (still starting).
3. If absent → single-active-session fallback (same shape as
   session/stop's fallback).

The brief's "Every action under CLIENT_RPC_ACTIONS reads
`requireSessionId`" was relaxed to `optionalSessionId` for D2: strict
`requireSessionId` would break every test fixture that sends
`daemon.client.send({ action: "metro/reload" })` over a raw socket
without threading sessionId. D8 can flip the optional → required once
adapters thread sessionId through every send and the test fixtures
migrate.

### Layer 5 — Client: parse + expose sessionId

`src/app/client/session.ts`:

- `parseSubscribeResponse` now extracts the new `sessionId` field
  from the ack.
- `parseSessionEventEnvelope` requires `sessionId` on every event
  envelope (refuses malformed payloads).
- `DaemonSession.sessionId` exposed as branded `SessionId` (via
  `asSessionId`).
- The session helper's `.stop()` threads `{ sessionId }` in the
  `session/stop` payload — strict-correct form for multi-session
  daemons; single-session daemons still accept the legacy `{}` shape.

## Lifecycle invariants worth pinning

### 1. Listener registration ordering

`supervisor.onEvent(push)` MUST run BEFORE any await in
`handleEventsSubscribe`. `startSession`'s synchronous body emits the
`session/status: starting` event during `transition()`; if the
listener weren't registered yet, the subscriber would miss the boot's
first state edge.

The implementation registers `detach = supervisor.onEvent(push)`
right after `parseEventsSubscribeInput` and BEFORE any await. The
`event.onClose` handler captures `subscribeConnId` in a local so the
close handler routes to `releaseConnectionFromAllSessions` correctly
even if `event.connectionId` changes (it doesn't, but the local pins
the contract).

### 2. Back-compat fallback shape: 0 vs 1 vs 2+ active

The dispatcher's `session/stop` / `session/status` /
`handleClientRpc` resolution function follows the same 3-arm pattern:

| Active count | session/stop | session/status | client RPCs |
|---|---|---|---|
| 0 | `{ status: "stopped" }` ok | `{ status: "stopped", worktreeKey: <daemon>, attached: 0 }` | `E_SESSION_NOT_RUNNING` |
| 1 | stop that session | return its state | dispatch through its services |
| 2+ | `E_SESSION_AMBIGUOUS` + candidates | `E_SESSION_AMBIGUOUS` + candidates | `E_SESSION_AMBIGUOUS` + candidates |

The 0-active arm differs: `session/stop` returns OK (no-op stop),
`session/status` returns the legacy `status: "stopped"` shape (so
existing clients keep working), client RPCs return
`E_SESSION_NOT_RUNNING` (the only honest answer — there's no service
to dispatch through).

### 3. Boot-lock self-cleanup vs sibling-await ordering

`bootLocks.delete(key)` runs in `lockPromise.finally`. By the time
`finally` fires, any sibling subscriber awaiting the same promise has
either already settled (success or failure) or will settle on the same
microtask drain. Deleting the entry from the map doesn't invalidate
the promise — siblings hold their own ref via `bootLocks.get(key)`
returning the same reference.

The `if (bootLocks.get(lockKey) === lockPromise)` guard before delete
protects against the rare case where a subsequent boot for the same
key happens after our settle but before our `finally` fires (e.g.
when the first boot fails synchronously and the dispatcher immediately
retries). The check ensures we don't clobber a fresh lock.

### 4. `E_PORT_CONFLICT` fires before `E_PROFILE_MISMATCH` in boot-or-join

Two distinct profiles (different names) sharing the same Metro port
both compute distinct `lockKey`s and both miss `findSessionByProfile`,
so both proceed to `startSession`. The supervisor's port-collision
check (introduced in D1) fires before any profile-match check on the
new entry. So the wire-protocol error a client sees in this case is
`E_PORT_CONFLICT`, not `E_PROFILE_MISMATCH`. The
`session-release.test.ts:attach-with-different-profile` test was
renamed + re-asserted to reflect this. The pre-D2 single-session
facade returned `E_PROFILE_MISMATCH`; the per-session rule is "you
can't share a port, but you can run different profiles."

## What broke and how it was fixed

Six existing test files relied on the now-cut observer-mode subscribe:

- `src/daemon/__tests__/session-boot.test.ts` — restructured to
  subscribe-with-profile (boot-via-subscribe), dropped the separate
  `session/start`.
- `src/daemon/__tests__/bidirectional-enforcement.test.ts` — added
  profile to every subscribe payload (the bidirectional-gate tests
  don't depend on observer mode; they just needed a subscribe socket
  to exist).
- `src/daemon/__tests__/client-rpcs.test.ts` — `bootRunningSession`
  helper subscribes-with-profile.
- `src/daemon/__tests__/builder-build-hooks-integration.test.ts` —
  uses `connectToDaemonSession` to boot, then a raw subscribe with
  the same profile joins via boot-or-join.
- `src/app/__tests__/tui-client.test.ts` — restructured so sub2
  attaches BEFORE sub1 disconnects (keeping refcount > 0 across the
  churn). The pre-D2 test exploited observer-mode's "no refcount"
  loophole.
- `src/app/client/__tests__/session-multiplex.test.ts` +
  `session-watchdog.test.ts` — fake daemons updated to include
  `sessionId` in subscribe acks and event envelopes (the client
  parser now requires it).

`supervisor-refcount.test.ts` was rewritten to use an `attachShim`
helper that replays the dispatcher's boot-or-join dance at the unit
level. The shim is test-fixture code by design — it deliberately
compresses what the dispatcher's `handleEventsSubscribe` does
(without the wire + subscribe-registry + bootLock layers) so the
refcount invariants stay pinned without booting an integration
daemon. The shim returns status from `startSession`'s ack rather
than reading `entry.state.status` (which may have already
transitioned to "running" on the same microtask drain).

## Test surface

12 new specs, 3 files:

- `subscribe-semantics.test.ts` (7 tests) — boot-or-join,
  attach-by-id, both-fields rejected, neither-fields rejected,
  joiner-gets-same-sessionId, attach-by-id with unknown sid
  rejected.
- `sessions-list.test.ts` (3 tests) — empty array, single entry,
  multiple entries.
- `session-events-envelope.test.ts` (2 tests) — single-session
  events all carry matching sessionId; concurrent-session events
  carry one of the two sessionIds.

## What this unblocks

- **D3** — per-session services in `MetroManager` / `DevToolsManager`
  / `Builder`. Composite/sessionId-only Map keying. Promise-returning
  `Builder.build()`. The per-session services lookup
  (`supervisor.getSessionServices(sid)`) is now the canonical path;
  D3 can replace `services.worktreeKey`-keyed Maps with `sessionId`
  ones without touching the daemon dispatchers.
- **D4** — `acquiredModules: []` is already pre-allocated on every
  entry; D4 fills it in.
- **D7** — real-boot multi-session probe. The wire protocol is in
  place; real Metro just needs to come up under two profiles on
  different ports.
- **Phase E** — Electron renderer can now show N tabs each routing
  on its own sessionId. The renderer's `DaemonSession.sessionId`
  field is the routing key.
- **Phase M** — MCP server can enumerate sessions via `sessions/list`
  before dispatching agent tools to a specific session.

## What's NOT done in D2

Per the brief: "Don't touch metro.ts, devtools.ts, builder.ts,
electron/ipc/*, src/mcp/*, or module-host". Those phases (D3, D4, E,
M) have their own scopes. The adapters in `src/app/client/` still
don't thread sessionId into their RPC payloads — the daemon's
`resolveSessionServices` uses the single-session fallback in that
case. D8 flips that fallback once adapters migrate.

`session-boot.test.ts:287` still asserts `E_SESSION_ALREADY_RUNNING`
on a second `session/start` against an active session. D8 flips
that test.

## References

- Plan: [docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md](../plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md)
  — § A8 (race lock), § B2 (subscribe matrix + sessions/list),
  § DR-6 (port conflict).
- D1 pattern: [docs/solutions/2026-05-12-multi-session-supervisor-pattern.md](2026-05-12-multi-session-supervisor-pattern.md).
- D0.5 narrowers: `src/daemon/rpc-args.ts`.
- D0.5 error-code union: `src/daemon/error-codes.ts`.
- Tests:
  - `src/daemon/__tests__/subscribe-semantics.test.ts`
  - `src/daemon/__tests__/sessions-list.test.ts`
  - `src/daemon/__tests__/session-events-envelope.test.ts`
