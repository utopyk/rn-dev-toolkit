---
title: Multi-session daemon + multi-profile Electron
type: feat
status: active
date: 2026-05-12
deepened: 2026-05-12
---

# Multi-session daemon + multi-profile Electron

## Enhancement summary

**Deepened on:** 2026-05-12. Eight parallel review agents (spec-flow, architecture, performance, simplicity, kieran-typescript, julik-frontend-races, pattern-recognition, agent-native) graded the plan against the rn-dev-cli codebase. The full findings table with file:line grounding lives at the **[Deepening insights](#deepening-insights-2026-05-12-review-pass)** section near the end of this document. Headlines below.

### Key shifts to the decision register (full rationale in Deepening insights § B)
- **DR-9 — cut for v1.** No existing module declares `scope: "per-worktree"` (all three shipped modules are `"global"`); inventing `"per-session"` for a hypothetical consumer violates YAGNI. Defer until a real module asks. Frees ~half of D4 plus an SDK union change.
- **DR-4 row 4 (observer-mode subscribe) — replace with explicit `sessions/list` RPC.** The same need (renderer rehydration on daemon respawn, MCP cold-start discovery, error recovery) is better served by a list endpoint than by a speculative observer-mode. Cleaner type surface.
- **DR-8 (per-session Builder) — augment, not replace.** Make `Builder.build()` Promise-returning with a per-build correlation id; keep Builder lifecycle per-session for clean disposal on `stop(sessionId)`. The plan's reasoning was right but the fix was incomplete — per-session ownership alone doesn't fix intra-session iOS+Android `.once("done")` cross-talk that already exists today.
- **`E_SESSION_LIMIT_REACHED` daemon cap — cut.** Renderer can soft-disable the "+" button past a UX threshold without daemon-side enforcement; otherwise the cap is arbitrary and forecloses on power users.

### Newly required pre-D1 foundation work (Phase D0.5)
Before per-session refactoring lands, six TypeScript-foundation items must ship to avoid silent fall-through bugs. Full details in Deepening insights § A.
1. Branded `SessionId` and `WorktreeKey` (mirror existing `ValidatedProfile` pattern at [src/daemon/profile-guard.ts:28-30](../../src/daemon/profile-guard.ts)).
2. Composite-key helper class (kill stringly-typed `${worktreeKey}:${sessionId}` concat at call sites).
3. RPC payload narrowers in the [packages/module-sdk/src/args.ts](../../packages/module-sdk/src/args.ts) idiom (no Zod in repo).
4. `events/subscribe` discriminated union input (makes `{ profile && sessionId }` cell unrepresentable at compile time).
5. Central `SessionErrorCode` union (no `ErrorCode` union exists today; string-literal renames at the RPC boundary are silent without one).
6. Convert `ModuleScope` if/else at [src/core/module-host/manager.ts:279, 454](../../src/core/module-host/manager.ts) to exhaustive switch (so any future scope addition is a compile error rather than silent fall-through).

### Phase M expanded from 3 sub-phases → 6
Phase M as originally written was "two-bullets-thin" — it would have shipped Electron with multi-session and left MCP unable to start a second session. Per agent-native parity: `rn-dev/start-session` today has no `profileName` arg, falls back to `ctx.profile`. New phase breakdown lives in Deepening insights § C2.

### Critical Phase E races identified
Two pre-existing module-scope state issues in `electron/ipc/` will silently break under multi-session:
- **`disconnectLoggedFor`** at [electron/ipc/services.ts:227](../../electron/ipc/services.ts) — module-scope mutable state that two concurrent attaches clobber.
- **`instances:create`** at [electron/ipc/instance.ts:103-153](../../electron/ipc/instance.ts) — not serialized; concurrent calls leak fully-wired DaemonSession ghosts.

Both must be addressed in E1/E2 (Deepening insights § A7-A8) — the plan's "lift state.daemonSession to Map" is necessary but not sufficient.

### Notable performance/UX additions
- Filter events in main process (not renderer) — saves ~75% IPC bandwidth at 4 sessions × 620 ev/s aggregate.
- Per-tab `SessionContext` is required, not a nicety — naive single-context renderer reconciles ~600×/sec across all tabs under burst.
- Per-session marginal RSS is ~400-550 MB (Metro subprocess dominates); 4 sessions on 16 GB laptops is right at the edge. Add per-session RSS budget assertion to X1 soak.

### What did NOT change
The architectural skeleton holds: `Map<sessionId, SessionEntry>`, per-session Builder ownership, ServiceBus stays a single global bus with sessionId in payload, in-process for all sessions in v1, server-generated UUID sessionId, explicit-required sessionId at RPC boundaries. The decision register DRs 1, 2, 3, 5, 6, 7, 10 all stand as-written.

## Overview

Today's architecture pins **one active profile session per daemon**. Two profiles for the same worktree (iPhone + Android side-by-side, quick-mode-on-sim vs clean-mode-on-iPhone, etc.) cannot run in parallel: the supervisor rejects the second `attach()` with `E_PROFILE_MISMATCH` ([src/daemon/supervisor.ts:230-235](../../src/daemon/supervisor.ts)) and a second `session/start` with `E_SESSION_ALREADY_RUNNING` ([src/daemon/supervisor.ts:292-298](../../src/daemon/supervisor.ts)). The Electron renderer compounds the limit with its own singleton state ([electron/ipc/state.ts:52](../../electron/ipc/state.ts)). This plan lifts both ceilings.

The work has been referenced twice in prior docs without a real phase:
- [Phase 13.2 handoff:146-149](../../docs/plans/2026-04-24-module-system-phase-13-2-services-in-daemon-handoff.md) — "Multi-session daemon" listed under known gaps with a one-line shape sketch (`Map<sessionId, SessionState>` + thread `sessionId` through RPC envelopes). **Footnote, not a plan.**
- [2026-05-07 next-session prompt:29-30](../../docs/plans/2026-05-07-next-session-prompt.md) — "Multi-profile per Electron — Phase 13.6+. `state.daemonSession` is a singleton... real fix is multi-day refactor across `state.ts`, `services.ts`, `instance.ts`, `main.ts`, and several IPC handlers."

This plan pulls the daemon-side piece out of the footnote and sequences it against the Electron piece. **The daemon-side change must land first**: doing the Electron-side change alone delivers nothing visible (the daemon still rejects the second profile).

## Problem Statement

### What works today

- **Cross-worktree concurrency** — one daemon per worktree, daemons are isolated. Two repos in two windows already work.
- **Intra-session platform fan-out** — a single profile with `platform: "both"` already fires iOS+Android builds in parallel via `triggerBuildsIfNeeded` at [src/app/auto-build.ts:29-56](../../src/app/auto-build.ts). This is **intra-session** parallelism and must remain unchanged.

### What doesn't work — the three-bottleneck stack

| # | Bottleneck | Location | In any plan? |
|---|---|---|---|
| 1 | Per-worktree single daemon | [src/daemon/supervisor.ts:14-15](../../src/daemon/supervisor.ts) (comment) | Working as designed |
| 2 | **Daemon enforces 1 active session** | [src/daemon/supervisor.ts:108-137, 230-298](../../src/daemon/supervisor.ts) | **Footnote only** |
| 3 | Electron renderer `state.daemonSession` singleton | [electron/ipc/state.ts:52](../../electron/ipc/state.ts), [electron/ipc/instance.ts:174-191](../../electron/ipc/instance.ts) | Tracked as "Phase 13.6+" |

The user-facing intuition ("two devices in parallel from the same repo") needs **both** #2 and #3 fixed. Fixing only #3 surfaces nicer error messages but unblocks nothing concrete.

### Why now

- The hook system (H1+H2) and MCP parity (M1+M2) phases are landed. The daemon now carries the full agent-native contract; the singleton-session ceiling is the next architectural barrier blocking real concurrency.
- The plan is user-visible: a real customer story is "show me my app on iPhone and Android side-by-side without two terminals open." The current UX surfaces an error modal in that flow ([commit 540e91a](https://github.com/anthropics/apps), per memory).
- Test infra (real-e2e Playwright + fake-boot harness) is already mature enough to verify the multi-session shape without inventing new test layers.

## Proposed Solution

### Architectural shift

```
Today
  worktree → daemon → 1 session → services { metro, devtools, builder, moduleHost, … }

Target
  worktree → daemon → N sessions
                       ├─ session A (profile X) → services { metro_A, devtools_A, builder_A, … }
                       └─ session B (profile Y) → services { metro_B, devtools_B, builder_B, … }
```

### Key design decisions (decision register)

| ID | Decision | Rationale | Rejected alternative |
|---|---|---|---|
| **DR-1** | `sessionId` is a **server-generated UUID** returned by `session/start` and `events/subscribe`. | Clients don't pick names; collisions impossible; daemon owns identity. | Client-supplied (e.g. profile name + worktree hash) — collides, makes restart-replay harder. |
| **DR-2** | `sessionId` is **explicit and required** in every RPC payload from day one. No "default session if only one exists" fallback. | Two code paths = the dreaded "but there are 0 sessions" bugs at the boundary. All clients live in this repo; a clean break is cheaper than a compatibility shim that lives forever. | Implicit-default fallback. |
| **DR-3** | Daemon stays **in-process** for all sessions (no subprocess-per-session isolation in v1). | Subprocess isolation is a 2-3× larger refactor; ModuleHost already provides isolation for the risky-third-party-code surface. Misbehaving Metro in one session is the same blast radius as today (a single daemon dying). | Subprocess-per-session (deferred to a future plan if real-world isolation pain shows up). |
| **DR-4** | `events/subscribe` is **all-sessions-by-default with `sessionId?` filter**. Clients receive every session's events and filter locally if they want one. | Renderer + MCP want all-sessions anyway (multi-tab UI, multi-tool routing). Session-scoped subscriptions = more RPC traffic on session-switch. | Session-scoped subscriptions. |
| **DR-5** | `SessionEvent` envelope keeps `worktreeKey` AND gains `sessionId`. Both. | DevTools/Metro state machines key by worktreeKey today and that lookup stays correct. `sessionId` is the *new* dimension. | Drop `worktreeKey` (breaks existing per-worktree code paths in MetroManager/DevToolsManager). |
| **DR-6** | Two sessions for the **same worktree** are allowed. Service-internal keying lifts from `worktreeKey` → composite `(worktreeKey, sessionId)` where collisions matter (Metro instances, DevTools attach). | This is the actual user story. Without it, "two profiles per project" is just "use two repos," which is not what's asked. | Reject same-worktree multi-session (kills the entire user-visible value). |
| **DR-7** | `ServiceBus` stays a **single global bus**; topics carry `sessionId`. Subscribers filter. | Cheaper refactor than `Map<sessionId, ServiceBus>`. Bus is already a thin pub/sub; sessionId is a payload field, not a topology change. | Per-session bus instances. |
| **DR-8** | Builder becomes **per-session instance**, not a global singleton with concurrent `.once("done")` listeners. | Today's [src/daemon/client-rpcs.ts:201](../../src/daemon/client-rpcs.ts) `.once("done")` pattern is already fragile under intra-session iOS+Android fan-out (whichever Build fires first fires the post-hook). Two sessions hitting one Builder multiplies that fragility. Per-session Builder eliminates the cross-talk. | Shared global Builder (bug-prone). |
| **DR-9** | Module-host scope union gets a new value: `per-session`. Existing `per-worktree` and `global` keep current semantics (shared across sessions on same worktree / shared across all). | Some modules legitimately want per-session isolation (e.g. devtools-network capture per profile). Adding `per-session` is additive; no module breaks. | Force all modules to one scope. |
| **DR-10** | **Test parity gate is mandatory** across all three clients (TUI/Electron/MCP) before the multi-session ceiling is lifted *in production behavior*. The supervisor's `Map<sessionId>` can land in earlier phases gated behind a feature flag if needed, but `instances:create`-second-profile only stops returning `PROFILE_MISMATCH` once all three clients have shipped their multi-session handlers. | Per memory [feedback_test_parity_no_gaps.md]: never structure work as "accept the gap." Build all three. | Land daemon-side multi-session, ship Electron, defer MCP/TUI. |

### Wire-protocol changes

**`SessionEvent` envelope** ([src/daemon/session.ts:52-66](../../src/daemon/session.ts)):

```ts
// Before
type SessionStatusEvent = {
  kind: "session/status";
  worktreeKey: string;
  data: { status: SessionStatus };
};

// After
type SessionStatusEvent = {
  kind: "session/status";
  sessionId: string;     // NEW — required
  worktreeKey: string;   // unchanged
  data: { status: SessionStatus };
};
```

Same shape change applies to every `*Event` in `session.ts`.

**RPC payloads** (every call that reads/writes session state):

```ts
// Before
session/start { profile }                → { status: "starting" }
session/stop  { }                        → { status: "stopping" | "stopped" }
session/status { }                       → { status, services }
events/subscribe { profile }             → { subscribed: true } + stream
metro/reload { }                         → { ok }
builder/build { opts }                   → { ok }

// After
session/start { profile }                → { status: "starting", sessionId }   // NEW: returns id
session/stop  { sessionId }              → { status: "stopping" | "stopped" }
session/status { sessionId }             → { status, services }
events/subscribe { profile?, sessionId? } → { subscribed: true, sessionId? } + stream
                                            // profile = "start new session, return its id"
                                            // sessionId = "attach to existing session"
                                            // both = error
                                            // neither = "subscribe to ALL sessions" (no boot)
metro/reload { sessionId }               → { ok }
builder/build { sessionId, opts }        → { ok }
```

**`events/subscribe` semantics matrix** (the canonical attacher path, per [src/daemon/index.ts:540-541](../../src/daemon/index.ts)):

| `profile` | `sessionId` | Behavior |
|---|---|---|
| provided | absent | Boot or join based on profile match across all sessions; returns sessionId. |
| absent | provided | Join existing session by id. Errors if id unknown. |
| both | | Error: `E_INVALID_SUBSCRIBE_ARGS`. |
| neither | | Subscribe to *all* sessions (read-only observer; no boot). Useful for diagnostic clients. |

## Technical Approach

### Architecture

#### Per-session SessionEntry shape

Replace the supervisor's flat fields ([src/daemon/supervisor.ts:108-137](../../src/daemon/supervisor.ts)):

```ts
// Before
class DaemonSupervisor extends EventEmitter {
  private state: SessionState = INITIAL_SESSION_STATE;
  private wired: WiredServices | null = null;
  private activeProfile: Profile | null = null;
  private bootEpoch = 0;
  private bootInFlight: Promise<void> | null = null;
  private sessionWorktreeKey: string;
  private attachedConnections = new Set<string>();
}

// After
type SessionEntry = {
  sessionId: string;
  state: SessionState;
  wired: WiredServices | null;
  activeProfile: Profile;
  bootEpoch: number;
  bootInFlight: Promise<void> | null;
  sessionWorktreeKey: string;
  attachedConnections: Set<string>;
};

class DaemonSupervisor extends EventEmitter {
  private sessions = new Map<string, SessionEntry>();   // keyed by sessionId
}
```

All public methods take `sessionId` as the first arg: `attach(sessionId, connId, profile)`, `start(sessionId, profile)`, `stop(sessionId)`, `getServices(sessionId)`, `getStatus(sessionId)`.

#### Service ownership lifts from per-worktree → per-session

The good news: **`MetroManager.instances`, `DevToolsManager.instances`, `ModuleHostManager.entries` are already Map-keyed.** What collapses them to single-entry today is the supervisor's single-WiredServices wrapper.

| Manager | Today's key | After |
|---|---|---|
| `MetroManager.instances` ([src/core/metro.ts:62](../../src/core/metro.ts)) | `worktreeKey: string` | composite `${worktreeKey}:${sessionId}` (same-worktree-different-session must not collide) |
| `DevToolsManager.instances` ([src/core/devtools.ts:112](../../src/core/devtools.ts)) | `worktreeKey: string` | composite `${worktreeKey}:${sessionId}` |
| `ModuleHostManager.entries` ([src/core/module-host/manager.ts:195](../../src/core/module-host/manager.ts)) | `${moduleId}:${scopeUnit}` | unchanged for `global` + `per-worktree`; new `per-session` scope uses sessionId as scopeUnit |
| `Builder` ([src/core/builder.ts](../../src/core/builder.ts)) | n/a (single instance per services struct) | one Builder instance per SessionEntry.wired |
| `ServiceBus` ([src/app/service-bus.ts:111](../../src/app/service-bus.ts)) | global singleton | unchanged topology; all topics gain `sessionId` payload field |

#### Port allocation — Metro multi-instance same worktree

Two sessions on the same worktree need two distinct Metro ports. Today's profile defaults to `metroPort: 8081`, with the wizard offering an override.

**Implementation rule:** When `session/start` is called for a profile whose `metroPort` is already bound by another active session of the same daemon, the daemon **rejects with `E_PORT_CONFLICT`** rather than silently shifting the port. Users explicitly pick non-overlapping ports in the wizard. Forwards-compat: a v2 future plan can add auto-port-allocation, but v1 errors loudly so the failure mode is visible.

**lsof gotcha** (per memory [lsof_gotchas.md]): port-bound checks MUST use `lsof -a -nP -iTCP:PORT -sTCP:LISTEN -t`. The `-a` flag is load-bearing on macOS — missing it ORs the selectors and returns wrong PIDs. Audit `MetroManager.findProcessOnPort()` before shipping; this has already burned us twice.

#### auto-build.ts — preserve intra-session fan-out

Confirmed at [src/app/auto-build.ts:22-57](../../src/app/auto-build.ts): `triggerBuildsIfNeeded(session, profile, projectRoot)` already takes a single `session` and fans out platforms via `void session.builder.build({ ...opts, platform: plat })` in a single `setTimeout(200)` tick.

**No changes needed here.** Multi-session adds the *inter-session* dimension; the intra-session iOS+Android fan-out is orthogonal. Two sessions each calling `triggerBuildsIfNeeded(sessionA, …)` and `triggerBuildsIfNeeded(sessionB, …)` produce four concurrent builds total (two sessions × two platforms), each with its own Builder instance (per DR-8).

#### Backward-compat — none

Per DR-2, this is a clean break. Every in-repo caller is updated in the same plan. The single exception is **`events/subscribe { }` with neither profile nor sessionId** — that gains the new "subscribe to all sessions, observer-mode" semantic (it was an error before, so this is additive not breaking).

### Implementation Phases

The plan is sequenced honestly. Phase D unblocks everything else; Phases M and E can land in parallel after D6.

```
            ┌─────────────────────────────────────┐
            │ Phase D — Daemon-side multi-session │
            │ (D0 → D1 → D2 → D3 → D4 → D5 → D6) │
            └────────────────┬────────────────────┘
                             │
                  ┌──────────┴──────────┐
                  ▼                     ▼
         ┌────────────────┐    ┌────────────────┐
         │ Phase M (MCP)  │    │ Phase E (Electron)│
         │ (M1, M2, M3)   │    │ (E1 → E6)       │
         └────────┬───────┘    └────────┬────────┘
                  │                     │
                  └──────────┬──────────┘
                             ▼
                  ┌────────────────────┐
                  │ Phase T (TUI)      │
                  │ (T1, T2)           │
                  └─────────┬──────────┘
                            ▼
                  ┌────────────────────┐
                  │ Phase X — verify   │
                  │ (X1, X2, X3)       │
                  └────────────────────┘
```

---

#### Phase D — Daemon-side multi-session (must land first)

##### D0: Design RFC (no code)

- [ ] Sub-section in this plan above is the RFC. No separate file.
- [ ] Decision register frozen before D1 starts. If a decision flips mid-implementation, **update this plan first, then implement**.

##### D1: Lift supervisor singleton → Map<sessionId, SessionEntry>

**Files:**
- `src/daemon/supervisor.ts` — class rewrite. Keep all method names; thread `sessionId` through them.
- `src/daemon/session.ts` — `SessionEvent` envelope adds `sessionId: string` to every variant.

**Pseudo-code (`src/daemon/supervisor.ts`):**

```ts
class DaemonSupervisor extends EventEmitter {
  private sessions = new Map<string, SessionEntry>();

  start(sessionId: string, profile: Profile): StartSessionResult {
    if (this.sessions.has(sessionId)) {
      return { kind: "error", code: "E_SESSION_ALREADY_EXISTS", message: "..." };
    }
    const entry: SessionEntry = {
      sessionId,
      state: INITIAL_SESSION_STATE,
      wired: null,
      activeProfile: profile,
      bootEpoch: 0,
      bootInFlight: null,
      sessionWorktreeKey: this.artifactStore.worktreeHash(profile.worktree),
      attachedConnections: new Set(),
    };
    // Port collision check
    if (this.portInUseAcrossSessions(profile.metroPort)) {
      return { kind: "error", code: "E_PORT_CONFLICT", message: "..." };
    }
    this.sessions.set(sessionId, entry);
    this.bootAsync(entry);
    return { kind: "ok", status: "starting" };
  }

  attach(sessionId: string, connId: string, profile: Profile): AttachSessionResult {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { kind: "error", code: "E_UNKNOWN_SESSION", ... };
    if (entry.activeProfile.name !== profile.name) {
      return { kind: "error", code: "E_PROFILE_MISMATCH", ... };
    }
    entry.attachedConnections.add(connId);
    return { kind: "ok", status: entry.state.status, started: false, attached: entry.attachedConnections.size };
  }

  stop(sessionId: string): StopSessionResult {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { kind: "error", code: "E_UNKNOWN_SESSION", ... };
    return this.stopEntry(entry);
  }

  getServices(sessionId: string): SessionServices | null {
    return this.sessions.get(sessionId)?.wired?.services ?? null;
  }

  // For "subscribe to all" observers
  listSessions(): SessionEntry[] {
    return Array.from(this.sessions.values());
  }
}
```

**Tests:**
- `src/daemon/__tests__/supervisor-multi-session.test.ts` (NEW) — two concurrent `start()` calls with distinct sessionIds + distinct ports, both reach `running`, events arrive tagged.
- `src/daemon/__tests__/supervisor-refcount.test.ts` — extend; per-session attachedConnections sets are isolated (releasing connId from session A doesn't affect B).
- `src/daemon/__tests__/session-boot.test.ts:287` — invert (see D8).

**Verification:** vitest ✓, tsc root ✓, tsc electron ✓. No real-boot yet — that's D7.

##### D2: Thread sessionId through RPC envelopes

**Files:**
- `src/daemon/index.ts` — RPC dispatcher. Every handler at `:428-660` reads `payload.sessionId` and forwards to supervisor.
- `src/daemon/client-rpcs.ts` — `handleClientRpc` ([:42-81](../../src/daemon/client-rpcs.ts)) resolves `services` via `supervisor.getServices(sessionId)`.
- `src/core/ipc.ts` — `IpcMessage` interface optionally gains `sessionId?: string` for routing (or stays minimal if sessionId lives in `payload`).
- `src/app/client/session.ts` — client-side `DaemonSession` exposes `.sessionId` (the server-assigned id).
- `src/daemon/session.ts` — SessionEvent envelope shape change (already begun in D1).

**Pseudo-code (`src/daemon/index.ts` — events/subscribe semantics matrix):**

```ts
async function handleEventsSubscribe(connId: string, payload: { profile?: Profile; sessionId?: string }) {
  if (payload.profile && payload.sessionId) {
    return error("E_INVALID_SUBSCRIBE_ARGS");
  }

  if (payload.profile) {
    // Boot-or-join semantics
    const existing = findSessionByProfile(payload.profile);
    if (existing) {
      const r = supervisor.attach(existing.sessionId, connId, payload.profile);
      return ok({ subscribed: true, sessionId: existing.sessionId });
    }
    const sessionId = generateSessionId();
    supervisor.start(sessionId, payload.profile);
    supervisor.attach(sessionId, connId, payload.profile);
    return ok({ subscribed: true, sessionId });
  }

  if (payload.sessionId) {
    // Join by id
    const r = supervisor.attachById(payload.sessionId, connId);
    return r.kind === "ok" ? ok({ subscribed: true, sessionId: payload.sessionId }) : error(r.code);
  }

  // Observer mode — no boot, no attach; just receive events for all sessions
  return ok({ subscribed: true, observerMode: true });
}
```

**Tests:**
- `src/daemon/__tests__/subscribe-semantics.test.ts` (NEW) — all four cells of the matrix.
- `src/daemon/__tests__/session-events-envelope.test.ts` (NEW) — every SessionEvent carries sessionId; clients filter correctly.

##### D3: Per-session services (Builder + composite Metro/DevTools keys)

**Files:**
- `src/core/session/boot.ts` — `bootSessionServices` returns SessionServices keyed by composite `(worktreeKey, sessionId)`.
- `src/core/metro.ts` — `MetroManager` accepts composite key (or sessionId-suffixed worktreeKey).
- `src/core/devtools.ts` — same.
- `src/core/builder.ts` — instantiate one Builder per session (already trivially supported; just don't share across sessions).

**Key refactor decision:** the cleanest path is `MetroManager.startMetro({ worktreeKey, sessionId, ... })` where the internal Map key becomes `${worktreeKey}:${sessionId}`. Existing per-worktree call sites (single-session world) keep working because each session always has exactly one Metro per (worktreeKey, sessionId) pair.

**Tests:**
- `src/core/__tests__/metro-multi-session.test.ts` (NEW) — two MetroManager.startMetro calls with same worktreeKey but different sessionIds, two MetroInstance entries appear, ports don't collide.
- `src/core/__tests__/devtools-multi-session.test.ts` (NEW) — same pattern.
- `src/core/__tests__/builder-per-session.test.ts` (NEW) — two Builder instances run concurrent builds; `once("done")` fires correctly for each.

##### D4: ModuleHost refcount across sessions

**Files:**
- `src/core/module-host/manager.ts` — `acquire/release` already use consumer-set refcounting ([:170-285](../../src/core/module-host/manager.ts)). Verify session-stop releases all that session's consumerIds, not just the last.
- `packages/module-sdk/src/manifest.ts` — `scope` union gains `"per-session"`.
- `src/core/session/boot.ts:415` — when scope is `per-session`, scopeUnit = sessionId (not worktreeKey).

**Tests:**
- `src/core/module-host/__tests__/cross-session-refcount.test.ts` (NEW) — two sessions both `acquire` a `per-worktree`-scoped module on same worktree → one subprocess. Session A stops → subprocess survives. Session B stops → subprocess dies.
- `src/core/module-host/__tests__/per-session-scope.test.ts` (NEW) — `per-session` scope → two subprocesses for two sessions, even on same worktree.

##### D5: ServiceBus per-session payloads

**Files:**
- `src/app/service-bus.ts` — every emit gains a `sessionId` field in the payload. Subscribers filter.
- All `serviceBus.set*` / `serviceBus.on(...)` call sites — pass sessionId.

**Pseudo-code:**

```ts
// Before
serviceBus.setMetro(metroService);

// After
serviceBus.setMetro(sessionId, metroService);
// Subscribers
serviceBus.onMetro((sessionId, metro) => { if (sessionId === activeSessionId) … });
```

**Tests:**
- `src/app/__tests__/service-bus-multi-session.test.ts` (NEW) — register two Metros for two sessions; subscriber receives both with distinct sessionIds.

##### D6: fake-boot harness multi-session

**Files:**
- `src/daemon/fake-boot.ts` — `fakeBootSessionServices(opts, sessionId)` overload accepting sessionId. Existing tests using the no-sessionId form keep working via a sensible default.
- `src/daemon/__tests__/fake-boot-multi.test.ts` (NEW) — two fake-boots concurrently, both reach `metro/status: running` with correct sessionId tagging on events.

**Why fake-boot now:** all the supervisor+RPC+services refactor up to here is testable without Metro spawning. Fake-boot proves the **wire shape and state machine**, not product behavior.

##### D7: Real-boot daemon multi-session probe

**Files:**
- `tests/electron-real-e2e/multi-session-daemon.spec.ts` (NEW) — gated by `REAL_BOOT_SMOKE=1` (or `PROBE=1` for the real-e2e config).
- Reuses `tests/electron-real-e2e/launch.ts:103-126` `extraProfiles` support (already designed for this — see learnings agent's grounding).

**Test shape:**

```ts
test('one daemon hosts two concurrent sessions for the same worktree', async () => {
  const { electron, profiles } = await launchElectron({
    fixture: 'acme-mobile-app',
    profiles: [
      { name: 'iphone-physical', platform: 'ios', mode: 'quick',  metroPort: 8081, scheme: 'Acme' },
      { name: 'android-sim',     platform: 'android', mode: 'quick', metroPort: 8082 },
    ],
  });
  // start both via MCP/IPC, assert two distinct sessions reach `running`
  // assert lsof shows 8081 + 8082 bound to the same daemon pid
  // assert SessionEvent envelopes carry distinct sessionIds
  // session/stop one — other survives
});
```

**Real-boot is the only trustworthy gate** (per memory `real_boot_is_the_only_gate.md`). Three bug classes only surface under real-boot: Metro port-bound state, banner parsing, module subprocess loading. Multi-session adds a fourth: per-session lifecycle cross-contamination. Fake-boot cannot catch these.

##### D8: Invert the singleton-pin test

**File:**
- `src/daemon/__tests__/session-boot.test.ts:287-333` — current test asserts `E_SESSION_ALREADY_RUNNING`. Flip to:
  - "Two `session/start` calls with distinct sessionIds + distinct ports BOTH succeed."
  - Add new test: "Two `session/start` calls with the same sessionId → second returns `E_SESSION_ALREADY_EXISTS`."
  - Add new test: "Two `session/start` calls with distinct sessionIds but colliding `profile.metroPort` → second returns `E_PORT_CONFLICT`."

**Phase D acceptance gate:** vitest ✓ (with new tests), tsc root ✓, tsc electron ✓, **REAL_BOOT_SMOKE D7 spec green**, manual probe against acme-mobile-app confirming two Metros running concurrently bound on 8081+8082 inside one daemon pid.

---

#### Phase M — MCP multi-session client (after D6, parallel with E)

##### M1: McpContext supports N sessions

**Files:**
- `src/mcp/server.ts:117-153` — `McpContext.session` (singular) → `McpContext.sessions: Map<sessionId, DaemonSession>` + `McpContext.defaultSessionId?: string`.
- `src/mcp/tools.ts:46-76` — every tool's input schema gains `sessionId?: string` (per DR-2, this is required when >1 session exists; optional when exactly one).

##### M2: `rn-dev/start-session` returns sessionId

**File:**
- `src/mcp/tools.ts:215-244` — tool returns `{ sessionId, status }`. The agent reads the sessionId from the tool response, then passes it as `sessionId` to subsequent `rn-dev/build`, `rn-dev/devtools-network/capture`, etc.

##### M3: Probe parallel sessions through MCP

**File:**
- `src/mcp/__tests__/probe-real-build-mcp-multi.spec.ts` (NEW, PROBE=1 gated) — start two sessions for two profiles via MCP, kick `rn-dev/build` against each, assert both builds run concurrently.
- `src/mcp/__tests__/probe-real-devtools-mcp-multi.spec.ts` (NEW, PROBE=1 gated) — capture devtools-network frames from two distinct sessions, assert no cross-contamination.

**Phase M acceptance gate:** vitest ✓, tsc ✓, PROBE=1 multi-session probes green.

---

#### Phase E — Electron multi-session renderer (after D6, parallel with M)

##### E1: state.daemonSession singleton → Map

**Files:**
- `electron/ipc/state.ts:38-54` — replace `daemonSession`, `daemonSessionProfileName`, `activeInstanceId` with:

```ts
type SessionRecord = {
  sessionId: string;
  daemonSession: DaemonSession;
  instanceId: string;        // existing instance abstraction stays — one instance per session
  profileName: string;
  attachedAt: number;
};

const state = {
  instances: new Map<string, Instance>(),  // unchanged
  sessions: new Map<string, SessionRecord>(),   // NEW: keyed by sessionId
  activeSessionId: null as string | null,       // NEW: which tab is in focus
  projectRoot: null as string | null,           // unchanged (one project per Electron app)
};
```

##### E2: IPC handlers thread sessionId

**Files (per learnings + repo-research grounding):**
- `electron/ipc/instance.ts` — `instances:list`, `instances:create`, `instances:remove`, `instances:setActive`, `instances:getActive`, `instance:retryStep`, `instances:getLogs` ([:31-291](../../electron/ipc/instance.ts)). The cross-profile rejection at [:174-191](../../electron/ipc/instance.ts) is **removed**. New error path: `E_SESSION_LIMIT_REACHED` (cap at 4 concurrent sessions for v1 — protects against runaway tab creation).
- `electron/ipc/metro.ts`, `electron/ipc/devtools.ts`, `electron/ipc/tools.ts` — each invokes `state.sessions.get(sessionId)?.daemonSession.metro/devtools/builder.*`.
- `electron/ipc/services.ts:251-281, 295-335` — `attachDaemonSession` becomes `attachSession(sessionId, daemonSession)`; `wireInstanceEvents` becomes `wireSessionEvents(sessionId, daemonSession)`, with all events carrying sessionId in their renderer-facing payload.
- `electron/ipc/modules-config.ts`, `electron/ipc/modules-install.ts`, `electron/ipc/modules-panels.ts` — `awaitModulesClient()` resolves per-session via `state.sessions.get(sessionId)?.daemonSession.modules`.
- `electron/ipc/wizard.ts`, `electron/ipc/profile.ts` — no per-session need; profile CRUD is global.

##### E3: serviceBus subscribers filter

**Files:**
- `electron/ipc/index.ts:104-110, 171-180, 287-290` — IPC bridge subscriptions multiplex events to renderer with sessionId in payload.

##### E4: Renderer App.tsx multi-session UI

**Files:**
- `renderer/App.tsx` — top-level tab strip / split-pane component. One tab per active session. Click to focus → `activeSessionId` becomes that tab's id.
- `renderer/components/SessionTabStrip.tsx` (NEW) — renders tabs with profile name + status badge + close button.
- `renderer/components/NewSessionButton.tsx` (NEW) — "+" button next to active session; opens profile picker modal.
- `renderer/components/CloseSessionModal.tsx` (NEW) — confirmation modal for destructive close (per memory `feedback_modal_over_inline_confirm.md`: real modal with Cancel/Confirm, Esc dismiss, NOT a two-click inline affordance).

**UX shape:** v1 supports 2 concurrent sessions visibly (the user-facing iPhone+Android story). The data model and IPC handlers support up to 4. Tab strip is the only layout in v1 — no split-pane side-by-side (deferred to a future plan if users ask).

##### E5: Renderer test pattern extended

**Files:**
- `renderer/components/__tests__/SessionTabStrip.test.tsx` (NEW) — stub bridge per pattern at [renderer/components/__tests__/ModuleConfigForm.test.tsx:17-49](../../renderer/components/__tests__/ModuleConfigForm.test.tsx); mount two sessions; assert tab switching updates `activeSessionId` via IPC `instances:setActive`.
- `renderer/components/__tests__/CloseSessionModal.test.tsx` (NEW) — modal mounts; Cancel doesn't fire `instances:remove`; Confirm does; Esc dismisses without firing.

##### E6: Real-boot Electron multi-session

**Files:**
- `tests/electron-real-e2e/multi-session-electron.spec.ts` (NEW, REAL_BOOT_SMOKE=1) — uses existing `extraProfiles` support at [tests/electron-real-e2e/launch.ts:103-126](../../tests/electron-real-e2e/launch.ts).

**Test shape:**

```ts
test('Electron renders two sessions in two tabs from one daemon', async () => {
  const { electron, page } = await launchElectron({
    fixture: 'acme-mobile-app',
    profiles: [
      { name: 'iphone',  platform: 'ios',     metroPort: 8081, scheme: 'Acme' },
      { name: 'android', platform: 'android', metroPort: 8082 },
    ],
  });
  // Click "+" to create second session via instances:create
  // Assert: two tabs visible
  // Switch tabs — DevTools panel renders the focused session's data
  // Close one tab — modal appears, Confirm — that session's Metro stops, other survives
  // Assert: lsof shows other Metro port still bound
});
```

**Phase E acceptance gate:** vitest ✓ (new renderer specs), tsc root ✓, tsc electron ✓, REAL_BOOT_SMOKE E6 spec green.

---

#### Phase T — TUI multi-session (after D, can be deferred)

The TUI multi-session story is intentionally smaller than Electron/MCP because the TUI has no "tabs" surface today.

##### T1: TUI start-flow supports N sessions

**Files:**
- `src/app/start-flow.ts:114` — `let session: DaemonSession | null` → `const sessions = new Map<string, DaemonSession>()`.
- Input handler — Ctrl-1/Ctrl-2 switches active session; status header renders profile name of active session.

##### T2: TUI real-process multi-session

**File:**
- `src/app/__tests__/start-flow-multi.test.ts` (NEW) — start two sessions, assert both reach running, key-switch updates active session.

**Note:** This phase **does NOT depend on the older T1 plan at [docs/plans/2026-05-06-tui-mcp-real-process-test-parity.md]**, which is about ANSI parsing for the test harness. Different work.

**Phase T can be deferred** after E ships if user demand is GUI-focused. Per memory `feedback_test_parity_no_gaps.md`, the gap must close eventually — we don't ship "Electron has it, TUI doesn't" indefinitely. Acceptable interim: 1-2 weeks max between E shipping and T landing.

---

#### Phase X — Cross-cutting verification + memory

##### X1: Three-layer gate on `main` (per CLAUDE.md)

- [ ] `npx vitest run` — all new specs green; existing baseline preserved.
- [ ] `npx tsc --noEmit && npx tsc --noEmit -p electron/tsconfig.json` — zero new errors.
- [ ] `REAL_BOOT_SMOKE=1 npx playwright test --config playwright.config.ts` — all electron-smoke specs green; multi-session smoke green.
- [ ] `PROBE=1 npx playwright test --config tests/electron-real-e2e/playwright.config.ts` — multi-session real-e2e specs green.
- [ ] `PROBE=1 npx vitest run src/mcp/__tests__/probe-real-build-mcp-multi.spec.ts` — multi-session MCP probe green.
- [ ] No daemon leaks across full gate (check via `pkill -9 -f "src/index.tsx daemon"` after each layer; should report 0 processes).

##### X2: Memory entries written

- `multi_session_landed.md` — landing summary with commit range, test results, known gaps.
- Update `feedback_test_parity_no_gaps.md` if any cross-client gap remains (e.g. if Phase T is deferred).

##### X3: Solutions doc

- `docs/solutions/2026-05-12-multi-session-daemon-pattern.md` — captures the Map<sessionId, SessionEntry> pattern, composite Metro/DevTools keying, ServiceBus payload-multiplexing, and the events/subscribe semantics matrix. Next refactor that touches session lifecycle reuses this.

##### X4: Single-branch hygiene (per CLAUDE.md)

- All work lands directly on `main`. No `claude/*`, `feat/*`, `fix/*` branches. No `git worktree add`.
- Personal account (`martincacme` per memory `workflow_local_only_personal_account.md`): commits stay local. **No push. No PR.** Push flow belongs to the work account.

## Alternative Approaches Considered

### A1: Subprocess-per-session isolation

**Approach:** Each session runs in its own daemon subprocess; the parent daemon becomes a router.

**Why rejected (v1):**
- 2-3× larger refactor scope. Touches process lifecycle, IPC framing, audit log multi-writer, port allocation, socket handshake.
- Existing ModuleHost subprocess pattern already isolates the high-risk-third-party-code surface. The remaining "Metro/DevTools/Builder" code is first-party and stable; subprocess isolation buys little there today.
- A misbehaving Metro in one session brings down only its own process tree (Metro IS already a subprocess); the daemon process doesn't crash on Metro crashes today.

**When to revisit:** if real-world dogfooding shows cross-session interference (e.g. Builder concurrency bugs, EventEmitter memory pressure, Node loop saturation), promote to a v2 plan.

### A2: Implicit "default session" fallback

**Approach:** If RPC omits `sessionId`, use the only active session. Error if 0 or >1.

**Why rejected:** Two code paths breed bugs at the boundary — specifically the "but there are 0 sessions" case becomes a runtime error instead of a type error. Every in-repo caller already lives in this plan's scope; a clean break is cheaper than the compatibility shim that lives forever.

### A3: Session-scoped event subscriptions

**Approach:** `events/subscribe { sessionId }` returns only that session's events.

**Why rejected:** Renderer and MCP both want all-sessions data (tab strip status badges, agent multi-session orchestration). Session-scoped subscriptions force them to maintain N subscriptions and reconcile on session-add/remove. All-sessions-with-filter is simpler and the event volume is bounded (these aren't telemetry firehoses).

### A4: Reuse `worktreeKey` as the session key

**Approach:** Don't introduce sessionId at all; let two profiles for the same worktree collide.

**Why rejected:** Directly contradicts the user-visible value (same project, two devices). Would only support cross-worktree concurrency, which already works.

## System-Wide Impact

### Interaction Graph

When the user creates a second session (e.g. clicks "+" in the renderer for a second profile in the same worktree):

```
renderer SessionTabStrip
  → IPC instances:create { profileName: "android-sim" }
    → electron/ipc/instance.ts handler
      → resolves DaemonSession via daemon connect (existing daemon for this worktree)
        → daemon supervisor.start(sessionId = uuid, profile)
          → supervisor.bootAsync(entry)
            → bootSessionServices(opts) [src/core/session/boot.ts]
              → MetroManager.startMetro({ worktreeKey, sessionId, port: 8082 })
              → DevToolsManager.start({ worktreeKey, sessionId })
              → new Builder() (per-session)
              → ModuleRegistry registers built-ins for this session's consumerId
              → for each per-worktree-scope module: ModuleHostManager.acquire(registered, consumerId)
                → existing entry exists (session A already loaded it) — consumer set adds new consumerId, subprocess SHARED
              → for each per-session-scope module (NEW scope): ModuleHostManager.acquire(registered, consumerId)
                → no entry — spawns new subprocess
            → entry.wired = { services, detach, epoch }
            → supervisor emits SessionEvent { kind: "session/status", sessionId, worktreeKey, data: { status: "running" }}
              → serviceBus emit (carries sessionId)
                → IPC bridge forwards to renderer with sessionId in payload
                  → renderer dispatches by sessionId → SessionTabStrip updates badge
                  → state.sessions.set(sessionId, ...)
                  → state.activeSessionId = sessionId
```

Concurrent `auto-build.ts:triggerBuildsIfNeeded(sessionB, profileB, projectRoot)`:

```
auto-build → setTimeout(200)
  → for plat of ["ios", "android"] (intra-session fan-out, preserved):
    → sessionB.builder.build({ ..., platform: plat })
      → builder/build RPC with sessionId = B
        → handleBuilderBuild [src/daemon/client-rpcs.ts:169-218]
          → supervisor.getServices("B").builder.build(opts)
            → Builder_B (per-session instance, isolated from Builder_A)
              → emits "done" — Builder_B.once("done", postHook) fires correctly
              → audit log append with { sessionId: "B", action: "build/done", ... }
```

### Error & Failure Propagation

| Error class | Source | Propagation today | Propagation after |
|---|---|---|---|
| `E_PROFILE_MISMATCH` | supervisor attach | rejects 2nd profile in renderer | renamed `E_SESSION_NOT_FOUND` (attach by id); profile-mismatch happens only on rejoin of wrong id |
| `E_SESSION_ALREADY_RUNNING` | supervisor start | rejects 2nd `session/start` | replaced by `E_SESSION_ALREADY_EXISTS` (same sessionId twice) |
| `E_PORT_CONFLICT` (NEW) | supervisor start | n/a | rejects when profile.metroPort collides with another active session |
| `E_SESSION_LIMIT_REACHED` (NEW) | renderer instances:create | n/a | hard cap at 4 concurrent sessions per Electron app |
| `E_UNKNOWN_SESSION` (NEW) | every sessionId-scoped RPC | n/a | client passed a sessionId not in supervisor.sessions Map |
| Metro crash | MetroManager | emits `metro/status: stopped` for worktreeKey | emits with sessionId; only the crashing session's tab shows stopped status; sibling session untouched |
| Daemon crash | OS | all clients disconnect; orphan-sweep cleans up | unchanged blast radius (one daemon) — all sessions die together; this is the same "in-process" tradeoff documented in DR-3 |

**Retry conflict:** none introduced. Per-session Builder eliminates today's intra-session fan-out fragility around `.once("done")` cross-talk (DR-8).

**Silent failure to watch for:** if `serviceBus.emit` drops `sessionId` from a payload (refactor regression), the renderer's filter rejects the event and the UI doesn't update. Test coverage in E5 specifically asserts sessionId propagation end-to-end.

### State Lifecycle Risks

| Step | Persistence | Partial-failure risk |
|---|---|---|
| `supervisor.start(sessionId, profile)` | in-memory Map entry | orphaned entry if bootAsync throws BEFORE wired services attach → fixed by existing `bootEpoch` invalidation, but the entry is left in `stopped` state; tests must assert cleanup |
| `MetroManager.startMetro` | spawned process + port-bound | if Metro spawns but events never fire, the entry exists with no liveness; existing `findProcessOnPort` lsof check is the recovery; ensure `-a` flag (per memory `lsof_gotchas.md`) |
| `ModuleHostManager.acquire` (shared subprocess) | consumer set + subprocess | session B acquires, gets shared subprocess, session B crashes before recording → release never called → consumer set leaks indefinitely; existing per-consumer disposal in supervisor.detach handles this |
| `audit.log` HMAC-chained append | append-only file + lockfile | already handles multi-writer (per learnings); add sessionId to every audit entry payload for post-mortem correlation |
| renderer `state.sessions.set` | in-memory Map | if Electron quits mid-attach, the daemon's sessionId is orphaned for ~30s until orphan-sweep clears it; unchanged blast radius |

### API Surface Parity

| Surface | Today | After |
|---|---|---|
| MCP tools | `rn-dev/*` — no sessionId | `rn-dev/*` — `sessionId?` arg, required when >1 session |
| TUI `start-flow` | single session | `sessions: Map`, Ctrl-N switches |
| Electron IPC | `state.daemonSession` singleton | `state.sessions: Map`, sessionId in payloads |
| Daemon RPC | `{action, payload}` | `{action, payload: { sessionId, ... }}` |
| ServiceBus topics | `metro`, `builder`, `devtools` | unchanged topics; sessionId in event payload |
| Module SDK manifest `scope` | `"global" \| "per-worktree" \| "workspace"` | adds `"per-session"` |
| `.rn-dev/sock` | per-worktree | unchanged (one socket serves N sessions) |
| `~/.rn-dev/audit.log` | HMAC-chained | unchanged structure; sessionId added to entry payloads |
| `.rn-dev/pid` | per-daemon | unchanged |

### Integration Test Scenarios

Five cross-layer scenarios that unit tests with mocks would never catch:

1. **Two real Metros, one daemon, same worktree, distinct ports** — `tests/electron-real-e2e/multi-session-daemon.spec.ts` (D7). Asserts `lsof -P -i :8081 -t` and `lsof -P -i :8082 -t` both resolve to the same daemon pid. Catches: composite-key MetroManager regressions, port allocation bugs, daemon process-tree leaks.

2. **Concurrent build in two sessions, post-hook fires for each Build separately** — `src/core/__tests__/builder-per-session.test.ts` (D3). Asserts both `once("done")` handlers fire with correct context. Catches: per-session Builder regression (DR-8).

3. **Module subprocess shared across two same-worktree sessions, one session stops, subprocess survives** — `src/core/module-host/__tests__/cross-session-refcount.test.ts` (D4). Catches: consumer-set leaks, premature subprocess teardown.

4. **Renderer renders two tabs, click-switch updates active session without remounting sibling components** — `renderer/components/__tests__/SessionTabStrip.test.tsx` (E5). Catches: React-tree state contamination, useEffect re-fires on tab switch.

5. **MCP agent issues `rn-dev/build` against session B while session A is mid-build, both complete independently** — `src/mcp/__tests__/probe-real-build-mcp-multi.spec.ts` (M3, PROBE=1). Catches: MCP session-routing bugs, sessionId payload-drop regressions.

## Scope cuts — explicitly NOT included in this plan

Per the brief, these are deliberate non-goals. Calling them out so future work has a clear surface:

1. **Session affinity for cross-platform RPCs** — MCP tools must pass `sessionId` explicitly. No "remember which session the user last touched" smart-routing.
2. **Sandbox isolation between sessions** — sessions share the daemon process. A Metro/build cascading failure in one session is still in-process to others. ModuleHost subprocess isolation is the only isolation v1 ships. (Promote to v2 plan if real-world pain appears — see Alternative A1.)
3. **UI for "which session does this tool action target?"** — MCP clients pass sessionId. Renderer's tab strip is the only "session picker" UI. No global command palette with session disambiguation in v1.
4. **Resource quotas per session** — no CPU/memory limits, no Metro port pool management beyond `E_PORT_CONFLICT` rejection. v1 trusts the dev not to spawn 100 sessions.
5. **Per-session permissions / consent gating** — single daemon-level consent model applies to all sessions. If a module needs per-session consent, that's a v2 module-SDK extension.
6. **Session migration / hot-resume** — daemon restart still kills all sessions. No special "resume after daemon crash" logic for multi-session beyond what single-session does today.
7. **Cross-session module sharing optimization** — `per-worktree` scope already shares subprocesses (existing behavior, retained). No new "session-affinity" rules for modules beyond the new `per-session` scope.
8. **Renderer UI for >2 visible sessions** — data model + IPC support up to 4, but layout is tab-strip only. No split-pane side-by-side. Add if users ask.
9. **Profile-list "create multi-session preset"** — wizard creates one profile per pass. To get two sessions, user creates two profiles and starts both. No "preset bundle" for "iPhone + Android at once."
10. **Audit log per-session views** — sessionId is in audit entries, but no audit-viewer UI filters by sessionId. Future work.

## Acceptance Criteria

### Functional Requirements

- [ ] Daemon supervisor accepts N concurrent `session/start` calls with distinct sessionIds.
- [ ] `events/subscribe` semantics matrix (DR-4) implemented and tested (all four cells).
- [ ] Every `SessionEvent` envelope carries a non-empty `sessionId` string.
- [ ] MCP tools accept `sessionId` arg; `rn-dev/start-session` returns sessionId in response.
- [ ] Electron renderer renders two tabs for two active sessions; switching tabs updates `activeSessionId` IPC state.
- [ ] Closing a session via the renderer tab modal stops that session's Metro/DevTools/Builder without affecting siblings.
- [ ] Same-worktree two-session start with colliding `metroPort` returns `E_PORT_CONFLICT` (not silent port shift).
- [ ] `auto-build.ts:triggerBuildsIfNeeded` intra-session fan-out (iOS+Android in parallel for `platform: "both"`) unchanged.

### Non-Functional Requirements

- [ ] No new daemon-process leaks. Full test gate completes with `pgrep -f "src/index.tsx daemon" | wc -l` returning 0.
- [ ] Two concurrent Metro instances for the same worktree use distinct ports as verified by `lsof -a -P -i :PORT -sTCP:LISTEN -t`.
- [ ] Renderer tab switch latency < 100ms (subjective; no perf test in v1, but watch for it).
- [ ] No memory leaks across 1h soak with 2 sessions running idle.

### Quality Gates (per CLAUDE.md three-layer rule)

- [ ] `npx vitest run` — all new specs + existing baseline.
- [ ] `npx tsc --noEmit && npx tsc --noEmit -p electron/tsconfig.json` — zero new errors.
- [ ] `REAL_BOOT_SMOKE=1 npx playwright test --config playwright.config.ts` — all electron-smoke specs green (including multi-session smoke at E6).
- [ ] `PROBE=1 npx playwright test --config tests/electron-real-e2e/playwright.config.ts` — multi-session real-e2e probes (D7, E6) green.
- [ ] `PROBE=1 npx vitest run src/mcp/__tests__/probe-real-build-mcp-multi.spec.ts` — MCP multi-session probe green.
- [ ] Test parity per memory `feedback_test_parity_no_gaps.md`: TUI/Electron/MCP all have multi-session coverage at all three layers (fast, type, real-boot).

## Success Metrics

- **Primary:** A real user can run iPhone + Android side-by-side for acme-mobile-app from one Electron window. Measured: manual probe documented with screenshots in `memory/multi_session_landed.md`.
- **Secondary:** Daemon hosts ≥2 concurrent sessions without process leaks across a 30-minute soak test.
- **Tertiary:** Zero regressions in single-session flows. Existing vitest count + 1h acme-mobile-app dogfooding clean.
- **Tertiary:** MCP agent can drive two parallel builds via tool calls. Verified by `probe-real-build-mcp-multi`.

## Dependencies & Prerequisites

- **None blocking.** This plan depends on landed phases (H1+H2 hook system, M1+M2 MCP parity, Phase 13.5 daemon-services).
- The 30-commit-ahead window on `main` is the starting point. No outstanding rebase work.
- Acme-mobile-app physical iPhone setup (per memory `environment_setup.md`) is the real-boot target.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Composite-key (worktreeKey + sessionId) refactor in MetroManager breaks single-session callers | M | High | Phase D3 lands behind comprehensive test; flip session-boot.test.ts:287 last, not first. |
| Builder `.once("done")` cross-talk under two sessions × two platforms = 4 concurrent builds | M | High | Per-session Builder (DR-8) eliminates cross-session cross-talk; intra-session fan-out fragility is a pre-existing condition addressed only by per-session isolation. |
| `auto-build.ts` regression — accidentally lose intra-session fan-out | L | High | Explicit test in D3 asserts iOS+Android both fire from one sessionB.builder. |
| Renderer reconciliation bugs (React) on session switch (state leaks across tabs) | M | M | E5 test asserts tab-isolated component state; manual probe in E6 watches for re-mount flickers. |
| MCP tool input-schema breaking change (sessionId now required) breaks agents in the wild | L | M | All MCP consumers are in this repo. Update simultaneously. Add `sessionId?` schema with explicit `E_SESSION_AMBIGUOUS` error when `>1 sessions && !sessionId`. |
| ModuleHost consumer-set leak when session crashes mid-acquire | L | M | Existing `supervisor.detach` per-consumer cleanup; D4 test asserts crash-mid-acquire path. |
| Port-allocation race: two sessions racing to bind 8081 simultaneously | L | L | `E_PORT_CONFLICT` is checked in supervisor.start BEFORE MetroManager.startMetro; race window is single-threaded JS so effectively zero. |
| `lsof -a` regression | L | High | Audit `MetroManager.findProcessOnPort()` before D7. Memory entry exists for exactly this gotcha. |
| Audit-log HMAC chain breaks under multi-session writes | VL | High | Existing O_EXCL lockfile + tail-re-read serializes writers; sessionId is a payload field, doesn't affect chain integrity. Test confirms HMAC validation post-multi-session-soak. |

## Resource Requirements

- **Effort:** ~2-3 days for Phase D (deep daemon-core refactor), ~1-2 days each for Phases M, E, T. Total estimate: 6-9 days of focused work. Real wall-clock with the user's existing test+real-boot gate: likely 2-3 weeks elapsed.
- **Tooling:** existing. No new dependencies.
- **Test infrastructure:** existing. Real-e2e harness already supports `extraProfiles` (learnings agent confirmed).

## Future Considerations

- **v2: subprocess-per-session isolation** if real-world pain shows up (see Alternative A1).
- **v2: profile-bundle presets** — wizard creates an "iPhone + Android" preset that boots both with one click.
- **v2: per-session consent + permissions** if module-SDK use cases demand finer-grained gating.
- **v2: split-pane renderer layout** if users ask for true side-by-side (vs tab-switch) UX.
- **v2: cross-daemon session migration** for the cross-worktree case (currently each worktree has its own daemon; sessions don't migrate between them).

## Documentation Plan

- This plan IS the architectural doc; update inline as decisions evolve during implementation. Do not let the plan diverge from `main`.
- New solutions doc at X3: `docs/solutions/2026-05-12-multi-session-daemon-pattern.md` (writes the canonical pattern down for the next refactor).
- Update [CLAUDE.md](../../CLAUDE.md) "Patterns to mirror" section if any new pattern (e.g. composite Map keys, per-session ServiceBus payload multiplexing) becomes load-bearing for future modules.
- Update [docs/plans/2026-05-07-next-session-prompt.md:29-30](../../docs/plans/2026-05-07-next-session-prompt.md) — strike-through the "Phase 13.6+ — tracked, not blocking" line once Phase E lands. Reference this plan.

## Deepening insights (2026-05-12 review pass)

Eight parallel review agents stress-tested the plan against the rn-dev-cli codebase. Findings are organized by category below; every file:line reference is to the actual code in this repo.

### A. Critical pre-D1 foundation (new Phase D0.5)

These six items MUST land before D1 (the supervisor refactor) or downstream phases ship silent regressions. None invent new code paths — all six are foundational refactors that change the surface area of TypeScript types used by everything downstream.

#### A1. Branded `SessionId` + `WorktreeKey` types

**Source:** kieran-typescript finding #1.

The codebase already uses two distinct branded-type patterns: `NetworkCursor` at [src/core/devtools/types.ts:103](../../src/core/devtools/types.ts) and `ValidatedProfile` at [src/daemon/profile-guard.ts:28-30](../../src/daemon/profile-guard.ts). The latter is the closest analog — single mint point via `validateProfile`, downstream APIs accept only the brand.

```ts
// src/daemon/session-id.ts (NEW)
declare const SessionIdBrand: unique symbol;
export type SessionId = string & { readonly [SessionIdBrand]: true };
export function generateSessionId(): SessionId {
  return crypto.randomUUID() as SessionId;
}

declare const WorktreeKeyBrand: unique symbol;
export type WorktreeKey = string & { readonly [WorktreeKeyBrand]: true };
export function asWorktreeKey(s: string): WorktreeKey {
  return s as WorktreeKey; // minted by ArtifactStore.worktreeHash; trust the caller
}
```

Test helper needed (else casts proliferate across tests):
```ts
// src/__test_utils__/session-id.ts (NEW)
export const testSessionId = (s: string): SessionId => s as SessionId;
export const testWorktreeKey = (s: string): WorktreeKey => s as WorktreeKey;
```

#### A2. Composite-key helper (kill string-concat at call sites)

**Source:** kieran-typescript finding #2, architecture finding #4, simplicity finding #4.

Three reviewers converged on this. The plan's `${worktreeKey}:${sessionId}` literal concat is stringly-typed and lossy on parse. The codebase's existing `ModuleHostManager.keyFor` at [src/core/module-host/manager.ts:579-581](../../src/core/module-host/manager.ts) uses the same single-colon delimiter for a different purpose, so the convention isn't wrong — but a typed helper makes the invariant explicit:

```ts
// src/core/session-key.ts (NEW)
export type SessionKey = string & { readonly __brand: "SessionKey" };
export function sessionKey(worktreeKey: WorktreeKey, sessionId: SessionId): SessionKey {
  if (worktreeKey.includes(":")) {
    throw new Error(`E_INVALID_WORKTREE_KEY: contains colon: ${worktreeKey}`);
  }
  return `${worktreeKey}:${sessionId}` as SessionKey;
}
```

Simplicity reviewer pushed for an even stronger cut: drop `worktreeKey` from the Map key entirely (key Metro/DevTools Maps by `SessionId` alone, keep `worktreeKey` as a field on the value object). **Adopt this.** SessionId is unique by construction; `worktreeKey` is metadata, not identity. Update D3 spec accordingly.

#### A3. RPC payload narrowers in the args.ts idiom

**Source:** kieran-typescript finding #4.

There is no Zod in this codebase. The in-repo idiom is hand-rolled narrowers at [packages/module-sdk/src/args.ts](../../packages/module-sdk/src/args.ts) (`str()`, `requireStr()`, `boundedInt()`, `ringCursor()`). Plan's pseudo-code at D2 reads `payload.sessionId` raw at every RPC handler — that's `Record<string, unknown>` access without narrowing.

New file `src/daemon/rpc-args.ts` mirrors the module-sdk narrower pattern:
```ts
export function requireSessionId(payload: unknown, ctx: string): SessionId {
  if (!payload || typeof payload !== "object") {
    throw new RpcError("E_RPC_INVALID_PAYLOAD", `${ctx}: payload not object`);
  }
  const sid = (payload as Record<string, unknown>).sessionId;
  if (typeof sid !== "string" || sid.length === 0) {
    throw new RpcError("E_RPC_INVALID_PAYLOAD", `${ctx}: sessionId required`);
  }
  return sid as SessionId;
}

export function optionalSessionId(payload: unknown): SessionId | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const sid = (payload as Record<string, unknown>).sessionId;
  return typeof sid === "string" && sid.length > 0 ? (sid as SessionId) : undefined;
}
```

Every D2 handler uses `requireSessionId(payload, "session/stop")` instead of raw access. `events/subscribe` is the one handler using `optionalSessionId`.

#### A4. `events/subscribe` discriminated union input

**Source:** kieran-typescript finding #5.

Plan's four-cell semantics matrix is textbook-discriminated-union. The current `{ profile?: Profile; sessionId?: string }` shape makes the "both" cell representable at compile time — a runtime check (`E_INVALID_SUBSCRIBE_ARGS`) for what should be a type error.

```ts
// src/daemon/session.ts
export type EventsSubscribeInput =
  | { mode: "boot-or-join"; profile: ValidatedProfile }
  | { mode: "attach-by-id"; sessionId: SessionId };
// "observer-all" mode removed — see § B2 below
```

Wire format stays JSON, but the narrower at the boundary returns the union. Downstream `handleEventsSubscribe` switches on `mode` exhaustively.

#### A5. Central `SessionErrorCode` union

**Source:** kieran-typescript finding #6.

Audited: `grep "code: \"E_" src/daemon/index.ts` shows error codes as bare string literals at use sites with NO central union type. The plan adds 4 codes (`E_UNKNOWN_SESSION`, `E_PORT_CONFLICT`, `E_SESSION_LIMIT_REACHED` [now cut — see § B5], `E_SESSION_ALREADY_EXISTS`) and renames 2 (`E_PROFILE_MISMATCH` → `E_SESSION_NOT_FOUND` for the attachById path; `E_SESSION_ALREADY_RUNNING` → `E_SESSION_ALREADY_EXISTS`).

Without a union, the renames are silent — any string-comparing caller keeps compiling against the old code. Phase D0.5 introduces:

```ts
// src/daemon/error-codes.ts (NEW)
export type SessionErrorCode =
  | "E_UNKNOWN_SESSION"
  | "E_SESSION_ALREADY_EXISTS"
  | "E_PORT_CONFLICT"
  | "E_SESSION_AMBIGUOUS"
  | "E_SUBSCRIBE_INVALID_ARGS"  // renamed from E_INVALID_SUBSCRIBE_ARGS per pattern review § E2
  | "E_PROFILE_BOOT_IN_FLIGHT"  // NEW — see § A8 race fix
  // Legacy codes retained for non-multi-session paths:
  | "E_PROFILE_MISMATCH"
  | "E_SESSION_NOT_RUNNING"
  | "E_SESSION_STOPPING"
  | "E_RPC_INVALID_PAYLOAD"
  | "E_SUBSCRIBE_INVALID_KINDS";

export type RpcResult<T> = { kind: "ok"; value: T } | { kind: "error"; code: SessionErrorCode; message: string };
```

#### A6. ModuleScope union → exhaustive switch (latent bug fix)

**Source:** kieran-typescript finding #9.

Real latent bug surfaced by grepping `manifest.scope === "global"` against the codebase. The scope union at [packages/module-sdk/src/types.ts:5](../../packages/module-sdk/src/types.ts) is `"global" | "per-worktree" | "workspace"`. At [src/core/module-host/manager.ts:279, 454](../../src/core/module-host/manager.ts) the dispatch is `if (scope === "global") ... else ...` — non-exhaustive. `"workspace"` already falls through silently today; this is a pre-existing gap.

Even though DR-9 is now cut (no new `"per-session"` value — see § B4), Phase D0.5 should still convert these sites to exhaustive switch:

```ts
function scopeUnitFor(scope: ModuleScope, ctx: { worktreeKey: WorktreeKey; sessionId: SessionId }): string {
  switch (scope) {
    case "global": return "global";
    case "per-worktree": return ctx.worktreeKey;
    case "workspace": return /* current handling */;
    default: { const _exhaustive: never = scope; throw new Error(`unhandled scope: ${_exhaustive}`); }
  }
}
```

This pays forward: if future plans re-introduce `"per-session"` (or any other scope), the compiler will flag every site that needs updating.

#### A7. Fix `disconnectLoggedFor` module-scope state (Phase E1)

**Source:** julik-frontend-races finding #1, Critical.

At [electron/ipc/services.ts:227, 256-280](../../electron/ipc/services.ts), `disconnectLoggedFor` is a module-scope variable reset on every `attachDaemonSession` call. Today only one session exists at a time, so it's a singleton-by-coincidence. After the plan it must move into `SessionTabState` (renamed from the proposed `SessionRecord` per § E1):

```ts
type SessionTabState = {
  sessionId: SessionId;
  daemonSession: DaemonSession;
  instanceId: string;
  profileName: string;
  attachedAt: number;
  disconnectLoggedFor: SessionId | null;        // NEW per-tab
  releaseFns: Array<() => void>;                // NEW: per-tab listener cleanup
};
```

Plus a state machine guarding re-entrant attach:
```ts
type AttachState = "ATTACHING" | "LIVE" | "DETACHING" | "DEAD";
```

Refuse second attach for the same sessionId while in ATTACHING. Without these two changes the disconnect-log for session A gets swallowed when session B attaches mid-flight — silent failure mode.

#### A8. Serialize `instances:create` (Phase E2)

**Source:** julik-frontend-races finding #2, Critical.

At [electron/ipc/instance.ts:103-153](../../electron/ipc/instance.ts) two concurrent `instances:create` calls both evaluate `!state.daemonSession` truthy because neither has finished the `await connectElectronToDaemon` boundary. After both resolve, **the loser leaks a fully-wired DaemonSession with zero references** — its Metro/Builder listeners are still attached and forwarding events to a ghost tab.

The plan's `Map<sessionId, SessionTabState>` is necessary but not sufficient. Mirror the existing `pendingClientPromise` pattern at [electron/ipc/index.ts:57](../../electron/ipc/index.ts):

```ts
const pendingSessions = new Map<SessionId, Promise<SessionTabState>>();

async function handleInstancesCreate(payload: { profileName: string }) {
  const sessionId = generateSessionId();
  if (pendingSessions.has(sessionId)) {
    return pendingSessions.get(sessionId)!; // shouldn't happen with UUID, but defense
  }
  const p = attachNewSession(sessionId, payload.profileName);
  pendingSessions.set(sessionId, p);
  try { return await p; } finally { pendingSessions.delete(sessionId); }
}
```

Also: daemon-side, `findSessionByProfile` (D2 pseudo-code line 322) does read-then-write without synchronization. Two simultaneous `events/subscribe { profile }` calls can both miss the existing match. Add a per-`(worktreeKey, profile.name)` lock or check-and-set, returning the new error code `E_PROFILE_BOOT_IN_FLIGHT` with the in-flight sessionId so the loser joins instead of double-booting.

### B. Decision register revisions

#### B1. DR-2 reinforced — no implicit defaults, narrowers required

DR-2 stands. The architecture and TypeScript reviewers both endorsed it. Reinforcement: the `requireSessionId` / `optionalSessionId` narrowers from § A3 are the enforcement mechanism. Every RPC handler at [src/daemon/index.ts:428-660](../../src/daemon/index.ts) uses `requireSessionId(payload, "<handler-name>")` — the cost is one line per handler, the gain is type-safe access.

#### B2. DR-4 — replace "observer-mode subscribe" with explicit `sessions/list` RPC

**Conflict resolution between simplicity (cut observer mode) and spec-flow (need renderer-rehydration path).**

The DR-4 matrix row 4 (`{ neither profile nor sessionId } → subscribe to all sessions, observer mode`) is speculative — grep shows zero in-repo consumers of `observerMode`. Simplicity reviewer recommended cutting it.

But spec-flow reviewer surfaced three real needs the observer mode was implicitly satisfying:
1. **Renderer rehydration on daemon respawn** — when Electron reconnects to a respawned daemon, it needs to discover existing sessions.
2. **MCP cold-start discovery** — an agent attaching to a daemon with N existing sessions has no enumeration path.
3. **Error recovery** — when a client gets `E_UNKNOWN_SESSION` (stale state), it needs to re-sync.

All three are list-style discovery, not event-stream subscriptions. The cleaner answer:

**New `sessions/list` RPC** (no events, no subscription — just a snapshot):
```ts
// daemon RPC
sessions/list { } → { sessions: Array<{ sessionId, profileName, worktreeKey, status, services: SessionServicesStatus }> }
```

Plus new error payload for `E_SESSION_AMBIGUOUS`:
```ts
{ code: "E_SESSION_AMBIGUOUS", message: "...", data: { availableSessions: [{ sessionId, profileName }] } }
```

So the agent gets the list in the same round-trip and can retry with the right sessionId. Closes spec-flow gaps without the observer-mode complexity.

The four-cell `events/subscribe` matrix collapses to two cells (`boot-or-join` and `attach-by-id`), making the discriminated union in § A4 cleaner.

#### B3. DR-8 — augment with Promise-returning Builder, not replace

**Source:** performance finding #3, simplicity finding #8.

Both reviewers flagged that per-session Builder ownership alone doesn't fix the existing `.once("done")` cross-talk: `auto-build.ts:triggerBuildsIfNeeded` already fires iOS+Android concurrently against one Builder, and the listener-leak vector at [src/daemon/client-rpcs.ts:201](../../src/daemon/client-rpcs.ts) survives whether Builder is per-session or shared.

Update Builder API in addition to per-session ownership:
```ts
// src/core/builder.ts
interface BuildHandle {
  buildId: string;
  promise: Promise<BuildResult>;
  cancel(): void;
}
class Builder {
  build(opts: BuildOpts): BuildHandle { /* wraps .once("done") internally; rejects on concurrency-guard */ }
}
```

`client-rpcs.ts:201` no longer attaches `.once("done")` — it awaits the Promise. The leak vector at the API boundary disappears. Add to D3 as a sub-bullet.

Per-session Builder lifecycle still matters for **disposal**: when `stop(sessionId)` fires, kill any in-flight build subprocesses owned by that session's Builder (see also § F1 — simplicity reviewer's "hidden in-scope" addition about child-process cleanup).

#### B4. DR-9 — CUT for v1

**Source:** simplicity finding #1.

Grounded: all three shipped modules use `scope: "global"`. **Zero modules use `per-worktree`.** No candidate consumer for `per-session` exists in the repo. Adding the union value, the manifest-loader branch, the `boot.ts` scopeUnit branch, and the dedicated D4 test (`per-session-scope.test.ts`) is speculative work.

**Cut:**
- DR-9 from the decision register
- The `"per-session"` value from `ModuleScope` union ([packages/module-sdk/src/types.ts:5](../../packages/module-sdk/src/types.ts)) — leave the union unchanged
- `per-session` scopeUnit branch at [src/core/session/boot.ts:415](../../src/core/session/boot.ts)
- `src/core/module-host/__tests__/per-session-scope.test.ts` (line 374 of plan) — does not need to exist
- D4 reduces to verifying that existing `per-worktree` refcount handles multi-session consumer-sets correctly (cross-session-refcount.test.ts STAYS — see § F2)

**Document for module authors (not in-code change):** add to CLAUDE.md a sentence about per-worktree module state-bleed under multi-session. A `per-worktree` module sharing a subprocess across sessions sees both sessions' state through module-local variables. Architecture reviewer flagged this (#8); we accept the behavior and document it. Future module needing isolation can request a `per-session` scope at that time.

#### B5. Cut `E_SESSION_LIMIT_REACHED` daemon cap

**Source:** simplicity finding #3, performance finding #2 (raises concern but for a different reason).

The plan capped at 4 sessions in the renderer with `E_SESSION_LIMIT_REACHED`. Simplicity reviewer correctly identifies this as a UX affordance dressed as a daemon protocol error. Performance reviewer separately notes that 4 sessions × ~400-550 MB each ≈ 2 GB just for sessions is aggressive on 16 GB laptops.

Resolution:
- **Daemon side:** no enforced cap. `E_SESSION_LIMIT_REACHED` removed from the error-code union (§ A5). Daemon gates on `E_PORT_CONFLICT` and OS-level resources only.
- **Renderer side:** soft-disable the "+" button at 4 active sessions with a tooltip `"You have 4 sessions running. Close one before starting another."`. No IPC error path; the button just doesn't fire `instances:create`.
- **MCP side:** no equivalent gate. Power users / agents can spawn N>4 if their hardware can handle it.

If real-world dogfooding shows resource exhaustion at N>4, surface in a future hardening pass — but don't pre-emptively cap.

### C. New phases / phase splits

#### C1. Phase D0.5 — TypeScript foundation (inserts before D1)

Six sub-bullets, all from § A above. All in `src/daemon/`, `src/core/`, or new test-utility files. Should be one focused commit, ~150-300 lines new code + ~50 sites touched.

**Acceptance:** vitest baseline preserved, tsc clean, no behavior change visible to other clients yet. Branded types compile; narrowers exist; exhaustive switch refactor lands.

#### C2. Phase M expanded — M1 through M6

Old shape (M1 McpContext + M2 start-session + M3 probes) ships a renderer with multi-session capability and an MCP that can't drive it. New shape:

**M1: McpContext multi-session shell**
- Replace `McpContext.session` (singular) → `McpContext.sessions: Map<SessionId, DaemonSession>` at [src/mcp/server.ts:117-153](../../src/mcp/server.ts).
- Audit `src/mcp/tools.ts` and **tag every tool as session-scoped or global** (table below). Plan's "every tool's input schema gains sessionId?" is too coarse.

| Tool | Scope | Adds sessionId arg? |
|---|---|---|
| `rn-dev/list-profiles` | global | no |
| `rn-dev/list-worktrees` | global | no |
| `rn-dev/list-devices` | global | no |
| `rn-dev/preflight` | global | no |
| `rn-dev/run-lint` | global | no |
| `rn-dev/run-typecheck` | global | no |
| `rn-dev/list-sessions` | global | no (returns all sessions) |
| `rn-dev/start-session` | global | takes `profileName?` (M3) |
| `rn-dev/stop-session` | session-scoped | required (M4) |
| `rn-dev/build` | session-scoped | required |
| `rn-dev/reload` | session-scoped | required |
| `rn-dev/dev-menu` | session-scoped | required |
| `rn-dev/metro-status` | session-scoped | required |
| `rn-dev/build-status` | session-scoped | required |
| `rn-dev/session-logs` | session-scoped | required |
| `rn-dev/devtools-network/*` | session-scoped | required |
| `rn-dev/modules-config-*` | global today (modules are global-scope) | no for v1 |
| `rn-dev/audit-tail` | global with `sessionId?` filter (M5) | optional |

**M2: `rn-dev/list-sessions` multi-aware + `sessions/list` daemon RPC**
- New `sessions/list` daemon RPC (per § B2). Returns the snapshot used by both renderer rehydration and MCP discovery.
- Upgrade `rn-dev/list-sessions` MCP tool to return all sessions (today returns single-element array).
- Add `src/mcp/__tests__/list-sessions-multi.test.ts`.

**M3: `rn-dev/start-session` profileName arg + cold-start flow**
- Input schema gains `profileName?: string` — required when ZERO sessions OR no `ctx.profile` singleton. Otherwise falls back to `ctx.profile` for backward-compat with existing single-session bootstrap.
- Return shape `{ sessionId, status: "starting" }`.
- Document the cold-start flow in tool description: "If you see zero sessions in `rn-dev/list-sessions`, call this with `profileName` from `rn-dev/list-profiles`."
- Add `src/mcp/__tests__/start-session-multi.test.ts`.

**M4: `rn-dev/stop-session` sessionId + destructive gating**
- Input schema requires `sessionId` (per DR-2).
- Mark `destructiveHint: true` + add `permissionsAccepted: ["rn-dev/stop-session"]` schema (matches existing `modules-config-set` pattern at [src/mcp/tools.ts:1101-1123](../../src/mcp/tools.ts)).
- `E_SESSION_AMBIGUOUS` response includes `availableSessions` payload (per § B2).
- Add `src/mcp/__tests__/stop-session-multi.test.ts`.

**M5: `rn-dev/audit-tail` with sessionId filter**
- New tool. Read-only, no destructive flag.
- Input: `{ sessionId?: string; limit?: number; since?: number }`.
- Output: `{ entries: Array<AuditEntry> }`.
- Closes the parity gap from agent-native finding #8. Scope cut #10 ("no audit-log viewer UI") explicitly does NOT mean "no MCP readback" — those are separate parities.
- Add `src/mcp/__tests__/audit-tail.test.ts`.

**M6: PROBE multi-session probes**
- Originally M3 in old plan. Same content: `probe-real-build-mcp-multi.spec.ts`, `probe-real-devtools-mcp-multi.spec.ts`.
- Add a third probe: `probe-cold-start-mcp.spec.ts` — agent does the full discovery → list-profiles → start-session → list-sessions → stop-session flow without prior context.

**Phase M acceptance:** vitest ✓, tsc ✓, PROBE=1 multi-session probes green, every renderer action from E4 has a documented MCP counterpart in tool descriptions.

**NOT in Phase M (explicit scope cut):** `rn-dev/modules-install` MCP tool. This is a pre-existing gap (no install tool today regardless of multi-session), and per-session module install was cut with DR-9 (§ B4). Adding install-via-MCP belongs in a separate hardening plan — calling it out here so the gap is visible.

#### C3. Phase E sub-step elaborations

**E1.5: pendingSessions Map** — per § A8, mirror `pendingClientPromise` to serialize concurrent `instances:create`. ~20 lines new code, makes the race unrepresentable.

**E2.5: per-session ipcMain.handle hygiene** — per julik-frontend-races finding #4. Today `ipcMain.handle('prompt:respond:${promptId}', ...)` registers a unique channel per prompt and **never deregisters**. Two solutions, plan picks one:
- (preferred) Refactor to a single `ipcMain.handle('prompt:respond', ...)` route-by-promptId-in-payload.
- (alternative) Use `ipcMain.handleOnce` so the channel disposes on first response.

Without this, channel registry grows unboundedly across long dev sessions. Possible crash mode: two prompts at the same millisecond collide and `ipcMain.handle` throws.

**E3.5: Filter events in main process, not renderer**

**Source:** julik-frontend-races finding #5, performance finding #1 (same recommendation).

The plan as originally written sent every event to the renderer with sessionId in payload; the renderer filtered. At 4 sessions × ~620 ev/s aggregate, ~75% of IPC bandwidth is wasted on events the renderer drops. Cost is non-trivial (~125 KB/s of JSON.stringify + IPC traffic for dropped events).

Better: in `electron/ipc/index.ts`, the IPC bridge handler reads `state.activeSessionId` and `state.visibleSessions: Set<SessionId>`. Events for sessions not in the visible set are buffered into `SessionTabState.logBuffer` (capped ring buffer) in main-process memory only — no `webContents.send()` call. On tab switch, main process replays buffered tail via the existing `instances:getLogs` pathway at [electron/ipc/instance.ts:265-272](../../electron/ipc/instance.ts).

**E4 elaboration: per-tab `SessionContext` is required, not optional**

**Source:** performance finding #5, julik-frontend-races finding #10 (DevTools panel React.key).

Single-context React subscription over `state.sessions: Map` reconciles every tab's component tree on every event (~600 times/sec under burst at 4 sessions). Even at 0.5ms per shallow render that's ~300ms/sec of renderer CPU.

Required pattern:
```tsx
// renderer/contexts/SessionContext.tsx (NEW)
const SessionContext = React.createContext<SessionId | null>(null);
const SessionDataContext = React.createContext<SessionTabState | null>(null);

// In each tab's wrapper, useSyncExternalStore with a sessionId-keyed selector
function useSessionData(sessionId: SessionId): SessionTabState {
  return useSyncExternalStore(
    (cb) => subscribeSession(sessionId, cb),
    () => getSessionSnapshot(sessionId)
  );
}
```

DevTools panel keys on `sessionId` (not worktreeKey). Persist UI state (scroll, filter, paused breakpoints) into `SessionTabState.devtoolsUiState` so remount restores cleanly.

**E5 test additions:**
- Mount 4 sessions, fire 100 Metro log events at session B, assert session A's components do NOT re-render (use React Profiler API or a render-count spy).
- Mount 2 sessions, switch tabs, assert DevTools panel re-mounts (sessionId-keyed) but UI state restores from `devtoolsUiState`.

**E6.5: race-variant real-boot test**

**Source:** julik-frontend-races finding #9.

E6 as originally written creates sessions back-to-back without explicit waits — accidentally tests a race condition. Split into two tests:
1. **Happy serial path** (today's E6) — create A, wait for `running`, create B, wait for `running`, assert both.
2. **Concurrent race path** (NEW) — create A and B simultaneously, assert no ghost sessions, no listener leaks, lsof shows both ports bound to one daemon pid.

### D. Scope cuts revised

Original plan has 10 explicit scope cuts at lines 727-737. Revisions:

| # | Original | Revised |
|---|---|---|
| (existing) #1-#9 | Unchanged | Unchanged |
| #10 | "No audit-log viewer UI" | Stays for renderer; **`rn-dev/audit-tail` MCP tool added in M5** — audit data is accessible to agents |
| **NEW #11** | — | **No MCP `set-active-session`** — `activeSessionId` is renderer-only UX, not a daemon concept. (Per agent-native finding #4.) |
| **NEW #12** | — | **No `rn-dev/modules-install` MCP tool in v1** — pre-existing gap; per-session module scope cut means no new install-side parity requirement. Tracked separately. |
| **NEW #13** | — | **No cross-daemon session migration** — already in "Future Considerations" at line 805; promote to scope cuts for visibility. |
| **NEW #14** | — | **No daemon-enforced session cap** — per § B5. Renderer soft-disables `+` past 4; daemon trusts the caller. |
| **NEW #15** | — | **No agent-readable "currently active session" concept** — there isn't one. Every MCP call passes sessionId; no implicit default. (Per DR-2.) |

### E. Naming alignments

**E1. `SessionEntry` (server) vs `SessionRecord` (renderer) — rename renderer-side**

**Source:** pattern-recognition finding #2.

Plan introduces both names for distinct concepts (server-side owning wired services vs renderer-side projection holding DaemonSession). The names read as synonyms and obscure the layer boundary. Rename the renderer-side type:

| Original | Revised |
|---|---|
| `SessionEntry` (in `src/daemon/supervisor.ts`) | `SessionEntry` — KEEP |
| `SessionRecord` (in `electron/ipc/state.ts`) | **`SessionTabState`** |

`SessionTabState` correctly telegraphs "renderer tab state, not server state" and matches the existing `SessionState` (in `src/daemon/session.ts`) naming convention without colliding.

**E2. `E_INVALID_SUBSCRIBE_ARGS` → `E_SUBSCRIBE_INVALID_ARGS`**

**Source:** pattern-recognition finding #3.

The codebase already has `E_SUBSCRIBE_INVALID_KINDS` as a direct sibling. Naming pattern is `E_<NOUN>_<ADJECTIVE>`. Rename for consistency.

**E3. Standardize multi-session spec filenames**

**Source:** pattern-recognition finding #8.

Plan uses three different forms for the same concept (prefix `multi-`, suffix `-multi`, mid-string `multi-`). Standardize to **suffix `-multi`** across all new specs to match the existing `probe-real-build.spec.ts` → `probe-real-build-mcp-multi.spec.ts` sibling convention:

| Original (plan) | Revised |
|---|---|
| `multi-session-daemon.spec.ts` | `daemon-multi.spec.ts` |
| `multi-session-electron.spec.ts` | `electron-multi.spec.ts` |
| `supervisor-multi-session.test.ts` | `supervisor-multi.test.ts` |
| `metro-multi-session.test.ts` | `metro-multi.test.ts` |
| `devtools-multi-session.test.ts` | `devtools-multi.test.ts` |
| `service-bus-multi-session.test.ts` | `service-bus-multi.test.ts` |
| `start-flow-multi.test.ts` | unchanged |
| `fake-boot-multi.test.ts` | unchanged |
| `probe-real-build-mcp-multi.spec.ts` | unchanged |
| `probe-real-devtools-mcp-multi.spec.ts` | unchanged |

### F. Test coverage additions

Six new test scenarios surfaced by reviews. Each catches a real bug class identified above.

**F1. Mid-attach connection-drop** — architecture finding #2. Test: `events/subscribe { profile }` succeeds, connection drops between `start()` and first event, supervisor's `release(connId)` walks all sessions and finds the orphan, auto-teardown fires.

**F2. Crash-mid-acquire consumer-set release** — architecture finding #3. Test: session A acquires a `per-worktree` module, session A's SessionEntry is deleted (simulating crash), session B (same worktree, only remaining consumer) releases → subprocess shuts down. Without proper `stopEntry()` walking `acquiredModules`, the subprocess leaks.

**F3. Renderer no-rerender on sibling event burst** — performance finding #5. Test (renderer/jsdom): mount sessions A and B, fire 100 Metro log events at B, assert A's tab subtree did NOT re-render (React Profiler render-count spy).

**F4. X1 soak instrumentation** — performance finding #6. Sample RSS, listener counts, FD counts, subprocess counts every 30-60s during the 1h 2-session soak. Leak criteria: any positive slope after 10-min warmup window fails the gate.

**F5. Concurrent-attach race variant** — julik-frontend-races finding #9. Split E6 into serial (happy path) + concurrent (race) tests.

**F6. Cross-session DevTools frame-bleed** — julik-frontend-races finding #10. Real-boot test with two physical devices (or 1 phys + 1 sim). Capture network frames from both; assert session A's panel sees only session A's frames after a tab switch from B → A.

### G. Risk table additions

Append to existing Risk Analysis & Mitigation table:

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Single-context renderer reconciliation thrash at N=4 sessions | H | M | Per-tab `SessionContext` + `useSyncExternalStore` (§ C3 E4). Test F3 asserts isolation. |
| `disconnectLoggedFor` cross-session clobber silently swallows disconnect logs | M | H | Per-tab field in `SessionTabState` (§ A7). State machine guards re-entrant attach. |
| `instances:create` ghost-session leak from concurrent calls | M | H | `pendingSessions` Map (§ A8). Test F5 covers race. |
| Builder loop-starvation if any in-process Builder code blocks event loop > 10ms | L | H | Builder is subprocess-driven; add assertion in D3 that no in-process build code is synchronous. If false, surface as v1 risk. |
| Per-worktree module userland state bleed across sessions (silent) | M | M | Documented in CLAUDE.md (§ B4). Module authors choose explicitly; v1 ships without `per-session` scope. |
| Stale-tab `E_UNKNOWN_SESSION` after daemon respawn — renderer renders ghost tabs that 404 all IPC | M | M | On daemon disconnect, `state.sessions.clear()`, broadcast `sessionsCleared`. Renderer rehydrates via `sessions/list` RPC (§ B2) on reconnect. |
| `ipcMain.handle` channel registry growth across long dev sessions | L | M | Single `prompt:respond` channel routed by promptId in payload (§ C3 E2.5). |
| Audit log p99 append latency spike under concurrent boot (4 sessions × 15 entries in 200ms) | L | L | Measure in X1; target ≤ 50ms p99. If breached, per-session HMAC chain is v2 fix. |

### H. Lifecycle edge cases (spec-flow gaps to resolve in implementation)

Beyond the gaps converted into structural changes above, these specific edge cases need handling — they don't change the plan structure but each needs a one-line decision in the relevant phase:

1. **Click "+" while session A is `starting`** — allow concurrent boots (each has its own `bootInFlight`). Tab strip shows both `starting` badges. Destructive ops disabled per-tab while booting.
2. **First-session empty state (no sessions yet)** — dedicated empty-state component prompts "Create your first session" → opens profile picker (same modal as "+").
3. **Wizard creates new profile mid-session** — wizard completion stays quiescent. User explicitly clicks "+" to start the new profile. No auto-open.
4. **Tab order persistence across Electron restarts** — persist `[sessionId, order]` array to disk in Electron user-data dir. Reconcile against rehydrated session list (§ B2 `sessions/list`) on launch.
5. **Last-session-close behavior** — show empty state. Don't quit Electron. User may switch profiles.
6. **`E_PORT_CONFLICT` recovery in renderer** — modal: "Port 8081 in use by session 'iphone-physical'. Pick a different port:" with port-picker. Re-submits `instances:create`.
7. **TUI close-session affordance** — Ctrl-W on focused session = `instances:remove`. Inline yes/no prompt (memory `feedback_modal_over_inline_confirm.md` is renderer-scoped; TUI primitives differ).
8. **Daemon-shutdown clean path** — new `sessions/stopAll` RPC for clean Electron-quit. Closes all sessions, then daemon exits.
9. **`sessionsCleared` broadcast on daemon disconnect** — renderer empties `state.sessions`, sets `activeSessionId = null`, surfaces a non-modal banner "Daemon disconnected — reconnecting…". Auto-reattach via `sessions/list` on daemon reappearance.
10. **Observer-mode subscribers** (now CUT) — not a concept anymore. List-via-`sessions/list`, subscribe-via-explicit-sessionId. No diagnostic mode in v1.

### I. Phase decomposition consolidation

Simplicity reviewer flagged that 24 sub-phases for a 6-9 day estimate signals "phase-per-file" thinking. After this enhancement pass, the realistic phase count is:

| Phase | Purpose | Days |
|---|---|---|
| D0.5 | TypeScript foundation (§ C1) | 1 |
| D1 | Supervisor Map<sessionId, SessionEntry> | 1 |
| D2 | RPC envelopes + sessions/list + discriminated-union subscribe (D5 folded in) | 1 |
| D3 | Per-session services + Promise-returning Builder + composite-key refactor | 1.5 |
| D4 | Cross-session ModuleHost refcount (per-session scope CUT) | 0.5 |
| D7 | Real-boot daemon multi-session probe (D6 fake-boot folded as test fixture) | 0.5 |
| D8 | Flip singleton-pin test | 0.5 |
| M1-M6 | MCP multi-session (six sub-phases per § C2) | 2 |
| E1-E6.5 | Electron renderer with all race fixes | 2-3 |
| T1-T2 | TUI (single-session ok; gate is rejection + tests) | 0.5 |
| X1-X3 | Three-layer gate + memory + solutions doc (X4 was repo-policy, struck) | 0.5 |

**Total: 11-12 days focused.** Up from 6-9 because of the foundation work and the Phase M expansion — but the foundation prevents downstream rework.

### J. Sources

All findings above are from agent runs on 2026-05-12 against the plan + the codebase. Agent prompts available in conversation context; full transcripts archived at `/private/tmp/claude-502/.../tasks/`. Reviewer roster:

- spec-flow-analyzer — lifecycle edge cases + user-flow gaps + error-recovery flows
- architecture-strategist — boundary integrity + pattern compliance + decision-register stress-test
- performance-oracle — event fanout + memory footprint + reconciliation cost
- code-simplicity-reviewer — YAGNI + premature abstractions + phase consolidation
- kieran-typescript-reviewer — branded types + narrowers + exhaustive switch + ErrorCode union
- julik-frontend-races-reviewer — IPC races + module-scope state + DOM lifecycle
- pattern-recognition-specialist — naming consistency + filename conventions + Map-key patterns
- agent-native-reviewer — MCP/agent parity + tool inventory + cold-start flow

Conflicts between reviewers (e.g. simplicity wanted to cut observer-mode, spec-flow wanted the rehydration path observer-mode implicitly served) were resolved in favor of the cleaner explicit primitive — see § B2.

## Sources & References

### Origin

- **No origin brainstorm.** Plan derived from in-conversation analysis of:
  - User-reported gap in 2026-05-07 manual testing ("can't run 2 profiles at the same time")
  - [docs/plans/2026-04-24-module-system-phase-13-2-services-in-daemon-handoff.md:146-149](../../docs/plans/2026-04-24-module-system-phase-13-2-services-in-daemon-handoff.md) — the footnote being promoted.
  - [docs/plans/2026-05-07-next-session-prompt.md:29-30](../../docs/plans/2026-05-07-next-session-prompt.md) — the Electron-side "Phase 13.6+" tracker.
  - Comparison-brainstorm reference: [docs/brainstorms/2026-04-29-acme-dev-cli-research.md:144](../../docs/brainstorms/2026-04-29-acme-dev-cli-research.md) — notes the pain point from the rn-dev-cli-vs-acme gap analysis.

### Internal References (file:line)

**Daemon core:**
- [src/daemon/supervisor.ts:108-137](../../src/daemon/supervisor.ts) — singleton fields to lift
- [src/daemon/supervisor.ts:230-235](../../src/daemon/supervisor.ts) — `E_PROFILE_MISMATCH` site
- [src/daemon/supervisor.ts:292-298](../../src/daemon/supervisor.ts) — `E_SESSION_ALREADY_RUNNING` site
- [src/daemon/supervisor.ts:14-15](../../src/daemon/supervisor.ts) — "one daemon per worktree" invariant
- [src/daemon/session.ts:52-66](../../src/daemon/session.ts) — `SessionEvent` envelope (gains sessionId)
- [src/daemon/index.ts:428-482](../../src/daemon/index.ts) — `session/start` handler
- [src/daemon/index.ts:527-660](../../src/daemon/index.ts) — `events/subscribe` (canonical attacher)
- [src/daemon/index.ts:14-15](../../src/daemon/index.ts) — invariant comment
- [src/daemon/client-rpcs.ts:42-81](../../src/daemon/client-rpcs.ts) — `handleClientRpc` dispatcher
- [src/daemon/client-rpcs.ts:169-218](../../src/daemon/client-rpcs.ts) — `handleBuilderBuild` + the fragile `.once("done")` at :201
- [src/daemon/fake-boot.ts:107-284](../../src/daemon/fake-boot.ts) — fake-boot harness to make multi-session-aware

**Per-worktree services (already Map-keyed):**
- [src/core/metro.ts:62](../../src/core/metro.ts) — `instances: Map<string, MetroInstance>`
- [src/core/devtools.ts:112](../../src/core/devtools.ts) — `instances: Map<string, WorktreeState>`
- [src/core/builder.ts](../../src/core/builder.ts) — Builder (single class; becomes per-session instance)
- [src/core/module-host/manager.ts:170-285](../../src/core/module-host/manager.ts) — acquire/release refcount
- [src/core/module-host/manager.ts:579-581](../../src/core/module-host/manager.ts) — keyFor (gets `per-session` scope)
- [src/core/session/boot.ts:90, 246, 345-352, 373, 415, 496](../../src/core/session/boot.ts) — worktreeKey wiring

**App layer:**
- [src/app/service-bus.ts:17-56, 111](../../src/app/service-bus.ts) — global bus + topics
- [src/app/auto-build.ts:22-57](../../src/app/auto-build.ts) — intra-session fan-out (**PRESERVE**)
- [src/app/start-flow.ts:114, 175, 201, 218, 261](../../src/app/start-flow.ts) — TUI single-session assumptions

**MCP:**
- [src/mcp/server.ts:117-153, 209-224](../../src/mcp/server.ts) — single-session bootstrap
- [src/mcp/tools.ts:46-76, 215-244, 448-498](../../src/mcp/tools.ts) — McpContext + tools

**Electron:**
- [electron/ipc/state.ts:38-54](../../electron/ipc/state.ts) — singleton state
- [electron/ipc/instance.ts:174-191](../../electron/ipc/instance.ts) — explicit "Phase 13.6+" rejection (to remove)
- [electron/ipc/services.ts:251-281, 295-335](../../electron/ipc/services.ts) — attachDaemonSession + wireInstanceEvents
- [electron/ipc/index.ts:68-102, 104-110, 171-180, 287-290](../../electron/ipc/index.ts) — IPC bridge subscriptions

**Tests:**
- [src/daemon/__tests__/session-boot.test.ts:287-333](../../src/daemon/__tests__/session-boot.test.ts) — singleton-pin test (flip in D8)
- [renderer/components/__tests__/ModuleConfigForm.test.tsx:17-49](../../renderer/components/__tests__/ModuleConfigForm.test.tsx) — IPC stub pattern reference
- [tests/electron-smoke/smoke.spec.ts](../../tests/electron-smoke/smoke.spec.ts) — single-profile fixture
- [tests/electron-real-e2e/launch.ts:32-51, 103-126](../../tests/electron-real-e2e/launch.ts) — `extraProfiles` already supported
- [tests/electron-real-e2e/playwright.config.ts:21-23](../../tests/electron-real-e2e/playwright.config.ts) — workers:1 serialization

### Memory carryforward (constraints / prior context)

- [memory/real_boot_is_the_only_gate.md](../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/real_boot_is_the_only_gate.md) — real-boot is the merge gate; fake-boot proves wire shape only.
- [memory/feedback_test_parity_no_gaps.md](../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/feedback_test_parity_no_gaps.md) — never structure work as "accept the cross-client gap." All three clients ship multi-session.
- [memory/feedback_modal_over_inline_confirm.md](../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/feedback_modal_over_inline_confirm.md) — close-session modal must be a real modal (title + Cancel/Confirm + Esc).
- [memory/lsof_gotchas.md](../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/lsof_gotchas.md) — `-a` flag is load-bearing on macOS.
- [memory/single_branch_single_worktree.md](../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/single_branch_single_worktree.md) — all work lands on `main` in repo root; no claude/* branches, no worktrees.
- [memory/workflow_local_only_personal_account.md](../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/workflow_local_only_personal_account.md) — personal account stays local; no push, no PR.

### Related work / prior phases landed

- Phase 13.5 — daemon-services consolidation ([docs/plans/2026-04-25-module-system-phase-13-5-handoff.md](../../docs/plans/2026-04-25-module-system-phase-13-5-handoff.md))
- Phase H1+H2 — hook system ([docs/plans/2026-04-30-feat-hook-system-plan.md](../../docs/plans/2026-04-30-feat-hook-system-plan.md))
- Phase M1+M2 — MCP parity (see [memory/2026_05_07_mcp_parity_and_bug_bash.md](../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/2026_05_07_mcp_parity_and_bug_bash.md))
