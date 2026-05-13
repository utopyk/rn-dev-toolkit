# Next session — handoff (2026-05-13) — Phase D complete; pick Phase M or Phase E

**State:** `main` at commit `6a2a368` ("feat(daemon): Phase D8 — lift session/start singleton gate"), **15 commits ahead of origin** (D0.5 + D1 + D1 docs + D2 + D2 docs + D3 + D3 docs + D4 + D4 integration + D4 docs + D5 + D6 + D7 + D8 + this brief to land). Local-only per [memory/workflow_local_only_personal_account.md](../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/workflow_local_only_personal_account.md) — do not push.

**Gate at handoff:**
- vitest: 1426 passed, 2 skipped (1420 D4 baseline + 4 D5 + 1 D6 + 2 D8 - 1 deleted D8 singleton-pin)
- tsc root: 4 baseline preserved (App.tsx + AppContext.tsx + host-capability.test.ts + validated-profile-brand.test.ts)
- tsc electron: clean
- playwright smoke: 13/13 + 4 REAL_BOOT skipped
- D7 (`tests/electron-real-e2e/multi-session-daemon.spec.ts`) skipped cleanly without REAL_BOOT_SMOKE; the multi-session merge gate is run-on-demand against acme

**Predecessors:**
- Plan: [docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md](2026-05-12-feat-multi-session-daemon-and-electron-plan.md)
- Consolidated D5-D8 solution: [docs/solutions/2026-05-15-d5-through-d8-phase-d-complete.md](../solutions/2026-05-15-d5-through-d8-phase-d-complete.md)
- D4 solution: [docs/solutions/2026-05-15-d4-cross-session-modulehost-refcount.md](../solutions/2026-05-15-d4-cross-session-modulehost-refcount.md)

---

## What Phase D delivered

The daemon side of multi-session is fully landed. The supervisor multiplexes sessions via `Map<SessionId, SessionEntry>`; every RPC envelope carries `sessionId`; every per-session service (Metro, DevTools, Builder) keys off `SessionId`; cross-session ModuleHost cleanup walks the per-session `acquiredModules` array; the `session/start` singleton gate is gone; the wire contract is pinned at fast / integration / real-boot layers.

**Phase D acceptance gate**, per plan § Implementation Phases:
- vitest ✓ (with all new specs)
- tsc root ✓ (4 baseline preserved)
- tsc electron ✓ (clean)
- D7 real-boot probe written; gated by REAL_BOOT_SMOKE=1, ready for manual probe against acme
- No daemon leaks after `pkill` sweep at session end

## What's next — Phase M (MCP) or Phase E (Electron renderer)

Phases M, E, T are **parallel-runnable** — they all depend only on D6 (done). Phase M is the smallest unblock; Phase E is the largest and most user-visible.

### Phase M — MCP multi-session client (3 sub-phases, ~1.5 days)

**Files (per plan § M):**
- `src/mcp/server.ts:117-153` — `McpContext.session` (singular) → `McpContext.sessions: Map<sessionId, DaemonSession>` + `McpContext.defaultSessionId?: string`
- `src/mcp/tools.ts:46-76` — every tool's input schema gains `sessionId?: string` (DR-2: required when >1 session exists, optional when exactly one)
- `src/mcp/tools.ts:215-244` — `rn-dev/start-session` returns `{ sessionId, status }`; agent passes sessionId back into subsequent `rn-dev/build`, `rn-dev/devtools-network/capture`, etc.
- `src/mcp/__tests__/probe-real-build-mcp-multi.spec.ts` (NEW, PROBE=1) — two parallel builds via MCP
- `src/mcp/__tests__/probe-real-devtools-mcp-multi.spec.ts` (NEW, PROBE=1) — devtools-network captures across two sessions

**Why M first:** Smallest delta. The MCP server already has the single-session client primitive (`DaemonSession`); promoting `.session` → `.sessions: Map<…>` is mechanical. Probe specs follow the existing `tests/electron-real-e2e/probe-real-build.spec.ts` shape but go through MCP. Closes test parity at the MCP layer per [memory/feedback_test_parity_no_gaps.md](../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/feedback_test_parity_no_gaps.md).

### Phase E — Electron renderer multi-session UI (6 sub-phases, ~3-4 days, **largest**)

**Files (per plan § E):**
- `electron/ipc/state.ts:38-54` — `daemonSession`, `daemonSessionProfileName`, `activeInstanceId` → `Map<SessionId, …>` + `activeSessionId`
- `electron/ipc/*` — every handler threads sessionId
- `electron/main.ts` + `electron/ipc/services.ts::attachDaemonSession` — N concurrent attach paths
- `renderer/views/App.tsx` + tab strip + new-instance dialog — multi-tab UI
- `tests/electron-smoke/` + `tests/electron-real-e2e/` — multi-session smoke + real-boot

**Why E later:** Largest scope and most user-visible — the renderer's tab/session model lights up here. Depends on a stable daemon side, which Phase D delivered. Worth doing M first to ship the MCP wins quickly and surface any wire-contract gaps before E commits to N-tab rendering.

### Phase T — TUI multi-session (2 sub-phases, can be deferred)

Smallest user-facing impact (TUI is single-session today and not the primary surface). Defer until M + E are landed.

---

## Recommended slice

**Phase M end-to-end** (M1 + M2 + M3) — ~1.5 days. Self-contained, lights up the MCP probe matrix, validates Phase D's wire contract from a second client type, and unblocks M's row in the test-parity table.

**Fallback if M isn't on the table:** Start Phase E with **E1 only** (`state.ts` singleton → Map). One commit, mechanical, unblocks E2+ in subsequent sessions.

---

## Before starting (any phase)

```bash
pkill -9 -f "src/index.tsx daemon"
lsof -aP -i :8081 -sTCP:LISTEN -t | xargs -r kill -9
lsof -aP -i :8082 -sTCP:LISTEN -t | xargs -r kill -9
```

**Verify gate baseline holds:**
- `npx vitest run` — expect 1426 + 2 skipped
- `npx tsc --noEmit 2>&1 | grep -v "src/ui/" | grep "error TS" | wc -l` — expect 4
- `npx tsc --noEmit -p electron/tsconfig.json` — clean
- `npm run test:smoke` — 13/13 + 4 skipped

---

## Parked items

- **D7's "release walk under real 3p module subprocess"** — already covered at vitest (`supervisor-module-cleanup-real-subprocess.test.ts`). Promoting to real-boot needs a curated 3p module installed on disk. Tracked as separate follow-up — don't roll into Phase M or E unless a 3p module shows up.
- **Pre-existing smoke-suite daemon leaks.** D7's own teardown asserts no-leak. Smoke (`tests/electron-smoke/`) still leaks per the superseded "0 leaks across full gate" claim in [memory/middle_phase_complete.md](../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/middle_phase_complete.md). Retrofit deferred.
- **D-phase solution-doc filenames in `docs/solutions/` are forward-dated** (D2/D3/D4/D5-D8 use 2026-05-13/14/15 while system date oscillates around 2026-05-13). Matches the existing convention; rename if inconsistency bothers you.

---

## Constraints carried forward

- **Single branch (`main`), single worktree (repo root).** Per [memory/single_branch_single_worktree.md](../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/single_branch_single_worktree.md).
- **Local-only on this account.** No push, no PR, no review chain. Per [memory/workflow_local_only_personal_account.md](../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/workflow_local_only_personal_account.md).
- **No `any` / `unknown`** in production code (one documented escape hatch in `src/app/service-bus.ts`).
- **Conventional Commits.** Examples: `feat(mcp): Phase M1 — McpContext sessions Map`, `feat(electron): Phase E1 — state.daemonSession → Map`.
- **Imports use `.js` extension** (ESM NodeNext rule).
- **Test parity:** per [memory/feedback_test_parity_no_gaps.md](../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/feedback_test_parity_no_gaps.md), every client (TUI, Electron, MCP) gets three test layers. M3 + E5 cover their layers; T2 closes the TUI side.

## Session-start prompt (copy-paste)

```
Pick up at: Phase M (MCP multi-session) or Phase E1 (Electron renderer state.ts → Map).
Brief at docs/plans/2026-05-13-next-session-prompt-phase-m-or-e.md.
Repo: /Users/martincouso/Downloads/rn-dev-cli, branch main @ 6a2a368, 15 commits ahead of origin (local-only, do not push).

Phase D is fully complete (commits 7c9f7a2 → 6a2a368). The daemon multiplexes sessions
via Map<SessionId, …>; every RPC envelope carries sessionId; ServiceBus payloads
are per-session; session/start singleton gate is gone; D7 real-boot probe is
REAL_BOOT_SMOKE-gated and ready.

Before starting:
- pkill -9 -f "src/index.tsx daemon"; lsof -aP -i :8081 -sTCP:LISTEN -t | xargs -r kill -9; lsof -aP -i :8082 -sTCP:LISTEN -t | xargs -r kill -9
- Confirm gate: npx vitest run (1426 + 2 skipped), npx tsc --noEmit 2>&1 | grep -v "src/ui/" | grep "error TS" | wc -l (4), npx tsc --noEmit -p electron/tsconfig.json (clean), npm run test:smoke (13/13 + 4 skipped)
- Read the brief end-to-end before touching code

Highest-leverage next slice: Phase M end-to-end (M1+M2+M3) — ~1.5 days, lights up
MCP multi-session client + PROBE=1 probes. Self-contained; validates Phase D from
a second client type. Closes test parity at the MCP layer.

Fallback (if M isn't on the table): Phase E1 alone — state.daemonSession singleton
→ Map at electron/ipc/state.ts:38-54. ~half-day, mechanical, unblocks E2+.

Parked:
- D7 release-walk-under-real-3p-module follow-up — needs a curated 3p module
- Pre-existing smoke-suite daemon leaks (out of D7's scope)
```
