# Phase M — MCP multi-session client complete (M1 → M6)

Consolidated walkthrough of the six phases landed in the 2026-05-14 session that closed out Phase M of the [multi-session daemon + Electron plan](../plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md). Follows the D5–D8 consolidated-solution style; filename date is +2 vs system date to match the existing forward-dated convention in `docs/solutions/`.

## State at start of session

- `main` at `91638d6` ("docs: Phase D complete — consolidated solution doc + Phase M/E handoff"), 16 commits ahead of origin (local-only).
- Phase D fully complete (D0.5 → D8). Phases M, E, T parallel-unblocked.
- 1426 vitest + 2 skipped + 4 tsc root baseline + clean electron tsc + 13/13 smoke + 4 REAL_BOOT skipped.

## State at end of session

- `main` at `7d14c0a` ("test(mcp): Phase M6 — PROBE multi-session real-boot probes"), **22 commits ahead of origin** (local-only).
- Phase M fully complete (M1 → M6 per the § C2 deepened plan). Phases E and T remain parallel-runnable.
- **1468 vitest + 6 skipped** (+42 net: +13 resolve-session + 5 list-sessions-multi + 7 start-session-multi + 8 stop-session-multi + 9 audit-tail + 4 PROBE skipped, -4 from the prior 1426 baseline holding via 1 metro-status test rewrite).
- 4 tsc root baseline preserved + clean electron tsc + 13/13 smoke + 4 REAL_BOOT skipped.
- **PROBE=1 multi-session verification: written but not run.** Three new probes (cold-start, build-multi, devtools-multi) are gated and ready. Manual gate is the next step.

## Architectural shift — McpContext.session → sessions: Map<SessionId, …>

Pre-M1, the MCP server held a singular `session: DaemonSession | null`. Single-session was wired end-to-end at the host level (Phase D delivered the daemon side), but MCP could only drive ONE of those sessions — there was no agent-native path to start a second one, route a tool call to a specific session, or even ask "which sessions exist?" for anything more than the single attached one.

The M1 promotion replaces that singleton with `sessions: Map<SessionId, McpSessionRecord>` plus a `defaultSessionId: SessionId | null` pointer. Each record carries `{ session: DaemonSession; profile: Profile }` — the profile is per-session because `rn-dev/build` reads platform / variant / scheme / configuration / port defaults from it.

The DR-2 contract enforced via `resolveSession(ctx, args)`:

```
sessions.size === 0                              → E_NO_SESSION
explicit sessionId not in map                    → E_UNKNOWN_SESSION + availableSessions[]
exactly one session, no sessionId in args        → auto-resolve to that session
>1 session, no sessionId in args                 → E_SESSION_AMBIGUOUS + availableSessions[]
explicit sessionId, in map                       → resolve to that session
```

A second helper, `resolveAnySession(ctx)`, picks the default (or any first entry) for daemon-global tools (`modules-config-*`, `modules-available`, `sessions/list`) that need any open daemon channel but don't add `sessionId` to their schema.

## M1 — McpContext multi-session shell (commit `e6c016d`)

### Shape change

```ts
export interface McpSessionRecord {
  session: DaemonSession;
  profile: Profile;
}

export interface McpContext {
  // … pre-M1 fields …
  sessions: Map<SessionId, McpSessionRecord>;
  defaultSessionId: SessionId | null;
  bootProfile?: Profile | null;        // replaces pre-M1 `profile?: Profile | null`
  attachSession?: (record) => void;    // wired by server.ts at boot; M3 dependency
}
```

### Per-tool audit per § C2 plan table

Eight session-scoped built-ins gain `sessionId?: string` via `withSessionIdProp` + route through `resolveSession`:

- `rn-dev/start-session` (M3 will extend with `profileName?`)
- `rn-dev/stop-session` (M4 adds destructive gating)
- `rn-dev/session-logs`
- `rn-dev/reload`
- `rn-dev/dev-menu`
- `rn-dev/metro-status` (no longer falls through to silent `{ status: "not-running" }` — returns `E_NO_SESSION`)
- `rn-dev/build`
- `rn-dev/build-status`

Module-proxied tools (`devtools-network__*`, `metro-logs__*`) take the same path through `buildProxyToolDefinition` — schema gets `sessionId` injected, handler routes through `resolveSession`. Module discovery uses `resolveAnySession` (the same modules surface across all sessions). The modules-event listener is wired to every attached session at boot.

The legacy untargeted fallbacks in `reload` / `dev-menu` (raw `adb shell input keyevent 82`, metro HTTP `/reload`) were dropped — in a multi-session world they would silently target whichever app the device was showing.

### Files touched (5 + 1 new)

- `src/mcp/tools.ts` (804 → 1136 LOC) — McpContext shape + resolveSession + resolveAnySession + withSessionIdProp + per-tool refactor
- `src/mcp/server.ts` — boot path builds the Map + wires per-session modules-event listener
- `src/mcp/module-proxy.ts` — schema injection + per-call sessionId routing
- `src/mcp/__tests__/tools.test.ts` — mock context helper accepts `session?` for back-compat + translates to Map shape
- `src/mcp/__tests__/module-proxy.test.ts` — same back-compat helper
- `src/mcp/__tests__/resolve-session.test.ts` (NEW, 13 tests) — pins the DR-2 contract independently of any tool

### Behavior change

- `rn-dev/metro-status` now returns `E_NO_SESSION` instead of `{ status: "not-running" }` when no session is attached.
- `rn-dev/reload` and `rn-dev/dev-menu` no longer fall back to `adb` / metro HTTP — they require an attached session and return `E_NO_SESSION` otherwise.

## M2 — list-sessions multi-aware (commit `c5a0aed`)

Upgrades `rn-dev/list-sessions` to wrap the daemon's `sessions/list` RPC (added in Phase D2 at `src/daemon/index.ts:681`) instead of `session/status`. Pre-M2 the tool returned a single-element array; post-M2 each entry carries `{ sessionId, profileName, worktreeKey, status, services }` straight from `supervisor.listSessions()`.

The tool routes via `resolveAnySession` since `sessions/list` is daemon-global. Defense-in-depth guard: malformed `sessions` field on the daemon reply degrades to an empty array.

### Files touched (1 + 1 new)

- `src/mcp/tools.ts` — list-sessions handler rewrite + outputSchema declaring per-entry shape
- `src/mcp/__tests__/list-sessions-multi.test.ts` (NEW, 5 tests) — mock daemon + snapshot pass-through + malformed-reply guard

The pre-existing `session-lifecycle-e2e.test.ts` stays green because `supervisor.stopSession` deletes the entry on clean stop, so `sessions/list` naturally returns `[]` after stop.

## M3 — start-session profileName + cold-start (commit `84e349d`)

Adds the cold-start + additional-attach mode. Three handler paths:

1. **`profileName` arg given**:
   - If a session for that profile is already attached, return `{ sessionId, status, alreadyAttached: true }` without opening a new socket.
   - Otherwise, load the profile from `ctx.profileStore`, call `connectToDaemonSession(projectRoot, profile, { kinds })` to boot-or-join via `events/subscribe { profile }`, then register the new session through `ctx.attachSession`.
   - **Concurrency edge** — boot-or-join can return an already-known sessionId (a separate client booted it). The handler detects the duplicate against `ctx.sessions`, calls `disconnect()` on the redundant socket, and returns `alreadyAttached: true` without growing the daemon's refcount.
   - Profile not on disk → `E_UNKNOWN_PROFILE`.

2. **`sessionId` given (or omitted with exactly one attached)**: M1 idempotent restart against the resolved session.

3. **Neither, zero sessions**: Fall back to `ctx.bootProfile`, preserving the existing single-profile bootstrap.

### Files touched (2 + 1 new)

- `src/mcp/tools.ts` — start-session handler rewrite + outputSchema + import of `connectToDaemonSession`
- `src/mcp/server.ts` — wires `ctx.attachSession` (adds to Map, points defaultSessionId if unset, subscribes modules-event, calls refreshModuleTools)
- `src/mcp/__tests__/start-session-multi.test.ts` (NEW, 7 tests) — covers all three paths via `vi.mock('../../app/client/session.js')`

The `attachSession` callback is the seam between the tool layer and server boot. The tool refuses to call `connectToDaemonSession` when this callback is missing (`E_NOT_WIRED`) so a unit-test context can't silently leak a new socket.

## M4 — stop-session destructive gating (commit `6ca4c3f`)

Pattern matches the existing `modules-config-set` destructive gating at `tools.ts:1101-1123`. Two ways to bypass:

- Per-call: `permissionsAccepted: ["rn-dev/stop-session"]` in the args.
- Global: `--allow-destructive-tools` flag.

Without one, the handler returns `{ isError: true, code: "E_DESTRUCTIVE_REQUIRES_CONFIRM" }` and does NOT send `session/stop` — same shape an agent sees on misuse of `modules-config-set`, which is the parity goal.

sessionId routing was already enforced via `resolveSession` in M1 (`E_SESSION_AMBIGUOUS` with `availableSessions` at N > 1). M4 makes the contract explicit in the tool description + adds the `permissionsAccepted` property to the input schema + adds an outputSchema.

### Files touched (1 + 1 new + 1 updated)

- `src/mcp/tools.ts` — stop-session handler + schema
- `src/mcp/__tests__/stop-session-multi.test.ts` (NEW, 8 tests) — destructive gate refuses; flag bypasses; sessionId routing; schema declares permissionsAccepted
- `src/mcp/__tests__/session-lifecycle-e2e.test.ts` — existing e2e stop-session call now passes `permissionsAccepted` (models what production agents must do)

## M5 — rn-dev/audit-tail readback tool (commit `79455a9`)

Closes the parity gap from agent-native finding #8. Pre-M5 the audit log (`~/.rn-dev/audit.log`) was append-only with no read surface; agents calling destructive tools couldn't confirm the audit record landed.

The tool is read-only — no destructive flag. Input: `{ limit?, since?, kind?, sessionId? }`. Output: `{ entries, path }`.

Filters:
- `kind` — exact match against `AuditEntry.kind` (install / uninstall / host-call / config-set / panel-bridge / hook)
- `since` — strict `ts > since` (epoch ms)
- `sessionId` — forward-compat; v1 audit entries don't carry sessionId so this filter returns `[]` until session-scoped audit kinds land. Documented as such.
- `limit` — default 50, capped at 200 client-side

The helper `readAuditTail` mirrors `readHookAuditTail` in `tools-hooks.ts` — newest-line-first walk with chronological reverse on return. Missing audit log file → empty array; malformed JSON lines silently skipped.

### Files touched (1 + 1 new + 1 updated)

- `src/mcp/tools.ts` — audit-tail tool + `readAuditTail` helper + `os/homedir` + `fs/readFileSync` imports
- `src/mcp/__tests__/audit-tail.test.ts` (NEW, 9 tests) — missing file, kind filter, since filter, sessionId forward-compat, malformed-line skip, limit cap
- `src/mcp/__tests__/tools.test.ts` — tool-count assertion updated from 34 → 35

### Explicitly NOT in M5

- **Daemon-mediated audit reads.** Direct file read is fine for v1 since the audit log is at a stable local path and the read is non-mutating. A future hardening pass might route through a daemon RPC if audit-policy hooks land.
- **HMAC chain verification on read.** That's `AuditLog.verify()` — a separate concern. Agents reading the tail get raw entries; corruption surfaces when the chain is verified, not at tail time.

## M6 — PROBE multi-session probes (commit `7d14c0a`)

Three new PROBE=1 gated specs against acme + iPhone. They skip cleanly when PROBE is unset so the regular vitest gate stays under 25s.

### `probe-cold-start-mcp.spec.ts`

Walks the full discovery flow an agent does with zero prior context: `list-profiles` → `list-sessions` → `start-session { profileName }` → `list-sessions` → `stop-session` (with consent). Pins the destructive gate on `stop-session` as a second `it` so we catch regressions on the consent path.

### `probe-real-build-mcp-multi.spec.ts`

Writes two throwaway profiles (`rn-dev-probe-mcp-multi-{a,b}`) on different metroPorts (8099, 8100), boots a session for each through the M3 profileName flow, fires `rn-dev/build` on both in parallel, and polls `rn-dev/build-status` with sessionId-routing. Asserts:

1. Both sessions surface in `rn-dev/list-sessions`.
2. `resolveSession`'s `E_SESSION_AMBIGUOUS` path fires when an agent forgets sessionId once N > 1.
3. Each session's builder ring is independent — events in A's ring that aren't in B's, and vice versa, prove the per-session BuilderClient isolation from Phase D3.

### `probe-real-devtools-mcp-multi.spec.ts`

Two parallel sessions, then `devtools-network__status` on each. Pins:

1. The module-proxy's `withSessionIdProp` schema injection — agents reading `tools/list` see `sessionId` in `devtools-network__status`'s inputSchema (so they know it's session-scoped).
2. The two sessions' proxies have distinct proxyPorts — proves the module subprocess bookkeeping is per-session, not shared.
3. Calling without `sessionId` at N > 1 surfaces `E_SESSION_AMBIGUOUS` via the module-proxy path too.

### Manual run procedure (NOT executed in this session)

```bash
PROBE=1 npx vitest run \
  src/mcp/__tests__/probe-cold-start-mcp.spec.ts \
  src/mcp/__tests__/probe-real-build-mcp-multi.spec.ts \
  src/mcp/__tests__/probe-real-devtools-mcp-multi.spec.ts
```

The build-multi probe has a 20-minute timeout; running all three against the iPhone takes ~15-30 minutes wall-clock. Cert chain for iPhone deployment must be current.

## Gate at end of session

- vitest: **1468 pass + 6 skipped** (1426 D-baseline + 13 resolve-session + 5 list-sessions-multi + 7 start-session-multi + 8 stop-session-multi + 9 audit-tail = 1468; 2 prior skipped + 4 new PROBE skipped = 6)
- tsc root: 4 baseline preserved (`App.tsx` + `AppContext.tsx` + `host-capability.test.ts` + `validated-profile-brand.test.ts`)
- tsc electron: clean
- playwright smoke: 13 pass + 4 REAL_BOOT skipped
- One known flake in full-suite vitest: `daemon/__tests__/registry.test.ts > findActiveDaemons surfaces a live daemon and skips a stale entry` — passes in isolation, sporadic failure under full-suite parallel load. Pre-existing, unrelated to MCP. Tracked but not blocking.

## What's next

- **Manual PROBE=1 run** against acme + iPhone to lock M6 acceptance.
- **Phase E** — Electron renderer multi-session (E1: `state.daemonSession` singleton → Map; through E6: real-boot multi-session). Largest remaining scope, most user-visible.
- **Phase T** — TUI multi-session (smallest user-facing impact; can defer).
- **X1-X3** — cross-cutting plan items still open per the multi-session plan.

## Commits

```
7d14c0a test(mcp): Phase M6 — PROBE multi-session real-boot probes
79455a9 feat(mcp): Phase M5 — rn-dev/audit-tail readback tool
6ca4c3f feat(mcp): Phase M4 — rn-dev/stop-session destructive + sessionId
84e349d feat(mcp): Phase M3 — rn-dev/start-session accepts profileName
c5a0aed feat(mcp): Phase M2 — rn-dev/list-sessions queries sessions/list
e6c016d feat(mcp): Phase M1 — McpContext sessions Map + per-tool sessionId
```
