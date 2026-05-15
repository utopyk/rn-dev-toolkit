# Phase E Electron Multi-Session — Session Handoff (2026-05-15)

## What landed

Five commits, 34 commits ahead of origin (local-only per [[workflow-local-only-personal-account]]):

- `2d9e7d4` feat(electron): Phase E1 — sessions Map + ModuleHostClient sessionId threading
- `4328714` feat(electron): Phase E2+E3 — per-session metro/devtools/tools/modules client maps
- `1d537bf` feat(renderer): Phase E4+E5 — multi-session UX cleanup + InstanceTabs parity tests
- `c65350d` docs: Phase E1-E5 session handoff (this doc, superseded by the post-E6 edit below)
- `cedaa96` test(electron): Phase E6+E6.5 — real-boot multi-session Playwright probes

**Phase E is fully closed.** All sub-slices E1 through E6.5 landed with real-boot validation against the acme-mobile-app project + physical iPhone 15 Pro.

## Architecture

The Electron host now multiplexes the daemon's per-session adapters cleanly:

- **state.sessions: `Map<SessionId, SessionRecord>`** — one record per renderer tab. Each carries `{ sessionId, daemonSession, instanceId, profileName, attachedAt, disconnectLogged }`. The previous singleton `state.daemonSession` + `state.daemonSessionProfileName` fields are gone.
- **`attachDaemonSession` returns a SessionRecord** and writes to the Map. Per-session `disconnectLogged` (was `disconnectLoggedFor: DaemonSession | null` module-scope) so the second session's disconnect logs cleanly instead of being suppressed by the first.
- **`instances:create` always mints a fresh session.** The pre-E cross-profile rejection (`PROFILE_MISMATCH`) and same-profile-sharing branch are both deleted. Cap at `MAX_SESSIONS = 4` with `E_SESSION_LIMIT_REACHED`. Concurrent invocations serialized via `pendingCreate` (§ Deepening A8).
- **`instances:remove` scopes `session/stop` to the specific SessionId.** Other tabs survive. Two-phase teardown (UI-side first, daemon-side async) preserved from the pre-E fix.
- **metro/devtools/tools clients now keyed `Map<SessionId, Client>`.** Populated from the serviceBus's existing per-session payloads (Phase D5 carried `sessionId` already — Electron was just ignoring it). `clientForInstance(instanceId?)` resolves through SessionRecord → SessionId → map, falling back to active session.
- **DevTools fan-out filters by sessionId.** Pre-E, `fanChange()` broadcast to every open tab — session-A's CDP delta would surface on session-B's panel. Now only emits to instances bound to the originating sessionId.
- **ModuleHostClient stamps payloads with sessionId.** Threaded into `modules/call`, `modules/host-call`, `modules/bind-sender` via a `getSessionId` constructor closure. Wire-contract parity with the MCP module-proxy fix `48fde5b` — without it, the renderer's second tab would hit the same dual-listener race the MCP path just exited.
- **`awaitModulesClient(instanceId?)` per-session.** Pre-E was a singleton promise; under N sessions it returned whichever client published first, racing tab focus. Now waits specifically for THE-RIGHT-session's client.
- **Three registrar wirings (`registerModule*Handlers`) drop their closure-cached `deps`.** Resolve fresh deps per-call via `getActiveSessionRecord()`. One Map lookup + one struct alloc per IPC — negligible cost relative to the round-trip the deps drive. The previous "first-publish-wins deps" surfaced session-A's manifest entries on session-B's panel after a tab switch.
- **`moduleRoots` panel-bridge cache scoped per-session.** An uninstall in session A no longer wipes session B's path lookup.

## Gate

```bash
npx vitest run                                                                                    # 1477 + 6 skipped (0 fail)
npx tsc --noEmit -p electron/tsconfig.json                                                        # clean
npx tsc --noEmit 2>&1 | grep -v "src/ui/" | grep "error TS" | wc -l                               # 4 baseline
npm run test:smoke                                                                                # 13 pass + 4 skipped (32s)
REAL_BOOT_SMOKE=1 npx playwright test --config tests/electron-real-e2e/playwright.config.ts \
  tests/electron-real-e2e/multi-session-electron.spec.ts                                          # 2 pass (9.2s)
```

+11 new tests landed:

- `src/app/client/__tests__/module-host-adapter.test.ts` (+5): sessionId-in-payload for call/host-call/bind-sender, payload-clean for non-session-scoped RPCs (list/listPanels), graceful fall-through when getSessionId returns null.
- `renderer/components/__tests__/InstanceTabs.test.tsx` (+4): two-instance render, inactive-tab click selects the second instance, closing the second tab doesn't fire onClose for the first, add-button is single-fire.
- `tests/electron-real-e2e/multi-session-electron.spec.ts` (+2, REAL_BOOT_SMOKE=1 gated): E6 serial path (click + → wizard → second profile → both tabs running → close one survives the other) and E6.5 concurrent path (two `instances:create` dispatched in parallel land cleanly, ≤2 sessions, no duplicate sessionIds, PORT_B binds).

## Decisions made

- **Instance ID stays the renderer's per-tab key.** SessionRecord cross-references instanceId↔sessionId; server-side handlers resolve via `getSessionRecordForInstance(instanceId)`. The plan's "ipcRenderer bridge gains sessionId param" intent is satisfied by this indirection — the renderer never has to learn the daemon's SessionId terminology. Existing preload allowlist unchanged.
- **Active-session fallback in handlers.** Every handler accepts `instanceId?: string`; falls back to `state.activeSessionId` when omitted. Lets pre-E renderer code paths and the simulated-logs browser-only mode continue to work without modification. Single-session deployments (one tab open) behave identically to pre-E.
- **Per-call deps resolution beats deps caching.** The three registrar wirings resolve deps fresh on every IPC. Trades a Map lookup for the certainty that the user's current tab drives the routing. Was tempted to do per-sessionId-keyed deps caches; YAGNI under expected call rate (~1/sec from user clicks).
- **DevTools fan-out is per-session, not per-instance.** Even though "one instance per session" today, emit at the session level so a future "multiple instances per session" reshape doesn't have to revisit this.
- **Two waiting strategies in `awaitModulesClient`.** Per-session waiter (sessionId known, client not yet published — wait for THAT session) AND pre-session waiter (sessionId not yet known — wait for ANY first client). The mount-before-attach race the renderer's Marketplace panel hits goes through the second path; tab-switch-before-publish goes through the first.
- **No new renderer components needed for E4.** The existing `InstanceTabs` + close-confirm modal in App.tsx already satisfy the plan's `SessionTabStrip` / `NewSessionButton` / `CloseSessionModal` intent. The plan was written before that work landed (2026-05-07). Plan diff is purely server-side rewiring + the PROFILE_MISMATCH dead-code removal.

## Parked / known issues

- **D7 (`multi-session-daemon.spec.ts`) stopResp.ok shape.** First D7 test now gets past the daemon-files race (same waitFor patch as E6) but fails at `expect((stopResp.payload as { ok?: boolean })?.ok).toBe(true)` — `session/stop` no longer surfaces `{ok: true}` at the bare payload level. Likely a follow-on to Phase M's structuredContent wrapping that affected an internal shape D7 depends on. Out of scope for E; the D7 leak-cleanup test passes after the race fix.
- **CloseSessionModal-as-a-component test.** The close-confirm modal lives inline in App.tsx (lines 688-717). Testing it requires mounting the whole App with stubbed IPC bridge — bigger lift than the InstanceTabs unit test. The InstanceTabs tests cover the close-click → onClose path; the modal-confirm path is covered by the smoke suite end-to-end AND by E6 real-boot (clicks through the actual modal). A focused App-level integration test is a nice-to-have, not a blocker.
- **CloseSessionModal `Esc` key.** Already wired in App.tsx (lines 501-513); no test today. Would catch a future refactor that ditches the keydown listener.
- **MCP outputSchema audit.** Still parked from Phase M handoff — only `stop-session` + `list-sessions` were wrapped this cycle. Other tools with `outputSchema` may have the same bare-return defect, unmasked next time a probe exercises them.
- **TUI multi-session (Phase T).** Depends on TUI adapter sessionId-in-payload fix. Pre-existing single-session; not regressed by E. Tracked at [[code-fact-daemon-resolves-session-by-payload]].
- **`session-events-envelope` parallel-load flake.** Pre-existing; passes in isolation. Unrelated.
- **launch.ts `extraProfiles` always writes `branch: "main"`** (line 110) even in real-mode. The default profile picks up the real branch dynamically; extraProfiles should too. Not blocking E6 (the profile is loaded by name, not by branch-match), but the inconsistency will bite a future probe that does match by branch.
- **Smoke + real-e2e suites still leak daemons across runs.** Pre-existing per `middle_phase_complete.md`. E6's teardown is symmetric with D7's; both rely on `teardownRealE2e` which has its own pid-then-rmSync ordering.

## Next-session prompt

```
Pick up at: Phase T (TUI multi-session) OR the parked D7 stopResp.ok regression.
Session doc: docs/sessions/2026-05-15-phase-e-electron-multi-session.md
Plan: docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md (§ T1-T2)
Repo: /Users/martincouso/Downloads/rn-dev-cli, branch main @ cedaa96, 34 commits ahead of origin (local-only, do not push).

Phase E1–E6.5 fully closed. State, IPC, adapter, renderer, AND real-boot
validation all complete. Multi-session is production-correct for the
Electron + MCP arms (per [[phase-m-complete]] and [[phase-e-electron-multi-session-landed]]).

Standard gate green: 1477 vitest + 4 tsc baseline + 0 electron tsc + 13/13 smoke + 2/2 E6 real-boot.

Two parallel candidate slices, pick one:

1. **Phase T (TUI multi-session)** — plan § T1-T2.
   Wire sessionId into TUI's `builder-adapter.ts`, `metro-adapter.ts`,
   `devtools-adapter.ts` RPC payloads (parity with the M-phase MCP fix
   `48fde5b` and the E-phase Electron ModuleHostClient fix). The TUI is
   currently single-session by convention; multi-session would need a
   UI affordance (Ctrl-1/Ctrl-2 to switch active session per § T1) and
   start-flow refactor (`let session` → `const sessions: Map<SessionId, DaemonSession>`).
   Smaller diff than E because the TUI has no tab strip / modal / per-
   panel state — just the input handler.

2. **D7 stopResp.ok regression** — first test in tests/electron-real-e2e/multi-session-daemon.spec.ts.
   After the Phase E daemon-files race fix landed, the test gets further
   but fails at the session/stop response shape. Likely a follow-on to
   Phase M's structuredContent wrapping. Investigate `session/stop`
   handler's return path; trace where `{ ok: true }` was emitted vs
   wrapped. Small surface, but blocks the D7 gate.

Other parked items (cheaper, do alongside):
- CloseSessionModal-as-component renderer test (App.tsx integration).
- MCP outputSchema audit across remaining tools.
- launch.ts extraProfiles `branch: "main"` hardcode fix.
- Phase X3 solution doc — write to capture the multi-session pattern
  for future refactors (Map<sessionId>, sessionId-in-payload rule,
  per-call deps resolution).
```

## Related memories

- [[phase-d-complete]] — Phase D state (CLOSED), commit range
- [[phase-m-complete]] — Phase M state (CLOSED), commit range; M-phase fix 48fde5b is the wire-contract parent of this work
- [[code-fact-daemon-resolves-session-by-payload]] — generalized wire-contract rule; ModuleHostClient now follows it
- [[code-fact-module-host-per-session]] — root-cause memory; the E2 panel-roots-per-session fix maps to this
- [[feedback-parallel-instance-requirement]] — 4-instance use case framing
- [[feedback-modal-over-inline-confirm]] — close-tab modal pattern preserved
- [[real-boot-is-the-only-gate]] — E6 + E6.5 are the missing real-boot layer
- [[workflow-local-only-personal-account]] — no push, no PR
- [[single-branch-single-worktree]] — main only
