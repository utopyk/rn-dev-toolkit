# Next-Session Prompt — Phase 13.5 (daemon-RPC + UX completion)

**Paste the block below at the start of the next session.**

---

We're continuing the rn-dev-cli daemon refactor. Phase 13.4.1 shipped
2026-04-24 via [PR #20](https://github.com/utopyk/rn-dev-cli/pull/20)
(squash-merged as d0fcf4b). The Electron flip is complete: every
ipcMain handler routes through the daemon client, no in-process
module system, services.ts collapsed 514 → 246 LOC.

Then 2026-04-24/25 four post-merge fixes landed direct to main as
Martin caught regressions while live-testing:

- **a9bf7f1** — main-side `awaitModulesClient` + 5 boot-window race
  fixes (renderer InstanceLogs.sections crash, dev-mode
  `resolveDaemonEntry`, `spawnDetachedDaemon` Electron execPath,
  fake-boot built-in registration, fake-boot configStore).
- **9c7e19a** — `serviceBus.abortModulesClient(reason)` for fast-fail
  on no-default-profile / connect-failed paths (replaces the 30s
  `awaitModulesClient` timeout with a fix-this-message that surfaces
  in the renderer).
- **b29017d** — `instances:create` attaches a daemon session when
  none is active (was always returning `MULTI_INSTANCE_NOT_SUPPORTED`,
  forcing a restart after the wizard).
- **(commit pending this session)** — five more Playwright smoke
  specs covering DevTools, Metro Logs, Lint, Type Check, Reload +
  Dev Menu shortcuts.

Phase 13.5 finishes the Phase 13 arc and addresses the remaining
"not yet wired to the daemon" stubs.

## This session: Phase 13.5

### 1. `instance:retryStep` daemon RPC (P0 user-visible)

`electron/ipc/instance.ts::instance:retryStep` is currently a stub
that returns "Step retry (X) is not wired to the daemon yet —
restart the app." The renderer's section "Retry" buttons are
clickable but useless.

Daemon side:
- New `session/retryStep` action handled in
  `src/daemon/client-rpcs.ts` (or a new dispatcher). Body: `{ stepId:
  "preflight" | "clean" | "watchman" | "metro" | "build" }`. The
  supervisor exposes a `retryStep(stepId)` method that drives the
  individual section against the live `SessionServices`.
- For `metro` retry: dispose existing Metro + restart with
  `resetCache: false`. For `build` retry: spawn a new `Builder.build()`
  call. For `preflight` / `clean` / `watchman`: re-run the same
  helper from `bootSessionServices`.

Electron side:
- `instance:retryStep` calls a new `serviceBus`-resolved `session`
  client (or extends an existing adapter). Round-trips, fans events
  back into `instance:section:start|end` IPC channels.

Smoke: each section's Retry button works without restart.

### 2. Multi-instance via `DaemonSession.release()` ref-counting

Today `instances:create` returns `MULTI_INSTANCE_NOT_SUPPORTED` when
a session is already active. To support multiple profiles attached
to the same daemon (or to allow Electron + MCP co-attached without
either killing the other's session), Phase 13.5 needs ref-counted
session lifetimes.

Design (per [docs/superpowers/specs/2026-04-24-daemon-refactor-design.md](../superpowers/specs/2026-04-24-daemon-refactor-design.md)):

- `DaemonSession.release()` decrements the daemon's refcount for
  this session. Last release tears down. Mid-life releases just
  drop the client's subscription (matches `disconnect()`).
- Daemon-side: `session/start` increments refcount; `session/release`
  decrements. `session/stop` is the explicit "kill for everyone"
  variant kept around for the CLI.
- Active-daemon registry at `~/.rn-dev/registry.json` so MCP can
  discover a running daemon's worktree without scanning every
  `.rn-dev/sock`.

Merge gate: integration test #7 — two MCP-style clients, one
`release()`s, the other keeps operating + can RPC.

### 3. Packaged-Electron daemon entry

`electron/daemon-connect.ts::resolveDaemonEntry` still throws under
`app.isPackaged`. Wire the asar layout for production builds:
- `app.asar/dist/index.js` is the CLI entry in packaged mode.
- `spawnDetachedDaemon` already picks the right interpreter via
  `pickDaemonInterpreter` — packaged path uses node since the entry
  is `.js`.

### 4. MCP server uses `connectToDaemon` client-side

Today the MCP server (`src/mcp/server.ts`) owns its own
`ModuleHostManager` + `ModuleRegistry` via `start-flow.ts` /
similar. Flip it to a daemon client — same pattern TUI (13.3) and
Electron (13.4.1) use.

### 5. Daemon-side sender binding for `modules/host-call` (Sec P1-4 deferred)

Today the dispatcher in `src/app/modules-ipc.ts::hostCall` has no
sender check; any same-UID client can call host-call with an
arbitrary `moduleId`. Panel-sender-registry gate is Electron-side
only. Add a daemon-side session table tracking which moduleIds
each connected client is entitled to act on behalf of.

### 6. `AuditOutcome` widening (Sec P1-3 deferred)

Currently 3-value: `ok | error | denied`. Granular `unavailable`,
`method-not-found`, etc. that the Electron side used to surface got
lost in the daemon-side move. Widen the type or add a discriminator.

### 7. Re-introduce `instance:section:start|end` events (optional)

The renderer's section UX (`Preflight`, `Clean`, `Metro Start`,
`Build`) stopped firing after services.ts collapsed. Daemon's
`bootSessionServices` could emit a `session/section` variant of
`session/log`; main-process forwards to the renderer's
`instance:section:*` channels. Stretch — the renderer degrades
gracefully without sections.

## Pre-push verification standard (now enforced via CLAUDE.md)

Every renderer/electron change MUST pass three layers:

1. `npx vitest run` — fast (~25s). Catches TDZ, render crashes,
   dispatcher contract drift. Renderer components have colocated
   `__tests__/*.test.tsx` mounting in jsdom with stubbed `window.rndev`.
2. `npx tsc --noEmit && npx tsc --noEmit -p electron/tsconfig.json`
   — catches type drift in IPC payload shapes.
3. `npx playwright test` (`npm run test:smoke`) — slow (~50s).
   Boots real Electron + daemon against `tests/electron-smoke/fixtures/smoke-rn`
   under `RN_DEV_DAEMON_BOOT_MODE=fake`. Currently 10 specs covering:
   mount, Marketplace, Settings (form + abort), DevTools mount,
   Metro Logs mount, Lint button, Type Check button, Reload + Dev
   Menu shortcuts, instances:create attach.

Do NOT push renderer-touching changes without all three green. The
"vitest+tsc green, then ship and discover the renderer goes blank"
failure mode is what this rule exists to prevent.

## Smoke fixture caveats

The Playwright fixture at `tests/electron-smoke/fixtures/smoke-rn`
uses `RN_DEV_DAEMON_BOOT_MODE=fake` so the daemon doesn't spawn
real Metro. Side effects:

- `bootSessionServices` is replaced by `fakeBootSessionServices` —
  any new daemon-side behavior the smoke needs to exercise must
  also exist in fake-boot. The fake registers built-ins +
  `ModuleConfigStore` + `registerModulesIpc`.
- The fake's `ModuleHostManager` stub raises on `acquire()`. Any
  smoke that exercises `modules/call` against fake-boot will throw
  with a readable "not supported under fake" message — widen the
  fake before asserting against that path.
- A new "real-boot smoke" (a 6th launch helper) might be worth
  adding for a release-gate test that DOES spawn real Metro. Not
  CI-friendly today; track for Phase 13.5 if the budget allows.

## Baselines to match or improve on (post-Phase 13.4.1 + post-fix bundle)

- **vitest**: 942 / 0
- **tsc root**: 149 (wizard errors — pre-existing)
- **tsc electron**: 0
- **`bun run build`**: green
- **`npx playwright test`**: 10 / 0

## Branching

```sh
git checkout main
git pull
git checkout -b feat/module-system-phase-13-5
```

Per Martin's working preference for this repo: direct feature branch
on `main`, not worktrees — avoids the duplicate install/build pain.

## Remember

- `vitest run`, not `bun test`.
- `bun run build` + `bun run typecheck` for production verification.
- `npx playwright test` for smoke before any merge.
- `RN_DEV_DAEMON_BOOT_MODE=fake` for integration tests that shouldn't
  spawn real Metro. The fake now registers built-ins +
  `ModuleConfigStore` + `registerModulesIpc` (Phase 13.4.1 gaps
  closed in the post-merge bundle).
- `state.daemonSession` (electron/ipc/state.ts) tracks the active
  session — both `startRealServices` and `instances:create` populate
  it via `attachDaemonSession` from `electron/ipc/services.ts`.
- `serviceBus.abortModulesClient(reason)` is the fast-fail signal for
  handlers that await the daemon client; clears automatically when
  a successful publish lands.
- Don't push without running all three verification layers. The
  user's terminal output (`npm run dev:gui`) is the canonical "what
  happens in the real app" — when in doubt, ask Martin to share
  rather than guess.

## Deferred follow-ups from Phase 13.4 + 13.4.1 to fold in

Lower priority; fold whichever touch the natural diff path of 13.5
work:

- **Simplicity P1 (PR #18)** — collapse the 5 adapters' identical
  `notifyDisconnected` bodies into an `AdapterBase` helper.
- **Simplicity P1 (PR #18)** — `electron/daemon-connect.ts` inline
  into `main.ts`. Now that `attachDaemonSession` lives in
  `services.ts`, daemon-connect is tiny — re-evaluate.
- **Kieran P1 (PR #18)** — null out `resolveRunning` /
  `rejectRunning` after settle in `src/app/client/session.ts`.
- **Kieran P1-4 (PR #20)** — runtime narrowing on the other 9 RPC
  methods on `ModuleHostClient` (today only `hostCall` +
  `resolvePanel` are narrowed).
- **Sec P2-3 (PR #18)** — cross-client RPC ordering test.
- **Sec P2-4 (PR #18)** — `disconnect()` should `removeAllListeners()`.
- **`window.rndev.off(channel, listener)`** doesn't honor the
  listener arg in `electron/preload.cjs` (it `removeAllListeners`).
  Surfaced while debugging the Settings crash; not load-bearing
  today but a future foot-gun.

## After merging 13.5

- Write `docs/plans/2026-04-??-module-system-phase-13-5-handoff.md`.
- Run parallel reviewers (Kieran TS + Architecture + Security +
  Simplicity). Apply P0/P1 pre-merge. Squash-merge.
- Phase 13 daemon refactor complete. Roadmap returns to:
  - Phase 12 Option C: npm publishing the three modules
    (DNS-blocked on `rn-tools.com` + `@rn-dev-modules` scope).
  - Phase 12.2: bootstrap-surface bundle (`loadModuleManifest` +
    `isModuleEntry` + `requireCapability` SDK extractions).
  - Original-plan phases 9 (flow recording + Maestro YAML) / 10
    (`uses:` module deps) / 11 (polish + threat model).
