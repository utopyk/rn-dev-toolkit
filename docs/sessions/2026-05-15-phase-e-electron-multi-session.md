# Phase E Electron Multi-Session — Session Handoff (2026-05-15)

## What landed

Three commits, 32 commits ahead of origin (local-only per [[workflow-local-only-personal-account]]):

- `2d9e7d4` feat(electron): Phase E1 — sessions Map + ModuleHostClient sessionId threading
- `4328714` feat(electron): Phase E2+E3 — per-session metro/devtools/tools/modules client maps
- `1d537bf` feat(renderer): Phase E4+E5 — multi-session UX cleanup + InstanceTabs parity tests

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
npx vitest run                                                        # 1477 + 6 skipped (0 fail)
npx tsc --noEmit -p electron/tsconfig.json                            # clean
npx tsc --noEmit 2>&1 | grep -v "src/ui/" | grep "error TS" | wc -l   # 4 baseline
npm run test:smoke                                                    # 13 pass + 4 skipped (32.2s)
```

+9 new tests landed:

- `src/app/client/__tests__/module-host-adapter.test.ts` (+5): sessionId-in-payload for call/host-call/bind-sender, payload-clean for non-session-scoped RPCs (list/listPanels), graceful fall-through when getSessionId returns null.
- `renderer/components/__tests__/InstanceTabs.test.tsx` (+4): two-instance render, inactive-tab click selects the second instance, closing the second tab doesn't fire onClose for the first, add-button is single-fire.

## Decisions made

- **Instance ID stays the renderer's per-tab key.** SessionRecord cross-references instanceId↔sessionId; server-side handlers resolve via `getSessionRecordForInstance(instanceId)`. The plan's "ipcRenderer bridge gains sessionId param" intent is satisfied by this indirection — the renderer never has to learn the daemon's SessionId terminology. Existing preload allowlist unchanged.
- **Active-session fallback in handlers.** Every handler accepts `instanceId?: string`; falls back to `state.activeSessionId` when omitted. Lets pre-E renderer code paths and the simulated-logs browser-only mode continue to work without modification. Single-session deployments (one tab open) behave identically to pre-E.
- **Per-call deps resolution beats deps caching.** The three registrar wirings resolve deps fresh on every IPC. Trades a Map lookup for the certainty that the user's current tab drives the routing. Was tempted to do per-sessionId-keyed deps caches; YAGNI under expected call rate (~1/sec from user clicks).
- **DevTools fan-out is per-session, not per-instance.** Even though "one instance per session" today, emit at the session level so a future "multiple instances per session" reshape doesn't have to revisit this.
- **Two waiting strategies in `awaitModulesClient`.** Per-session waiter (sessionId known, client not yet published — wait for THAT session) AND pre-session waiter (sessionId not yet known — wait for ANY first client). The mount-before-attach race the renderer's Marketplace panel hits goes through the second path; tab-switch-before-publish goes through the first.
- **No new renderer components needed for E4.** The existing `InstanceTabs` + close-confirm modal in App.tsx already satisfy the plan's `SessionTabStrip` / `NewSessionButton` / `CloseSessionModal` intent. The plan was written before that work landed (2026-05-07). Plan diff is purely server-side rewiring + the PROFILE_MISMATCH dead-code removal.

## Parked / known issues

- **E6 + E6.5 real-boot Playwright spec.** Plan calls for `tests/electron-real-e2e/multi-session-electron.spec.ts` (two tabs from one daemon, close one → modal Confirm → other survives). Needs a physical device + the existing `extraProfiles` infrastructure at [tests/electron-real-e2e/launch.ts:103-126](../../tests/electron-real-e2e/launch.ts). The serial happy path + concurrent race variant per § C3 E6.5 are next-session work. The architecture is correct under all three unit + smoke layers; real-boot is the validation that catches "this is correct in isolation but the boot ordering across two simultaneous daemon attaches surfaces a race the listener filter doesn't cover."
- **CloseSessionModal-as-a-component test.** The close-confirm modal lives inline in App.tsx (lines 688-717). Testing it requires mounting the whole App with stubbed IPC bridge — bigger lift than the InstanceTabs unit test. The InstanceTabs tests cover the close-click → onClose path; the modal-confirm path is covered by the smoke suite end-to-end. A focused App-level integration test is a nice-to-have, not a blocker.
- **CloseSessionModal `Esc` key.** Already wired in App.tsx (lines 501-513); no test today. Would catch a future refactor that ditches the keydown listener.
- **MCP outputSchema audit.** Still parked from Phase M handoff — only `stop-session` + `list-sessions` were wrapped this cycle. Other tools with `outputSchema` may have the same bare-return defect, unmasked next time a probe exercises them.
- **TUI multi-session (Phase T).** Depends on TUI adapter sessionId-in-payload fix. Pre-existing single-session; not regressed by E. Tracked at [[code-fact-daemon-resolves-session-by-payload]].
- **`session-events-envelope` parallel-load flake.** Pre-existing; passes in isolation. Unrelated.
- **`@/` import path style for new files.** Mixed `node:events` vs `events` imports — non-blocking but inconsistent. Cleanup pass when convenient.

## Next-session prompt

```
Pick up at: Phase E6 + E6.5 — real-boot Electron multi-session.
Session doc: docs/sessions/2026-05-15-phase-e-electron-multi-session.md
Plan: docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md (§ E6, § C3 E6.5)
Repo: /Users/martincouso/Downloads/rn-dev-cli, branch main @ 1d537bf, 32 commits ahead of origin (local-only, do not push).

Phase E1–E5 closed. State, IPC, adapter, and renderer all multi-session-aware:
- state.sessions Map<SessionId, SessionRecord> + activeSessionId
- ModuleHostClient stamps sessionId in modules/call,host-call,bind-sender (wire-contract parity with M-phase fix 48fde5b)
- metro/devtools/tools/modules clients keyed by SessionId
- DevTools fan-out scoped per session
- registerModule*Handlers resolve per-call against active session
- InstanceTabs covers multi-instance render/select/close
- PROFILE_MISMATCH dead code retired

Standard gate green: 1477 vitest + 4 tsc baseline + 0 electron tsc + 13/13 smoke.

Phase E6 + E6.5 sub-slices (per plan):
  E6: REAL_BOOT_SMOKE happy-serial path — tests/electron-real-e2e/multi-session-electron.spec.ts
      - Use existing extraProfiles support at tests/electron-real-e2e/launch.ts:103-126
      - Two profiles { iphone, android } against acme-mobile-app fixture
      - Click "+" → second session, two tabs visible
      - Switch tabs → DevTools panel renders focused session's data
      - Close one tab → modal Confirm → that session's Metro stops, OTHER session's lsof shows port still bound
  E6.5: Concurrent race variant — split from E6
      - Both instances:create dispatched in parallel (no wait between)
      - Assert both reach `running` without cross-contamination
      - Asserts there is no race in `pendingCreate` (state.sessions.size cap) under concurrency

Before starting:
- Read docs/sessions/2026-05-15-phase-e-electron-multi-session.md end-to-end.
- Read tests/electron-real-e2e/launch.ts to understand the extraProfiles call shape.
- Probe E6 with REAL_BOOT_SMOKE=1 npx playwright test --config tests/electron-real-e2e/playwright.config.ts after writing it.
- Need physical device or a working pair of simulators bootable concurrently (the two-iOS-simulator path is what the acme team runs in their pair-programming sessions).

Highest-leverage next slice: E6 happy serial path. Once that's green, E6.5
(concurrent race variant) is a small delta. E5's missing
CloseSessionModal-as-component test can drop in alongside.

Parked:
- MCP outputSchema audit across remaining tools.
- Phase T (TUI multi-session) — depends on TUI adapter sessionId-in-payload.
- session-events-envelope parallel-load flake.
- Phase X3 solution doc — write after E6 lands.
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
