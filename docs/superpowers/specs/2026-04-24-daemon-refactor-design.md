# Daemon Refactor — Design Spec

**Status**: approved for implementation-plan phase.
**Related plans**: [2026-04-21-feat-module-system-and-device-control-plan.md](../../plans/2026-04-21-feat-module-system-and-device-control-plan.md) (overall module-system plan; Section 2 of the Revision Log states the intended topology: "ModuleHostManager runs in the long-lived daemon process — same process owning MetroManager/DevToolsManager. GUI and MCP modes share one process topology — Electron main is a client over IPC, MCP is a client over stdio.")
**Target**: Phase 13.1 – 13.4 (+ 13.5 stretch).

## Problem

The stated module-system topology is "daemon process owns all services; GUI, TUI, and MCP are all clients." The shipped implementation doesn't match that.

Today:

- **TUI path** (`src/app/start-flow.ts::startServicesAsync`) — does it right. Creates `MetroManager` + `DevToolsManager` + `ModuleHostManager` + `IpcServer` listening at `<project>/.rn-dev/sock`. Clients (including the in-process TUI itself and external MCP/CLI) talk to the socket.
- **Electron path** (`electron/ipc/services.ts:241`, `electron/ipc/devtools.ts:28`, `electron/module-system-bootstrap.ts`) — re-implements service orchestration inline, **with no `IpcServer`**. Electron main hosts the services in-process. Renderer talks to them via Electron's built-in `ipcMain`/`ipcRenderer`. MCP and CLI can't see the session.

Concrete consequence: while an Electron dev session is running against a RN app, agents connected via MCP see `{error: "no-session"}` — even though the GUI is actively capturing logs and network activity. This contradicts the agent-native contract.

A second symptom is the `dev:gui` startup flow (`concurrently npm run dev:renderer npm run dev:electron`) — a temporary workaround for the dual-path architecture. Unifying under a real daemon removes the need for the concurrent-process dance.

## Goals

1. **One code path** for session orchestration. All three surfaces (GUI, TUI, MCP) go through the same daemon → socket → client contract. No reimplementation, no two sources of truth, no drift.
2. **Session durability** independent of GUI lifetime. Agents running long-lived tasks survive GUI restarts; reopening the GUI attaches to the same running daemon.
3. **Multi-worktree parallelism** preserved. Real dev workflow involves `main` + a feature branch + an agent's branch simultaneously. Each gets its own daemon, fully isolated.
4. **Agent-native parity.** Any action the GUI can take, the MCP can take. No state the GUI can see that the MCP can't.

## Non-goals

- Remote daemon (daemon on machine A, client on machine B). Unix-domain sockets are local-only by design.
- `launchd` / `systemd` auto-start across reboots. Spawn is explicit-on-first-client-connect.
- Cross-worktree supervisor daemon. Each worktree runs its own independent daemon.
- Windows support. Unix-only for now.
- Backwards compatibility with the `no-session` / `list-sessions` shapes or pre-refactor Electron IPC. Nothing is in use externally yet; free hand.

## Architecture

### Topology

```
┌──────────────────────────────────────────────────────────────┐
│   rn-dev daemon <worktree>  (detached, per-worktree process) │
│                                                              │
│  MetroManager  DevToolsManager  ModuleHostManager            │
│         │           │                    │                   │
│         └───────────┴────────────────────┘                   │
│                      │                                       │
│              serviceBus (pub-sub)                            │
│                      │                                       │
│              IpcServer listening at                          │
│              <worktree-root>/.rn-dev/sock                    │
└──────────────────────────────────────────────────────────────┘
                       │ UDS
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
 Electron renderer  TUI process    MCP server
 (via ipcMain →     (direct        (invoked by
  IpcClient)         IpcClient)     Claude Code)
```

Each live worktree has exactly one daemon. Each daemon has exactly one socket at `<worktree-root>/.rn-dev/sock`. Clients locate the socket by convention (worktree path) or by the `RN_DEV_DAEMON_SOCK` env var.

### Daemon lifecycle

Spawn is **lazy on first client connect**. Sequence:

1. Client wants to talk to a worktree. Calls the shared `connectToDaemon(worktree)` primitive.
2. Primitive checks liveness: is `<worktree>/.rn-dev/pid` present and the pid still alive, and is the socket reachable?
3. **Happy path** (daemon live) — connect and return `IpcClient`.
4. **Cold path** (stale or missing) — unlink stale pid + sock (best-effort), then `spawnDetachedDaemon(worktree)` (standard `fork + setsid + chdir + close stdio`), then `waitForSocket(path, 5s)`, then connect.

Spawn uses **exclusive flock** on the pid file to arbitrate concurrent spawn attempts. Same pattern as `src/core/module-host/lockfile.ts`. If two clients race, the losing daemon exits silently; both clients connect to the winner's socket.

Daemon maintains **client-connection refcount**. When `refcount === 0`, a **60s grace timer** starts. New connection within grace → timer cancelled. Timer expires → daemon runs graceful shutdown (stop Metro, stop DevTools, unload modules, unlink pid + sock, `exit(0)`).

Daemon survives client exit by design. Electron quit → agent keeps working. Agent disconnect → GUI keeps running. Last one leaves → daemon schedules graceful shutdown.

### Wire protocol

New RPCs the daemon adds:

| Method | Purpose |
|---|---|
| `daemon/ping` | Liveness + version handshake. Client sends `{clientVersion}`; server responds `{daemonVersion, hostRange}`. Used on connect for version compat check. |
| `daemon/shutdown` | Graceful exit request. Used by the 60s-grace supervisor and by `rn-dev daemon-stop`. |
| `session/start` | Boot `MetroManager` + `DevToolsManager` + `ModuleHostManager` for this worktree with the given profile. Returns immediately with `{status: "starting"}`. |
| `session/stop` | Graceful service teardown. Daemon stays alive. |
| `session/status` | Current lifecycle state + service summary. |
| `events/subscribe` | Server-streaming: per-connection long-lived stream of lifecycle events (metro stdout/stderr, metro status, devtools capture, module state transitions, config changes). |

All existing RPCs — `modules/*`, `metro-logs/*`, `devtools-network/*`, `metro/*`, `devtools/*`, `marketplace/*` — keep their current shapes. They already expect to live behind the socket.

Event subscription uses a single bidirectional stream per client. Events are tagged-union envelopes: `{ kind, worktreeKey, data }`. Daemon fan-outs once per event; clients filter client-side. Matches the in-process `serviceBus` pattern verbatim — this just exposes it over the wire.

### Version handshake

Client on first RPC after connect sends `daemon/ping { clientVersion }`. Daemon replies `{ daemonVersion, hostRange }`. Client checks: if client isn't inside `hostRange`, client surfaces `"daemon version <daemonVersion> is incompatible with client <clientVersion>; run `rn-dev daemon-restart <worktree>` to upgrade"` and refuses further RPCs. Same `hostRange` semantics we already use for module manifests — one pattern, one implementation.

### Clients are thin

- **Electron main** — ipcMain handlers become `IpcClient` proxies. Renderer's `ipcRenderer.invoke(...)` surface is unchanged; the handlers under it just forward to the daemon's socket and stream events back via ipcMain push.
- **TUI** — `src/app/start-flow.ts` becomes a client. Instead of booting services in-process, it calls `connectToDaemon(worktree)` + `session/start`, then subscribes to events for the curses UI.
- **MCP server** — already a client (today it connects to the socket). Gains the `connectToDaemon` primitive (auto-spawn instead of failing with `no-session`).

No service creation anywhere outside `src/daemon/`. Searchable contract: `grep -r "new MetroManager"` should only match daemon code after the refactor.

## Component layout

```
src/daemon/
├── index.ts           # daemon entry. fork+setsid, flock pid, spawn services, listen, SIGTERM handler
├── supervisor.ts      # drives startServicesAsync-equivalent; manages session/start|stop|status state
├── session.ts         # per-daemon session model (starting|running|stopping|stopped)
├── spawn.ts           # CLIENT-side primitive: connectToDaemon(worktree) → IpcClient, auto-spawns if needed
└── __tests__/         # the 5 integration tests (see Testing)

src/cli/commands.ts    # add "rn-dev daemon <worktree>" (hidden; infra command, not user-facing)
```

`spawn.ts` is shared by all three clients. Example shape:

```ts
export async function connectToDaemon(worktree: string): Promise<IpcClient> {
  const sockPath = path.join(worktree, ".rn-dev", "sock");
  const pidPath = path.join(worktree, ".rn-dev", "pid");

  if (await isDaemonAlive(pidPath, sockPath)) {
    return new IpcClient(sockPath);
  }
  await unlinkStale([sockPath, pidPath]);
  await spawnDetachedDaemon(worktree);        // fork+setsid+chdir+close stdio
  await waitForSocket(sockPath, { timeoutMs: 5000, pollMs: 100 });
  return new IpcClient(sockPath);
}
```

## Migration sequence

Four PRs, each independently mergeable, each with a named integration test as the merge gate. Tree stays green throughout.

### Phase 13.1 — Daemon binary + lifecycle primitives

- New: `src/daemon/{index.ts, supervisor.ts, session.ts, spawn.ts}`.
- New CLI command: `rn-dev daemon <worktree>` (hidden from help).
- Daemon can boot, open socket, respond to `daemon/ping` + `daemon/shutdown`. **No sessions yet**.
- Nothing in the existing tree uses the daemon. Fully additive.
- **Merge gate**: integration tests **#1** (daemon lifecycle) + **#2** (second-spawn detection) pass.

### Phase 13.2 — Services move into the daemon

- Refactor `src/app/start-flow.ts::startServicesAsync` → pure "boot session services" function callable by the daemon.
- Daemon's supervisor implements `session/start`, `session/stop`, `session/status`, `events/subscribe`.
- TUI + Electron + MCP still use their existing paths. No user-visible change.
- **Merge gate**: integration test **#3** (session boot end-to-end with fixture) passes.

### Phase 13.3 — TUI migrates to the daemon

- `src/app/start-flow.ts` becomes a client: `connectToDaemon(worktree)` → `session/start` → subscribes to events.
- The in-process boot logic moved in 13.2; this PR just flips the TUI from direct-call to IpcClient.
- Proves the client pattern works before Electron (bigger, riskier) surface.
- **Merge gate**: integration test **#4** (session survives client churn) passes.

### Phase 13.4 — Electron migrates to thin clients

- `electron/ipc/{services,devtools,modules*,instance}.ts` handlers become `IpcClient` proxies to the daemon.
- `electron/module-system-bootstrap.ts` deleted.
- Electron renderer's ipcRenderer surface unchanged — renderer doesn't know about the refactor.
- Wizard's "Start" → ipcMain handler in Electron main → `connectToDaemon` → `session/start` → streams events back to renderer via ipcMain push.
- **Merge gate**: integration test **#5** (GUI-quit / MCP-survive) + all existing 70+ Electron integration tests pass.

### Phase 13.5 (stretch) — MCP ergonomics

- MCP server uses `connectToDaemon` client-side (auto-spawn if socket missing, instead of failing with `no-session`).
- Active-daemon registry at `~/.rn-dev/registry.json` so MCP can enumerate live worktrees.
- Consolidate error shapes (the pre-existing `no-session` / `not-running` / `No running session` inconsistency).
- Polish; not required for the architecture.

## Testing strategy

**TDD discipline**: every phase's named integration test is written in the first commit and failing. Implementation commits follow until green. No phase merges until its test passes.

Five load-bearing integration tests, each executing against a real daemon process and a real client — no mocks at the IPC boundary:

### #1. Daemon lifecycle

- Spawn `rn-dev daemon <fixture>` directly.
- Assert `<fixture>/.rn-dev/sock` and `.rn-dev/pid` appear within 5s.
- Send `daemon/ping` → assert `{daemonVersion, hostRange}` response.
- `SIGTERM` → assert `sock` and `pid` files unlinked + exit code 0.

### #2. Second-spawn detection

- Spawn daemon A → wait for ready.
- Attempt to spawn daemon B on the same worktree.
- Assert B exits silently (non-zero exit, error to stderr along the lines of "already running, pid=N"), A unaffected.
- Verify pid file still references A.

### #3. Session boot end-to-end

- Spawn daemon → connect client.
- Send `session/start` with a minimal profile against `test/fixtures/minimal-rn`.
- Subscribe to `events/*` → assert `metro/status: starting` then `metro/status: running` events arrive.
- `session/status` returns `{status: "running", services: {...}}`.
- Tear down: `session/stop` → `metro/status: stopped` event → daemon still alive.

### #4. Session survives client churn

- Start daemon via client A → `session/start`.
- Disconnect client A.
- Before 60s grace expires, connect client B.
- B sees the same running session with consistent state (`session/status` matches what A saw).
- Reconnect A → both clients see consistent state, events fan out to both.
- **This is the test that justifies C-per-worktree over B-in-Electron**. If it passes, session durability works.

### #5. GUI-quit / MCP-survive

- Real Electron + real MCP + real daemon against a real fixture.
- Start session via Electron GUI.
- Connect MCP client → read `metro-logs__list` → assert entries returned.
- Quit Electron.
- MCP continues reading `metro-logs__list` (no error, no `no-session`).
- Re-launch Electron → it attaches to the same daemon and shows the same session state.
- **The killer test**. If this passes, the architecture works.

### Regression suite

Every existing Electron integration test (70+) continues to pass, re-pointed at the thin-client implementation. Anything that breaks is a behavior regression we must defend.

### Test infrastructure

- `test/fixtures/minimal-rn/` — stub React Native project (`package.json`, Metro config, empty entry file) that lets `metro start` succeed without actual bundling.
- Helper `spawnTestDaemon(fixture) → { client, stop }` used by all 5 tests.
- `afterEach` cleanup: every test un-spawns daemons + unlinks sockets so zombie processes don't leak.

## Error handling and edge cases

**Stale socket / dead daemon.** Connect fails → inspect pid file → pid missing OR `kill -0 <pid>` fails → unlink stale `sock` + `pid` → respawn. Happy path unchanged.

**Concurrent spawn race.** Daemon acquires `flock(pid_file, LOCK_EX)` early in startup. Losing daemon exits silently. Winner completes pid-write + socket-listen. Both clients connect to winner. Reuse `src/core/module-host/lockfile.ts` pattern.

**Daemon crash mid-session.** Services die with daemon. Next client spawn gets a fresh daemon. Client surfaces `"connection lost; restart session? (y/n)"`. Session config re-applied from profile file.

**Orphaned module subprocesses on ungraceful daemon death.** Modules use detached process groups for signal isolation, so SIGKILL'ing the daemon leaks them. Two stacked mitigations:

1. **Linux `prctl(PR_SET_PDEATHSIG, SIGKILL)`** on module spawn — module dies automatically on daemon death. No macOS equivalent; practical impact bounded (dev machine, not server).
2. **Startup sweep.** New daemon on boot scans `~/.rn-dev/modules/<id>/pid` for dead-daemon orphans and kills them. Same sweep pattern planned for deferred Phase 12 Option B (`keepData` GC).

**Audit log concurrent writes.** `~/.rn-dev/audit.log` is HMAC-chained and append-only. With N per-worktree daemons, concurrent appends break the HMAC chain. Fix: wrap `AuditLog.append()` with `flock(audit.log, LOCK_EX)` around the `{read-last-hmac, compute-new, append, fsync}` critical section. Cross-process on macOS + Linux. Performance fine — audit writes are rare and tiny.

**Version mismatch.** On first RPC after connect, client sends `daemon/ping {clientVersion}`. Daemon replies `{daemonVersion, hostRange}`. Client checks: if incompatible, refuse further RPCs and surface upgrade instruction.

**Daemon log destination.** Detached daemon has closed stdio. Logs go to `<worktree>/.rn-dev/daemon.log`, rolling with size cap (e.g. 10MB × 3 files). Debug path: `rn-dev daemon <worktree> --foreground` keeps stdio open.

**Socket permissions.** `chmod 0600` on socket file at creation. Owner-only read/write. Blocks cross-user attacks on shared machines.

**Profile updates mid-session.** Daemon snapshots the profile at `session/start`; mid-flight edits are ignored. `session/stop` + `session/start` to pick up changes. Avoids hot-reload complexity.

**Multi-window Electron.** Second window targeting the same worktree → second ipcMain handler calls `connectToDaemon` → pid-arbitration resolves → both windows attach to the one daemon. N windows, N clients, 1 daemon, 1 session. Zero duplication.

## Open questions (resolve in implementation)

- `waitForSocket` poll cadence: default 100ms / 5s cap; revisit if chatty in practice.
- Daemon log rotation: pick a library (e.g. `pino` roll-file) vs. hand-rolled.
- `daemon/ping` rate for keep-alive: initial version assumes TCP-style "socket stays open" without periodic pings. Revisit if connection-drop detection needs shortening.

## Success criteria

The refactor is done when:

1. `grep -rn "new MetroManager\|new DevToolsManager\|createModuleSystem" src/ electron/ --include='*.ts'` returns matches only inside `src/daemon/` (and tests).
2. All 5 integration tests pass.
3. All 70+ existing Electron integration tests still pass.
4. Running `claude mcp add rn-dev -- /path/to/dist/index.js mcp` and using the tools from Claude Code against a GUI session returns real data (not `no-session`).
5. Killing the Electron process while an agent is mid-RPC does not disconnect the agent.
6. Relaunching Electron after killing it attaches to the same session, same state.
