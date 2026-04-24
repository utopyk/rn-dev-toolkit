# Next-Session Prompt — Phase 13.2 (Services Move Into the Daemon)

**Paste the block below at the start of the next session.**

---

We're continuing the rn-dev-cli daemon refactor. Phase 13.1 shipped
2026-04-24 via [PR #15](https://github.com/utopyk/rn-dev-cli/pull/15)
(squash-merged as `2a3c671`) — an empty-but-working per-worktree
daemon with `daemon/ping` + `daemon/shutdown` + pid/sock arbitration,
but **no services**. See
[`docs/plans/2026-04-24-module-system-phase-13-1-daemon-lifecycle-handoff.md`](./2026-04-24-module-system-phase-13-1-daemon-lifecycle-handoff.md)
for the full closeout, and
[`docs/superpowers/specs/2026-04-24-daemon-refactor-design.md`](../superpowers/specs/2026-04-24-daemon-refactor-design.md)
(on the `design/daemon-refactor` branch until it lands in main) for
the overall architecture.

**One-paragraph recap of the arc:** today `MetroManager` /
`DevToolsManager` / `ModuleHostManager` live in two places — the
TUI wires them up in `src/app/start-flow.ts::startServicesAsync`
behind `IpcServer` at `<wt>/.rn-dev/sock` (good), while Electron
main re-implements orchestration in-process with no socket at all
(bad; MCP sees `{error: "no-session"}` while the GUI is actively
capturing data). The daemon refactor unifies under a **per-worktree
detached daemon** that owns all services; Electron / TUI / MCP
become equal thin clients over one socket. Phase 13.1 shipped the
daemon shell; this session moves the services in.

## This session: Phase 13.2 only

Scope — still additive for the TUI/Electron/MCP surfaces. Nothing
flips to the daemon in 13.2; services just relocate to run inside
it. TUI + Electron + MCP keep their existing in-process paths until
13.3 / 13.4.

1. **Extract `startServicesAsync` core into a pure function.**
   `src/app/start-flow.ts::startServicesAsync` currently does: derive
   a `worktreeKey`, boot `MetroManager`, boot `DevToolsManager` once
   Metro is reachable, boot `ModuleHostManager` via
   `createModuleSystem`, wire them all to `serviceBus`, start the
   `IpcServer`. Factor the service-construction body into a new
   `bootSessionServices(opts)` function — reusable by both the
   existing TUI boot path (keeps working) and the new daemon
   supervisor. Lives in a dedicated module (candidate:
   `src/core/session/boot.ts`) so both callers import it cleanly.
2. **Wire `DaemonSupervisor` to drive sessions.** In
   `src/daemon/supervisor.ts` (renamed in 13.1 to avoid colliding
   with `src/core/module-host/supervisor.ts`), own a
   `SessionState` that transitions `stopped → starting → running →
   stopping → stopped`. Calls into `bootSessionServices` on
   `session/start`, tears down on `session/stop`, snapshots on
   `session/status`. Mirror the `EventEmitter +
   Map<worktreeKey,State> + explicit transitions` pattern used by
   `MetroManager` / `DevToolsManager` (see CLAUDE.md §"Patterns to
   mirror").
3. **Implement the four session RPCs in `src/daemon/index.ts`:**
   - `session/start { profile }` — returns `{status: "starting"}`
     immediately, fires off the boot. Snapshots profile (mid-flight
     profile edits are ignored; see spec §"Profile updates
     mid-session").
   - `session/stop` — graceful teardown. Daemon stays alive.
   - `session/status` — current `{status, services: {...}}`.
   - `events/subscribe` — server-streaming. Per-connection long-lived
     stream of lifecycle events (metro stdout/stderr, metro status,
     devtools capture, module state transitions, config changes).
     Tagged-union envelope `{kind, worktreeKey, data}`. Clients filter
     client-side. Reuse the in-process `serviceBus` fan-out pattern.
4. **Orphan module subprocess mitigations.**
   - **Linux**: `prctl(PR_SET_PDEATHSIG, SIGKILL)` on module spawn so
     the module dies automatically on daemon death. No macOS
     equivalent — practical impact is bounded because this is a dev
     machine, not a server.
   - **Startup sweep**: new daemon on boot scans
     `~/.rn-dev/modules/<id>/pid` for dead-daemon orphans and kills
     them. Same sweep pattern the deferred Phase 12 Option B
     (`keepData` GC) will reuse.
5. **Audit-log concurrent-writer guard.** `~/.rn-dev/audit.log` is
   HMAC-chained. With N per-worktree daemons, concurrent
   `AuditLog.append()` calls break the chain. Wrap the append with
   a `flock(audit.log, LOCK_EX)` around the `{read-last-hmac,
   compute-new, append, fsync}` critical section. Cross-process on
   macOS + Linux. Low-frequency writes, so performance impact
   negligible.

### Reviewer-deferred items to bundle in 13.2

From the 13.1 reviewer round (per the 13.1 handoff):

- **Architecture P1#3** — `IpcServer.start()` internal unlink before
  bind creates a post-lock / pre-bind race. Hoist the unlink into
  `runDaemon` so only the lock-holder deletes. (13.2 is the natural
  place because the daemon starts owning the unlink timing.)
- **Arch P1#4** — `daemonEntry` option threading through
  `ConnectToDaemonOptions`. Land the signature now; 13.4's Electron
  migration will pass the packaged CLI entry path explicitly. Comment
  markers already in `spawn.ts` + `index.ts::detachAndExit`.

## Merge gate for 13.2

**Integration test #3 — session boot end-to-end.** Added to
`src/daemon/__tests__/session-boot.test.ts` using the existing
`spawnTestDaemon` helper + `test/fixtures/minimal-rn/`:

- Spawn daemon → connect client.
- Send `session/start` with a minimal profile against
  `test/fixtures/minimal-rn`.
- Subscribe to `events/*` → assert `metro/status: starting` then
  `metro/status: running` events arrive.
- `session/status` returns `{status: "running", services: {...}}`.
- Tear down: `session/stop` → `metro/status: stopped` event → daemon
  stays alive.

Fixture probably needs to grow enough to let Metro boot without
actually bundling — `react-native/package.json` minimal shim + Metro
config that short-circuits resolution. Do whatever's smallest that
lets `metro start` succeed against a fake worktree. If `metro start`
remains prohibitively heavyweight to stub, substitute with a
daemon-side `metro: "fake"` driver behind a test-only flag; the
session state machine is the thing being tested, not Metro itself.

## TDD discipline

1. First commit on the feature branch: `session-boot.test.ts` written
   and failing.
2. Implementation commits follow.
3. Do not land until the test is green.

## Baselines to match or improve on (post-13.1)

- **vitest**: 885 / 0
- **tsc root**: 150 (pre-existing wizard errors)
- **tsc electron**: 0
- **tsc per-module (3)**: 0 / 0 / 0
- **`bun run build`**: green
- **`bun run typecheck`**: green (at 150 baseline)

## After merging 13.2

- Write `docs/plans/2026-04-??-module-system-phase-13-2-services-in-daemon-handoff.md`.
- Run parallel reviewers (Kieran TS + Architecture + Security +
  Simplicity). Apply P0/P1. Squash-merge.
- Queue `docs/plans/2026-04-??-next-session-prompt-phase-13-3.md` for
  Phase 13.3 — **TUI migrates to the daemon**. `start-flow.ts`
  becomes a client: `connectToDaemon(worktree)` → `session/start` →
  subscribes to events. The in-process boot logic lives in the
  shared `bootSessionServices` now, so the TUI just flips its call
  site from direct-call to IpcClient. Merge gate: integration test
  **#4** (session survives client churn).

## Branching

```sh
git checkout main
git pull
git checkout -b feat/module-system-phase-13-2-services-in-daemon
```

Per Martin's working preference for this repo: direct feature branch
on `main`, not worktrees — avoids the duplicate install/build pain.

## Remember

- `vitest run`, not `bun test`.
- `bun run build` + `bun run typecheck` for production verification.
- `.claude/` and SDK `dist/` are gitignored.
- Every third-party module tool wire name carries the `<moduleId>__`
  prefix.
- `config-set` audit entries record patch keys, never values.
- Module subprocesses use detached process groups for signal
  isolation. The daemon gets the `PR_SET_PDEATHSIG` upgrade on
  Linux in this phase. Orphan-sweep-on-spawn complements it on
  macOS.
- The socket is `0600` and `.rn-dev/` is `0700` from 13.1 — do not
  regress these when adding `session/*` dispatch; any relaxation
  makes `daemon/shutdown` a local DoS.
- `daemon/error` is the envelope shape for unknown actions. When
  adding new RPCs, return structured `{code, ...}` payloads for
  failure cases, not the ad-hoc shapes older code used.

## The rest of the Phase 13 arc

- **13.3 TUI migrates** — `start-flow.ts` flips to `connectToDaemon`.
  Proves the client pattern before the bigger Electron surface.
  Merge gate: test **#4** (session survives client churn).
- **13.4 Electron migrates** — all `ipcMain` handlers under
  `electron/ipc/` become `IpcClient` proxies to the daemon.
  `electron/module-system-bootstrap.ts` deleted. Renderer surface
  unchanged. Merge gate: test **#5** (GUI-quit / MCP-survive) +
  all existing 70+ Electron integration tests still pass.
- **13.5 (stretch)** — MCP ergonomics: MCP server uses
  `connectToDaemon` client-side; active-daemon registry at
  `~/.rn-dev/registry.json`; consolidate error shapes.
