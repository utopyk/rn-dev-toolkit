# Phase M Modules-Listener Fix — Session Handoff (2026-05-15)

## What landed

- `48fde5b` fix(daemon,mcp): per-session modules listener filters by payload.sessionId
- `832152a` fix(mcp): wrap stop-session + list-sessions returns in structuredContent

**Total: 2 commits, 30 commits ahead of origin (local-only per [memory/workflow_local_only_personal_account.md](../../../../.claude/projects/-Users-martincouso-Downloads-rn-dev-cli/memory/workflow_local_only_personal_account.md)).**

## Root cause

The Phase M blocker from 2026-05-14 (`probe-real-devtools-mcp-multi` returning the same `proxyPort` for both sessions) was NOT subprocess sharing. It was the same shape of wire-contract gap that `c464d4d` fixed for builder/metro, but on the modules path.

The daemon shares ONE `IpcServer` (`src/daemon/index.ts:205`). Each per-session `registerModulesIpc` call attaches its own `ipc.on("message")` listener. Node's `EventEmitter` has no stop-propagation, so when a `modules/*` RPC arrives, ALL N listeners fire. Pre-fix, no listener filtered by sessionId — each one dispatched against its own `ModuleHostManager` and called `event.reply()`. The first reply over the socket wins, so the first-registered session (always session A) responded regardless of which sessionId the client targeted.

Subprocesses ARE per-session. Each session has its own `ModuleHostManager` with its own `devtools-network` subprocess listening on its own ephemeral port. The collision wasn't shared state at the OS level — it was the listener race surfacing session A's port for queries targeting session B.

## Fix

**Two-part wire-contract fix mirroring `c464d4d`:**

1. **MCP module-proxy** (`src/mcp/module-proxy.ts:113-121`) — thread `sessionId: resolved.sessionId` into the `modules/call` payload so the daemon has something to route on.

2. **registerModulesIpc** (`src/app/modules-ipc.ts:1122-1165`) — accept a `sessionId` option in `ModulesIpcOptions`. In the listener, after the subscribe-socket guard and BEFORE dispatch, bail when `payload.sessionId` is present and does not match this session's id. Threaded through `bootSessionServices` + `fakeBootSessionServices`.

Single-session and sessionId-less callers (TUI, Electron renderer pre-Phase-E) are back-compat because they fall through to the existing all-listeners-dispatch behavior, which is harmless when only ONE listener is registered.

## Drive-by fix

`probe-real-devtools-mcp-multi` teardown surfaced a separate latent bug: `rn-dev/stop-session` and `rn-dev/list-sessions` declare `outputSchema` but their happy-path returns were bare objects. The MCP SDK client rejects this with `Tool X has an output schema but did not return structured content`. Wrapped both as `{ structuredContent: ... }`. Unit tests updated to assert against the new shape.

The pre-existing cold-start + build-multi probes both call `stop-session` and were green before — they got lucky with the assertion order. See [[code-fact-mcp-outputschema-requires-structured]].

## Verification

**PROBE=1 against acme + iPhone `00008130-001A653A3E11001C` (2026-05-15):**

| Probe | Status | Duration | Notes |
|---|---|---|---|
| `probe-cold-start-mcp` | ✅ PASS (2/2) | 9.5s | |
| `probe-real-build-mcp-multi` | ✅ PASS | 3m17s | Both sessions ack {ok:true}, BuilderClient rings independent |
| `probe-real-devtools-mcp-multi` | ✅ PASS | 7.7s | Sessions A + B return distinct proxyPort (54454 vs 54464) |

**Standard gate:**
```bash
npx vitest run                                                        # 1468 pass + 6 skipped (0 fail)
npx tsc --noEmit 2>&1 | grep -v "src/ui/" | grep "error TS" | wc -l    # 4 baseline
npx tsc --noEmit -p electron/tsconfig.json                             # clean
npm run test:smoke                                                     # 13 pass + 4 skipped (33.8s)
```

Pre-existing flake: `src/daemon/__tests__/session-events-envelope.test.ts > events from concurrent sessions are sessionId-tagged` fails sporadically under full-suite vitest parallel load, passes in isolation. Unrelated to this fix.

## Decisions made

- **Filter at the listener, not at the dispatcher.** Per-session listener filtering keeps the change scoped to `registerModulesIpc` and avoids a larger refactor that would hoist modules dispatch out of `bootSessionServices`. The dispatcher-level alternative (one global listener that consults `supervisor.getSession(sessionId)`) is structurally cleaner but ~5x the diff. The listener filter is sufficient because each session's manager is the authoritative state owner.
- **Optional sessionId on `ModulesIpcOptions`.** Unit tests + fake-boot may exercise the dispatcher without a sessionId; the filter is a no-op when sessionId is undefined. Production `bootSessionServices` + `fakeBootSessionServices` always pass it.
- **Drive-by wrap stop-session + list-sessions instead of routing the bug to a follow-up.** Both call sites were in the immediate probe path; leaving them bare would have meant the devtools-multi probe couldn't complete its teardown. Other tools with `outputSchema` may have the same defect but are not currently exercised by a green probe — leave those for next session's audit.

## Parked / known issues

- **TUI's existing adapters (`builder-adapter.ts`, `metro-adapter.ts`, `devtools-adapter.ts`) don't thread sessionId in their RPC payloads.** Pre-existing, fine today because TUI is single-session and the daemon's back-compat fallback covers them. Phase T will need this same fix when it goes multi-session. Tracked at [[code-fact-daemon-resolves-session-by-payload]].
- **`ModuleHostClient` (`src/app/client/module-host-adapter.ts`) doesn't thread sessionId in `modules/call` / `modules/host-call` / `modules/bind-sender` payloads.** Pre-existing, fine today because the only multi-session consumer is MCP, and MCP uses `module-proxy.ts` directly (not this adapter). Phase E (renderer multi-session) will need to either thread sessionId through these methods or move the renderer to a per-tab connection model.
- **MCP `outputSchema` audit.** Other tools may declare `outputSchema` and return bare; only `stop-session` + `list-sessions` were exercised by today's probe. A sweep of `src/mcp/tools.ts` for handler-shapes-vs-outputSchema would harden the surface.
- **`session-events-envelope` parallel-load flake.** Pre-existing; passes in isolation. Unrelated.

## Next-session prompt

```
Pick up at: Phase E1 — Electron renderer multi-session UI.
Session doc: docs/sessions/2026-05-15-phase-m-modules-listener-fix.md
Plan: docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md (§ E1-E6.5)
Repo: /Users/martincouso/Downloads/rn-dev-cli, branch main @ 832152a, 30 commits ahead of origin (local-only, do not push).

Phase M is closed. All 3 PROBE=1 specs green against acme:
- probe-cold-start-mcp ✅
- probe-real-build-mcp-multi ✅
- probe-real-devtools-mcp-multi ✅ (sessions return DIFFERENT proxyPorts)

Standard gate green: 1468 vitest + 4 tsc baseline + 0 electron tsc + 13/13 smoke.

Phase E sub-slices (per plan § E1-E6.5):
  E1: Per-tab session attach in the renderer (instances panel binds to sessionId).
  E2: Tab strip + per-tab service status (Metro/DevTools/Build) — pull from ctx.sessions Map.
  E3: ipcMain handlers route by sessionId arg; ipcRenderer bridge gains sessionId param.
  E4: Wizard flow opens an additional tab via session/start { profile } instead of restarting.
  E5: Cross-tab guards (destructive actions modal-confirm per [[feedback-modal-over-inline-confirm]]).
  E6: REAL_BOOT_SMOKE Playwright spec for 2-tab parallel flow.
  E6.5: Per-tab module subprocess isolation parity test (mirrors probe-real-devtools-mcp-multi).

Before starting:
- Read docs/sessions/2026-05-15-phase-m-modules-listener-fix.md end-to-end.
- Read docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md § E1-E6.5.
- Check that ModuleHostClient (src/app/client/module-host-adapter.ts) needs sessionId
  threaded through modules/call / host-call / bind-sender for E to work — this is
  the renderer's analog of the MCP module-proxy fix that just landed.

Highest-leverage next slice: E1 + ModuleHostClient sessionId threading. Without it
the renderer's first tab works but a second tab will hit the same dual-listener
race the MCP path just exited.

Fallback if Phase E is too large for one session:
- Land just ModuleHostClient sessionId threading (the wire-contract parity fix)
  with a unit-level regression test, document the renderer UI work for the
  next session. That alone closes the architectural gap and unblocks E2+.

Parked:
- Phase T (TUI multi-session) — depends on TUI adapter sessionId-in-payload fix.
- MCP outputSchema audit across all tools (only stop-session + list-sessions
  fixed this session).
- session-events-envelope parallel-load flake.
- D7 release-walk-under-real-3p-module follow-up.
- Pre-existing smoke-suite daemon leaks.
```

## Related memories

- [[phase-m-complete]] — Phase M state (now CLOSED), full commit list
- [[code-fact-daemon-resolves-session-by-payload]] — generalized wire-contract rule, both builder/metro AND modules
- [[code-fact-module-host-per-session]] — root-cause of devtools-multi-port hypothesis resolved (dual-listener race, not subprocess sharing)
- [[code-fact-mcp-outputschema-requires-structured]] — new memory; the drive-by fix
- [[feedback-parallel-instance-requirement]] — user's 4-instance use case framing (driver for not deferring this fix)
- [[real-boot-is-the-only-gate]] — probe surfaced both M-phase bug classes
- [[feedback-test-parity-no-gaps]] — phase E will need the same three-layer test parity (fast + integration + real-boot probe)
- [[workflow-local-only-personal-account]] — no push, no PR
- [[single-branch-single-worktree]] — main only
