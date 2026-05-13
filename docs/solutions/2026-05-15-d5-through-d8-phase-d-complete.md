# Phase D — daemon multi-session arc complete (D5 → D8)

Consolidated walkthrough of the four phases landed in the 2026-05-13 session that closed out Phase D of the [multi-session daemon plan](../plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md). Follows the D2/D3/D4 solution-doc style; filename date is +2 vs system date to match the existing forward-dated convention in `docs/solutions/`.

## State at start of session

- `main` at `67667db` ("docs(plan): Phase D5 next-session handoff"), 11 commits ahead of origin (local-only).
- Phase D0.5 → D4 landed. ModuleHost refcount + release walk verified at unit + integration-real-process layers.
- 1420 vitest + 4 tsc root baseline + clean electron tsc + 13/13 smoke.

## State at end of session

- `main` at `6a2a368` ("feat(daemon): Phase D8 — lift session/start singleton gate"), **15 commits ahead of origin** (local-only).
- Phase D fully complete (D0.5 → D8). Phases M, E, T can light up in parallel; depend only on D6.
- **1426 vitest** (+6 net: +4 D5 + 1 D6 + 2 D8 new specs - 1 D8 deleted singleton-pin) + 4 tsc root baseline + clean electron tsc + 13/13 smoke + 4 skipped REAL_BOOT.

## D5 — ServiceBus per-session payloads (`cb09e25`)

### Shape change

Every `ServiceBus` event payload now carries `sessionId`. The bus stays a flat `EventEmitter` (per-session Maps live on the supervisor side). Two carrier shapes:

- **Required SessionId** for per-session topics: `metro`, `builder`, `watcher`, `worktreeKey`, `devtools`.
- **`SessionId | null`** for cross-session topics: `log` (cold-spawn errors fire pre-session), `modulesClient` (disconnect clears with null), `modulesClientAborted` (no-default-profile fires pre-session).

### Files touched (9 + 1 new)

- `src/app/service-bus.ts` (111 → 156 LOC) — payload type widening + setter signature changes
- Producers: `src/app/start-flow.ts:262-272`, `electron/daemon-connect.ts:113-123` thread `session.sessionId` / `ready.sessionId` through every setter
- Subscribers: `src/app/AppContext.tsx`, `electron/ipc/{metro,devtools,tools,index}.ts` destructure the new shape
- Tests: new `src/app/__tests__/service-bus-multi-session.test.ts` (4 cases — sessionId carriage, filter-by-sessionId, log pre-session null tag); updated `electron/__tests__/daemon-connect.test.ts` asserts sessionId on every topic

### Behavior change

None in v1. Single-session TUI ignores sessionId; D6/D7 light up filtering. This is shape only.

## D6 — fake-boot multi-session test (`5f99853`)

### What it pins

`src/daemon/__tests__/fake-boot-multi.test.ts` — two concurrent fake-boots on ports 8081/8082 against one daemon; both reach `metro/status: "running"` specifically (not just any `kind: "metro/status"` event); every fanned event sessionId-tagged in `{sidA, sidB}`.

### Gap vs adjacent coverage

`sessions-list.test.ts` and `session-events-envelope.test.ts` already proved concurrent sessions appear in the list and carry distinct sessionIds. Neither pinned the `data.status === "running"` payload — they accepted any `metro/status` envelope, including `"starting"`. A regression that wires "starting" but drops "running" passes those tests while breaking the renderer's session-ready gate. D6 closes that.

## D7 — real-boot multi-session probe (`858a123`)

### What it proves (when run)

`tests/electron-real-e2e/multi-session-daemon.spec.ts`, gated by `REAL_BOOT_SMOKE=1`. Spawns Electron at acme-mobile-app, lets it boot session A (default profile, port 8090) via `startRealServices`, then test-process opens a second `IpcClient` against `<acme>/.rn-dev/sock` and calls `events/subscribe` with profile B (port 8091).

Asserts (in this order):
1. Both reach `metro/status: "running"` against **real Metro** within 120s.
2. `lsof -aP -i :PORT_X -sTCP:LISTEN -t` on each port traces ancestry (up to 4 ps levels) to the daemon pid recorded at `<acme>/.rn-dev/pid` — one daemon, two real Metros.
3. `sessions/list` reports both with distinct sessionIds and profileNames.
4. `session/stop { sessionId: sidB }` — session A's port stays bound, session B's port reaps, Electron renderer still responds to `page.evaluate(() => 1 + 1)`.
5. After `teardownRealE2e`, `pgrep -af "src/index.tsx daemon"` filtered by `projectRoot` returns zero.

### Test status

Both specs **skip cleanly** without `REAL_BOOT_SMOKE=1`. With the flag set against a present acme-mobile-app tree, this is the multi-session arc's merge gate. Not run in this session (gated, requires manual opt-in per [[real-boot-is-the-only-gate]]).

### Parked from D7

- **D4 release walk under a real 3p module subprocess** — already covered at the vitest layer (`supervisor-module-cleanup-real-subprocess.test.ts`); promoting to real-boot needs a curated 3p module on disk. Out of scope for this session.

## D8 — Lift session/start singleton gate (`6a2a368`)

### Production change

`src/daemon/index.ts:486-507` — drop the `activeSessions.length > 0 → E_SESSION_ALREADY_RUNNING` gate. The handler now mints a sessionId via `generateSessionId()` and delegates to `supervisor.startSession`. The supervisor's pre-existing `Map<SessionId, …>` enforces `E_SESSION_ALREADY_EXISTS` (sessionId clash) and `E_PORT_CONFLICT` (metroPort clash).

### Test changes

`src/daemon/__tests__/session-boot.test.ts:281-327` — invert the singleton-pin:

| Old assertion (deleted) | New assertions (two specs) |
|---|---|
| "second session/start → `E_SESSION_ALREADY_RUNNING`" | "distinct profiles + distinct ports → BOTH succeed; sessions/list reports both" |
|   | "distinct profiles + colliding metroPort → `E_PORT_CONFLICT`" |

The "same sessionId → `E_SESSION_ALREADY_EXISTS`" case stays at the supervisor unit layer (`supervisor-multi.test.ts:176`) because the RPC auto-mints. See [[code-fact-session-start-auto-mints-id]].

### Dead-code removal

`E_SESSION_ALREADY_RUNNING` removed from the `SessionErrorCode` union in `src/daemon/error-codes.ts` — no production emit sites remain. The error-codes.test.ts type-assertion on it was dropped. Per the project's no-back-compat-hack rule.

## Lessons / non-obvious bits

1. **Some plan deliverables are gap closures, not new scenarios.** D6 looked like a full fresh test on paper, but adjacent tests already had ~80% of the wire-shape coverage. The valuable bit was a single status-payload assertion the existing tests missed. Worth checking adjacency before treating any plan-stated "NEW test" as a clean-slate exercise.
2. **The session/start RPC's sessionId auto-mint constrains test coverage.** `E_SESSION_ALREADY_EXISTS` is unreachable from the wire layer — the test has to drop to supervisor unit. Recorded as [[code-fact-session-start-auto-mints-id]] so future multi-session work doesn't lose that.
3. **The handoff brief's "exercise D4 release walk under real 3p subprocess" wasn't actually buildable in D7.** No bundled built-in exercises the per-worktree refcount path ([[code-fact-module-host-per-session]]). Promoting from vitest to real-boot needs a curated 3p module on disk. Parked as a separate follow-up rather than inflating D7.

## Memory + next-session pointers

- [[phase-d-complete]] — this entire batch, gate state, parked items, supersedes [[phase-d4-complete]].
- [[code-fact-session-start-auto-mints-id]] — D8 surfaced this; useful for Phase M and Phase E test design.
- Next-session brief: [docs/plans/2026-05-13-next-session-prompt-phase-m-or-e.md](../plans/2026-05-13-next-session-prompt-phase-m-or-e.md).
