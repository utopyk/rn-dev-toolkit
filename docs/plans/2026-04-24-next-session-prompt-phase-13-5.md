# Next-Session Prompt — Phase 13.5 (MCP ergonomics + installer finale)

**Paste the block below at the start of the next session.**

---

We're continuing the rn-dev-cli daemon refactor. Phase 13.4.1 shipped
2026-04-24 via [PR #20](https://github.com/utopyk/rn-dev-cli/pull/20)
(squash-merged as d0fcf4b). Every Electron ipcMain handler now talks
to the daemon through `ModuleHostClient`; the in-process module
system is gone; three new daemon RPCs (`modules/host-call`,
`modules/list-panels`, `modules/resolve-panel`) carry the panel
bridge's data plane; services.ts collapsed 514 → 246 LOC.

The 4-reviewer round on PR #20 closed 4 P0s + 8 P1s in-branch; the
handoff at
[docs/plans/2026-04-24-module-system-phase-13-4-1-electron-flip-handoff.md](./2026-04-24-module-system-phase-13-4-1-electron-flip-handoff.md)
enumerates the deferred items. This session is the Phase 13 finale.

## This session: Phase 13.5 only

### 1. MCP server uses `connectToDaemon` client-side

Today the MCP server (`src/mcp/server.ts`) owns an in-process
`ModuleHostManager` + `ModuleRegistry` via `start-flow.ts` / similar.
Flip it to a daemon client — same pattern the TUI (13.3) and Electron
(13.4.1) now use. Deliverable: MCP's `modules/call`, `modules/list`,
`modules/subscribe` all go through `connectToDaemonSession`; MCP's
process starts without spawning any runtime services itself.

### 2. Ref-counted `DaemonSession.release()`

`disconnect()` drops the client's subscription without teardown.
`stop()` tears the session down. `release()` is the middle ground:
"this client is done with the session; decrement the refcount, and
if I was the last one, tell the daemon to stop." This enables:
- Electron + MCP attached to the same daemon: either can quit without
  killing the other's session.
- `instances:create` multi-session in Electron (per Phase 13.4.1
  handoff, currently returns `MULTI_INSTANCE_NOT_SUPPORTED`).

### 3. Active-daemon registry at `~/.rn-dev/registry.json`

A JSON file listing `{ worktreeAbsPath, sockPath, pid, daemonVersion }`
per running daemon. `connectToDaemon` reads it to discover whether a
daemon already exists for this worktree before cold-spawning. Enables
the MCP server (running from a different working directory) to locate
the daemon for the user's current RN project.

### 4. Packaged-Electron daemon entry

`electron/daemon-connect.ts::resolveDaemonEntry` currently throws
under `app.isPackaged`. Wire the packaged-asar layout so production
Electron builds can cold-spawn a daemon. Kieran P1 + Security P2 from
PR #18; Arch P1 from PR #20 handoff.

### 5. Daemon-side sender binding for `modules/host-call`

Security P1-4 from PR #20. The daemon's dispatcher has no sender
check; any same-UID client can invoke with an arbitrary `moduleId`.
Panel-sender-registry gate is Electron-side only. Add a daemon-side
session table: which `moduleId`s is this connected client entitled
to call on behalf of? Panel sessions bind on activation; MCP + TUI
clients act on behalf of the user (no panel binding).

### 6. `AuditOutcome` widening

Sec P1-3 from PR #20. The 3-value `AuditOutcome` collapses
granular reasons (`unavailable`, `method-not-found`, etc.) that used
to be visible in the Electron-side service:log. Either widen the
type or add a discriminator field so post-hoc forensics has the
detail.

### 7. `instance:section:start|end` events via daemon-side progress

The renderer's section UX (`Preflight`, `Clean`, `Metro Start`, `Build`)
stopped firing after services.ts collapsed. Daemon's
`bootSessionServices` already emits `session/log` events — extend
with a `session/section` variant (or similar) that the Electron
main-process forwards to the renderer's `instance:section:*` IPC
channels. Optional / stretch — the renderer degrades gracefully
without sections.

### 8. `instance:retryStep` via daemon RPCs

Step retry currently stubs out with "restart required". Add a
daemon-side `session/retryStep(stepId)` action that targets a
running session's individual boot steps (preflight, clean, watchman,
metro, build). Wire Electron's handler through it.

## Merge gate

**Integration test #7 — `connectToDaemon` survives client churn.**
Two MCP-style clients attach simultaneously; one calls `release()`;
the other keeps operating. Assert the daemon stays alive until the
second client releases. Paired with test #5 (GUI quit / MCP survive)
and test #6 (panel-bridge daemon RPCs) as the Phase 13 lifecycle
contract.

Plus all existing tests + panel-bridge-daemon test stay green.

## TDD discipline

1. First commit: integration test #7 + daemon-side sender binding
   test for `modules/host-call` (both failing).
2. `DaemonSession.release()` ref-counted semantic + daemon-side
   refcount on `session/start`.
3. `modules/host-call` sender binding.
4. MCP server flipped to `connectToDaemon`.
5. Active-daemon registry + packaged-Electron entry.
6. Error-shape consolidation + audit outcome widening.
7. Optional: section events + step retry via daemon RPCs.

## Baselines to match or improve on (post-13.4.1)

- **vitest**: 936 / 0
- **tsc root**: 149 (wizard errors — pre-existing)
- **tsc electron**: 0
- **`bun run build`**: green
- **`bun run typecheck`**: green at 149

## After merging 13.5

- Write `docs/plans/2026-04-??-module-system-phase-13-5-handoff.md`.
- Run parallel reviewers (Kieran TS + Architecture + Security +
  Simplicity). Apply P0/P1 pre-merge. Squash-merge.
- This is the Phase 13 finale — next phase is the Module System
  brainstorm continuation (built-in devtools module graduation, MCP
  tool proxying, marketplace UX polish) per the earlier roadmap.

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
- `RN_DEV_DAEMON_BOOT_MODE=fake` for integration tests that shouldn't
  spawn real Metro.
- `fakeBootSessionServices` now wires `registerModulesIpc` + a
  widened `FakeModuleHostSurface` — tests exercising `modules/call`
  against the fake path will crash on `acquire()` by design. Widen
  the stub if a test legitimately needs it.
- Panel-subprocess-survives-Electron-drop lifecycle check (deferred
  from 13.4.1 merge gate) lands here alongside the daemon-side
  panel-bridge work if it goes that way.
