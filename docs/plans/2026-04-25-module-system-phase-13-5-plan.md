# Phase 13.5 — Multi-client daemon foundation

**Goal:** put the daemon on a foundation where TUI, Electron, and MCP can
all attach to one daemon at once and operate cleanly. Today only one
client at a time is safe — the second connector either kills the first's
session (`session/stop` is the only teardown path) or is rejected with
`MULTI_INSTANCE_NOT_SUPPORTED`.

This plan was derived from the next-session prompt at
[2026-04-25-next-session-prompt-phase-13-5.md](2026-04-25-next-session-prompt-phase-13-5.md)
but **reorders** the items by dependency rather than by item-number, so
the foundation is built before the consumers that depend on it.

## Baselines (post-Phase 13.4.1 + post-fix bundle)

- vitest: **942 / 0**
- tsc root: **149** (pre-existing wizard errors)
- tsc electron: **0**
- `bun run build`: green
- `npx playwright test`: **10 / 0**

Every PR in this phase must match or improve on each baseline before
merge.

## Dependency graph

```
PR-A  ref-counted sessions  ──┐
                              ├──► PR-C  MCP → daemon-client flip
PR-B  active-daemon registry ─┘
                              │
PR-D  sender binding for      │
       modules/host-call ─────┘
                              │
PR-E  packaged Electron       │
       daemon entry           ▼  (orthogonal — landed after C is fine)
```

`PR-A` is the keystone — every multi-client story depends on the
daemon being able to hold a session open across overlapping client
lifetimes.

`PR-B` is independent of `PR-A` mechanically but useful only once
multi-client is supported (otherwise the registry has nothing to point
multiple clients at).

`PR-C` flips the MCP server, which is the third client and the one
currently most divergent (it owns its own `ModuleHostManager` +
`ModuleRegistry`, doesn't carry a `DaemonSession`).

`PR-D` is a security gate that becomes load-bearing once `PR-C` lands —
multiple clients sharing one daemon means same-UID trust isn't enough
to identify which `moduleId` a host-call is impersonating.

`PR-E` is orthogonal but easy to fold in once the rest of the daemon
client surface is settled.

The `instance:retryStep` daemon RPC (item 1 in the next-session prompt)
is **not** part of Phase 13.5 — it's a renderer UX fix orthogonal to
multi-client. It'll go after this phase wraps. Same for the deferred
follow-ups list in the prompt.

## PR-A — Ref-counted daemon sessions

**Problem:** today the daemon holds one supervisor per worktree, and
`session/stop` is the only teardown path. A second client connecting
to the daemon either:
- Calls `session/start` → gets `E_SESSION_ALREADY_RUNNING`.
- Calls `session/stop` → kills the first client's services.

Electron's `instances:create` papers over this with the
`MULTI_INSTANCE_NOT_SUPPORTED` user-visible error. That isn't a
foundation, it's a sign saying "go away."

**Design:**

1. **Per-connection identity in `IpcServer`.** Today
   `IpcMessageEvent` exposes `{ message, reply, onClose }` per message
   but no stable id for the underlying socket. Add a stable
   `connectionId: string` (uuid or `pid-counter`) created at
   `net.createServer` callback time and surfaced on every
   `IpcMessageEvent` for that socket. The existing `onClose` is already
   per-socket (closeListeners is bound at connection-callback scope) —
   we just expose the socket's identity alongside.

2. **Supervisor-level attach/release.** Add
   `attach(connectionId): AttachResult` and
   `release(connectionId): void` to `DaemonSupervisor`. Internal state:
   - `attached: Set<connectionId>` of currently-attached connections.
   - First `attach` while `status === "stopped"` boots the session
     (existing `start()` semantics).
   - Subsequent `attach`s while `status` is `starting | running` add
     the conn to the set and return the current state.
   - `release(connId)` removes from set; if set is empty, `stop()`.
   - Socket-close path on the daemon-side dispatcher calls `release`
     unconditionally (idempotent).

3. **Wire protocol:**
   - `session/start` keeps its existing payload `{ profile }` semantics
     for the FIRST attaching client. For subsequent clients, the
     payload is optional; if present, it must match the active profile
     (else `E_PROFILE_MISMATCH`). This preserves the existing TUI's
     "I'll start the session and tell you my profile" flow without
     forcing every later attacher to re-send the profile.
   - **New action `session/release`** — explicit detach without
     teardown. No payload. Always returns `{ ok: true }` (idempotent).
   - `session/stop` semantics unchanged — kill-for-everyone, kept for
     the CLI `daemon-shutdown` and explicit "stop the session" flows
     (e.g. TUI's quit menu). Empties the attached set as a side
     effect.

4. **Client-side `DaemonSession.release()`.** Replaces
   `disconnect()` for the multi-client case. `disconnect()` stays
   (closes the local socket without telling the daemon), but
   `release()` sends `session/release` first then closes. The
   distinction matters: a Node process being killed mid-flight will
   trigger the daemon's socket-close auto-release, but a graceful
   client should send `release` first so the daemon's audit log
   captures the intent.

5. **`instances:create` simplification (Electron).** Replace the
   `MULTI_INSTANCE_NOT_SUPPORTED` branch with an `attachDaemonSession`
   call against the new profile. The first instance still triggers
   the existing `attachDaemonSession` path. Multi-profile attach is a
   future story — this PR only enables "two clients on the same
   profile."

**Tests:**
- Unit: `DaemonSupervisor.attach`/`release` state-machine — empty,
  one, two, release one (stays running), release last (transitions
  to stopping → stopped).
- Integration #6: two `connectToDaemonSession` clients against one
  daemon, first calls `release()`, second still operates + receives
  events.
- Integration #7: socket-drop auto-release — kill the first client
  process, second observes session stays running.

**Files:**
- `src/core/ipc.ts` — add `connectionId` to `IpcMessageEvent`.
- `src/daemon/supervisor.ts` — `attach`/`release`/refcount.
- `src/daemon/index.ts` — wire `session/release` action + socket-close
  auto-release in the message dispatcher.
- `src/app/client/session.ts` — `release()` method on `DaemonSession`.
- `electron/ipc/instance.ts` — drop `MULTI_INSTANCE_NOT_SUPPORTED`.
- `src/daemon/__tests__/supervisor-refcount.test.ts` — new unit tests.
- `src/app/client/__tests__/session-release.test.ts` — integration #6.

**Merge gate:** integration #6 + #7 green; `instances:create` no longer
returns `MULTI_INSTANCE_NOT_SUPPORTED`.

## PR-B — Active-daemon registry

**Problem:** MCP and other clients today have no way to discover which
daemons are running. They scan `<worktree>/.rn-dev/sock` paths they
already know about. For a future "MCP attaches to whichever daemon is
running this project" UX, we need a global registry.

**Design:**

1. `~/.rn-dev/registry.json` — JSON object `{ daemons: Record<worktree, DaemonRegistration> }`.
   `DaemonRegistration: { pid, sockPath, since: ISO8601, hostVersion }`.
2. Daemon writes its entry at boot (after lock acquisition + socket
   bind). Removes its entry on graceful `shutdown()`.
3. Stale-entry sweep at boot: any registration whose pid is not alive
   gets removed before we add ours.
4. New helper: `findActiveDaemons(): DaemonRegistration[]` (reads +
   filters live entries via `kill(pid, 0)`).
5. File mode 0o600 (single-user). Same atomic-write pattern as
   `ModuleLockfile`.

**Tests:**
- Boot/shutdown roundtrip writes + removes entry.
- Crash simulation: write entry, exit without cleanup, verify next
  boot's stale-sweep removes it.
- `findActiveDaemons` filters by liveness.

**Files:**
- `src/daemon/registry.ts` — new module.
- `src/daemon/index.ts` — wire register/unregister into boot/shutdown.
- `src/daemon/__tests__/registry.test.ts` — new tests.

**Merge gate:** stale entries don't accumulate after 100 simulated
crashes (test).

## PR-D — Daemon-side sender binding for `modules/host-call`

**Problem:** `src/app/modules-ipc.ts::hostCall` accepts `moduleId` from
the payload and trusts the caller. With one client per daemon this was
fine (the caller is the daemon's panel-bridge, which knows its own
module identity). With multiple clients sharing a daemon, any client
can impersonate any module's host-call.

**Design:**

1. Per-connection module-binding table in the daemon: `Map<connectionId, Set<moduleId>>`.
2. New action `modules/bind-sender { moduleId }`. Adds `moduleId` to
   the connection's allowed set. Idempotent. Fails with
   `E_MODULE_NOT_REGISTERED` if the module isn't in the registry.
3. `hostCall` reads `connectionId` (now available via PR-A's
   `IpcMessageEvent` extension), checks that `payload.moduleId` is in
   the connection's allowed set. If not, return `MODULE_UNAVAILABLE`
   with audit-log outcome `denied`.
4. Socket-close clears the binding table entry.

The existing Electron-side panel-sender-registry stays as a
defense-in-depth check; this adds the daemon-side enforcement so the
TUI / MCP / future clients also benefit.

**Tests:**
- Unbound conn calling `hostCall` → `denied`.
- Bound conn calling for a different module → `denied`.
- Bound conn calling its own module → `ok`.
- Socket close clears bindings (next conn from same UID can't
  inherit them).

**Files:**
- `src/daemon/sender-bindings.ts` — new module.
- `src/app/modules-ipc.ts::hostCall` — gate by binding table.
- `src/daemon/index.ts` — wire bind action + socket-close cleanup.
- `src/app/modules-ipc.test.ts` — extend.

**Merge gate:** unauthorized host-call rejected with denied outcome
in audit log.

## PR-C — MCP server flipped to daemon client

**Problem:** `src/mcp/server.ts` builds an `McpContext` whose
`ipcClient` field talks to the daemon for module-tool discovery only.
It doesn't own a `DaemonSession`. So the MCP server can't:
- Receive session events (metro/log, devtools/delta, modules/crashed).
- Drive a `metro/reload` against the live session (it goes through
  the IPC client raw, fine for Phase 9 but not aligned with the
  daemon-client substrate).
- Use `ModuleHostClient` for typed `host-call` (the new typed
  surface introduced in Phase 13.4.1).

**Design:**

1. Replace MCP startup's manual `IpcClient` construction with
   `connectToDaemonSession(projectRoot, profile)` — the same call TUI
   and Electron use.
2. The MCP context holds the resulting `DaemonSession`; tool handlers
   that need typed RPC go through the adapters
   (`session.metro.reload(...)` etc.) rather than building raw
   `IpcMessage` payloads.
3. MCP profile resolution: existing default-profile picker keeps
   working; if no profile is registered, the MCP server fails
   gracefully with a clear error rather than silently running
   without a session.
4. `session.release()` on MCP shutdown (signal handler).
5. `bind-sender` for any module-tool the MCP server will proxy
   (uses the moduleId from the proxy table).

**Tests:**
- MCP starts, connects to a fake-boot daemon, lists tools, calls a
  built-in tool, calls a module tool via host-call, releases.
- MCP signal-shutdown releases the session (daemon stays alive for
  other clients via PR-A's auto-release).

**Files:**
- `src/mcp/server.ts` — startup flow.
- `src/mcp/tools.ts` — handlers that need typed adapters.
- `src/mcp/module-proxy.ts` — bind-sender wiring.
- `src/mcp/__tests__/daemon-client.test.ts` — new integration test.

**Merge gate:** existing MCP smoke tests pass; new test confirms
MCP-as-daemon-client end-to-end.

## PR-E — Packaged-Electron daemon entry

**Problem:** `electron/daemon-connect.ts::resolveDaemonEntry` still
throws under `app.isPackaged`. Production Electron builds can't spawn
the daemon.

**Design:**

1. `app.asar/dist/index.js` is the CLI entry in packaged mode.
2. Resolve from `app.getAppPath()` + `dist/index.js` when
   `app.isPackaged` is true.
3. Confirm `pickDaemonInterpreter` picks `node` for the packaged path
   (it's `.js`, and `process.execPath` is the Electron binary, so
   the `isElectron` branch in `pickDaemonInterpreter` already returns
   `"node"`).
4. **Caveat:** the bundled Electron app may not ship with a `node`
   binary on the host — we may need to bundle one or shell out via
   the user's PATH. Initial implementation: PATH `node` with a clear
   error if missing; track bundling as a follow-up.

**Tests:**
- Unit test for `resolveDaemonEntry` under `app.isPackaged` flag.
- Manual smoke: `npm run dist` → launch packaged app → verify daemon
  spawns. Document the steps; add to PR description.

**Files:**
- `electron/daemon-connect.ts` — `resolveDaemonEntry` body.
- `electron/__tests__/daemon-connect.test.ts` — extend.

**Merge gate:** `resolveDaemonEntry` returns a path under `app.asar`
when packaged; existing dev path unchanged.

## Out of scope this phase

Everything in the next-session prompt's "Deferred follow-ups" list and
any optional UX items (item 7 — section start/end events, optional;
item 1 — `instance:retryStep` daemon RPC, separate). The retryStep
work is logically the start of Phase 13.6 once the multi-client
foundation is solid.

## Per-PR workflow

Each PR follows the project's established autonomous merge pattern:

1. Implement on `feat/module-system-phase-13-5-<letter>`.
2. Run all three verification layers (vitest + tsc x2 + playwright).
3. Push branch, open PR.
4. Spawn 4 parallel reviewers via Task agents (Kieran TS,
   Architecture, Security, Simplicity).
5. Apply P0/P1 in-branch.
6. Squash-merge to main.
7. Persist a one-line memory update + write a per-PR handoff doc.
8. Move on.

`feat/module-system-phase-13-5` is a holding branch — actual work
happens on per-PR sub-branches off main.

## Verification checklist

Before declaring this phase complete:

- [ ] PR-A merged: refcount tests green, `instances:create` no longer
      returns `MULTI_INSTANCE_NOT_SUPPORTED`.
- [ ] PR-B merged: registry round-trip + stale-sweep tests green.
- [ ] PR-D merged: unauthorized host-call rejected in audit log.
- [ ] PR-C merged: MCP integration test confirms daemon-client flow.
- [ ] PR-E merged: packaged-daemon-entry resolves correctly.
- [ ] All three layers green at end of phase: vitest, tsc, playwright.
- [ ] Phase 13.5 handoff doc written.
- [ ] Phase 13.6 next-session prompt queued with item 1
      (`instance:retryStep`) + remaining deferred follow-ups.
