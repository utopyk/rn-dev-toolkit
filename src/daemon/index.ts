import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  IpcServer,
  type IpcMessage,
  type IpcMessageEvent,
} from "../core/ipc.js";
import { ModuleLockfile } from "../core/module-host/lockfile.js";
import {
  DaemonSupervisor,
  type SessionBootFn,
  type SessionEntry,
} from "./supervisor.js";
import { bootSessionServices } from "../core/session/boot.js";
import { fakeBootSessionServices } from "./fake-boot.js";
import { spawnDetachedDaemon } from "./spawn.js";
import { sweepOrphanModules } from "./orphan-sweep.js";
import { sweepOrphanHooks } from "./hook-orphan-sweep.js";
import { registerDaemon, unregisterDaemon } from "./registry.js";
import { validateProfile, type ValidatedProfile } from "./profile-guard.js";
import type { SessionEvent } from "./session.js";
import { handleClientRpc, isClientRpcAction } from "./client-rpcs.js";
import { MODULES_ACTIONS } from "../app/modules-ipc.js";
import {
  SubscribeRegistry,
  parseKinds,
  matchesKindFilter,
} from "./subscribe-registry.js";
import { DAEMON_VERSION, HOST_RANGE } from "./version.js";
import {
  generateSessionId,
  type SessionId,
} from "../core/identifiers.js";
import {
  optionalSessionId,
  parseEventsSubscribeInput,
  RpcArgError,
} from "./rpc-args.js";
import type { SessionAmbiguousData } from "./error-codes.js";

// ---------------------------------------------------------------------------
// Daemon entry for `rn-dev daemon <worktree>`.
//
// Phase 13.1 shipped lifecycle primitives (pid arbitration, socket listen,
// daemon/ping, daemon/shutdown). Phase 13.2 moves services into the
// daemon via DaemonSupervisor and adds the session/* + events/subscribe
// RPCs. TUI + Electron + MCP continue with their existing in-process
// paths until 13.3 / 13.4 flip them to clients.
//
// The daemon detaches from its parent by default via a self-respawn:
//   `rn-dev daemon <wt>` (no flag)  → fork a child with `--foreground`,
//                                     detached + stdio:ignore, then exit 0.
//   `rn-dev daemon <wt> --foreground` → stay attached and run the loop
//                                       in-process. Used by tests and by
//                                       operators debugging the daemon.
//
// Security posture (RPC authorization = filesystem permissions):
//   - <worktree>/.rn-dev/     directory is 0o700 (owner-only)
//   - <worktree>/.rn-dev/sock socket is 0o600 at creation (umask gate)
//   - <worktree>/.rn-dev/pid  lockfile is chmod'd 0o600 after write
// Relax any of these and daemon/shutdown becomes a trivial local DoS —
// there is no SO_PEERCRED check in v1. Keep them tight.
// ---------------------------------------------------------------------------

// Phase 13.6 PR-C — actions always permitted on a subscribe socket,
// even without `supportsBidirectionalRpc`. Pre-dispatch check in
// handleMessage uses this set. Declared at module scope so it is
// allocated once, not reconstructed on every message.
const SUBSCRIBE_ALWAYS_ALLOWED = new Set<string>([
  "events/subscribe", // re-subscribe: rejected separately in Task 1.5,
  //                     but this gate must skip it so the re-subscribe
  //                     path runs and replies.
  "daemon/ping",
  // daemon/shutdown is intentionally NOT in SUBSCRIBE_ALWAYS_ALLOWED —
  // see SUBSCRIBE_NEVER_ALLOWED below. Allowing it here would bypass
  // the never-allow guard and let subscribe sockets issue shutdown.
]);

// P1-7 — actions NEVER permitted on ANY subscribe socket, including
// bidirectional ones. Single declarative source of truth. The pre-dispatch
// guard in handleMessage checks this before the bidirectional gate, so both
// gated (bidirectional) and ungated (non-bidirectional) subscribe sockets
// are covered without per-case rejection branches in the switch.
//
// daemon/shutdown: a subscribe socket is a long-lived fan-out channel; it
//   must not be able to nuke the daemon — the risk of an accidental or
//   malicious shutdown is too high. Plain RPC connections can still call it.
// session/start: still kept off subscribe sockets — bidirectional or not,
//   booting a second session over an existing subscribe channel mixes
//   refcounts in confusing ways. The canonical path is
//   `events/subscribe { profile }` (boot-or-join) on a fresh socket.
const SUBSCRIBE_NEVER_ALLOWED = new Set<string>([
  "daemon/shutdown",
  "session/start",
]);

export interface RunDaemonOptions {
  worktree: string;
  foreground?: boolean;
  /**
   * Optional absolute path to the CLI entry used when detaching via
   * self-respawn. Threading this explicitly lets callers in packaged
   * environments (Electron, bundled binaries) override `process.argv[1]`
   * which otherwise points at the host bundle, not the CLI.
   */
  daemonEntry?: string;
}

export async function runDaemon(opts: RunDaemonOptions): Promise<void> {
  const worktree = resolve(opts.worktree);
  const foreground = opts.foreground === true;

  if (!foreground) {
    detachAndExit(worktree, opts.daemonEntry);
    return;
  }

  const rnDevDir = join(worktree, ".rn-dev");
  // 0o700 owner-only. If the dir already exists (common — the wizard
  // writes profiles here first), re-chmod to tighten permissions.
  mkdirSync(rnDevDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(rnDevDir, 0o700);
  } catch {
    // Unusual but not fatal on odd filesystems; socket/pid file modes
    // below are the second line of defense.
  }

  const pidPath = join(rnDevDir, "pid");
  const sockPath = join(rnDevDir, "sock");

  const lock = new ModuleLockfile(pidPath);
  const acquisition = lock.acquire({
    pid: process.pid,
    uid: process.getuid?.() ?? 0,
    socketPath: sockPath,
  });
  if (acquisition.kind === "held-by-other") {
    process.stderr.write(
      `rn-dev daemon: already running, pid=${acquisition.holder.pid}\n`,
    );
    process.exit(1);
  }
  // Lock file shouldn't be world-readable — pid + uid + socketPath leak
  // daemon topology to other local users.
  try {
    chmodSync(pidPath, 0o600);
  } catch {
    /* best-effort — ModuleLockfile.writeFileSync doesn't take a mode. */
  }

  // Orphan module sweep — kill module subprocesses whose parent daemon
  // crashed (PPID=1 → init reaped them). Runs after lock acquisition so
  // we can trust that no live daemon is still spawning modules into the
  // tree. The kill is POSIX-only; see src/daemon/orphan-sweep.ts for
  // platform notes.
  try {
    const sweep = sweepOrphanModules({
      log: (line) => process.stdout.write(`${line}\n`),
    });
    if (sweep.killed > 0) {
      process.stdout.write(
        `rn-dev daemon: orphan-sweep cleared ${sweep.killed} module${sweep.killed === 1 ? "" : "s"} (${sweep.cleared.join(", ")})\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `rn-dev daemon: orphan-sweep failed (${err instanceof Error ? err.message : String(err)}) — continuing\n`,
    );
  }

  // Hook orphan sweep — kill hook subprocess groups whose owning daemon
  // crashed mid-fire. Mirrors module orphan-sweep position; runs before
  // any hook fire could land so a stale lockfile from this very pgid
  // can't shadow a live one.
  try {
    const hookSweep = sweepOrphanHooks({
      log: (line) => process.stdout.write(`${line}\n`),
    });
    if (hookSweep.killed > 0) {
      process.stdout.write(
        `rn-dev daemon: hook-orphan-sweep cleared ${hookSweep.killed} hook${hookSweep.killed === 1 ? "" : "s"} (pgids: ${hookSweep.cleared.join(", ")})\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `rn-dev daemon: hook-orphan-sweep failed (${err instanceof Error ? err.message : String(err)}) — continuing\n`,
    );
  }

  // Pre-bind unlink of a stale socket file. Phase 13.1 reviewer P1#3:
  // previously hidden inside IpcServer.start() where it ran AFTER the
  // pid-file lock was acquired, leaving a post-lock / pre-bind window
  // where a racing client could `connect()` the stale inode. Doing it
  // here — outside the server — keeps the unlink scoped to the
  // lock-holder and under the daemon's own umask/chmod discipline.
  if (existsSync(sockPath)) {
    try {
      unlinkSync(sockPath);
    } catch {
      /* best-effort — may race with a crashed daemon's cleanup */
    }
  }

  const server = new IpcServer(sockPath);

  // Select boot implementation. Production path uses the real
  // bootSessionServices; tests opt into a stub via RN_DEV_DAEMON_BOOT_MODE=fake
  // so the state machine + event fan-out can be exercised without
  // spawning real Metro.
  const bootFn: SessionBootFn =
    process.env.RN_DEV_DAEMON_BOOT_MODE === "fake"
      ? fakeBootSessionServices
      : bootSessionServices;
  const subscribeRegistry = new SubscribeRegistry();
  const supervisor = new DaemonSupervisor({ worktree, ipc: server, bootFn, subscribeRegistry });

  // Phase D2 — boot-in-flight lock for `events/subscribe { profile }`
  // (plan § A8). Keyed by `${profile.worktree ?? ""}:${profile.name}`.
  // Two concurrent subscribers for the same profile take turns: the
  // first writes its sessionId promise, the second `await`s it and
  // joins the existing session instead of racing a fresh boot. State
  // lives at the dispatcher layer per the plan — the supervisor's
  // `findSessionByProfile` stays a pure read.
  const bootLocks = new Map<string, Promise<BootLockResult>>();

  server.on("message", (event: IpcMessageEvent) =>
    handleMessage(event, supervisor, subscribeRegistry, bootLocks, shutdown),
  );

  // Gate the bind with a restrictive umask so the socket file is 0o600
  // from the first `listen()` byte. Plain chmod-after-bind leaves a
  // TOCTOU window where any local user can `connect()` and send RPCs.
  const prevUmask = process.umask(0o177);
  try {
    await server.start();
  } finally {
    process.umask(prevUmask);
  }
  // Belt-and-suspenders: some platforms (Solaris, BSD) ignore UDS file
  // modes at creation time. Re-assert owner-only.
  try {
    chmodSync(sockPath, 0o600);
  } catch {
    /* best-effort */
  }

  // Phase 13.5 — write the active-daemon registry entry AFTER the
  // socket is bound + chmod'd. registerDaemon's own stale-entry sweep
  // cleans up any row left by a previous crash. Failure is non-fatal;
  // the socket is the load-bearing artifact, the registry is just a
  // discovery side-channel.
  try {
    registerDaemon(worktree, {
      pid: process.pid,
      sockPath,
      since: new Date().toISOString(),
      hostVersion: DAEMON_VERSION,
    });
  } catch (err) {
    process.stderr.write(
      `rn-dev daemon: registry register failed (${err instanceof Error ? err.message : String(err)}) — continuing\n`,
    );
  }

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await supervisor.shutdown();
    } catch {
      /* ignore — best-effort cleanup */
    }
    try {
      await server.stop();
    } catch {
      /* ignore */
    }
    try {
      lock.release();
    } catch {
      /* ignore */
    }
    // Best-effort registry cleanup. Crashed daemons (no graceful
    // shutdown) leave a stale row that the next boot's
    // registerDaemon sweep removes.
    try {
      unregisterDaemon(worktree);
    } catch {
      /* best-effort */
    }
    process.exit(0);
  }

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGHUP", () => {
    void shutdown();
  });

  process.stdout.write(
    `rn-dev daemon: listening at ${sockPath}, pid=${process.pid}, version=${DAEMON_VERSION}\n`,
  );
}

/**
 * Phase D2 — return shape of an in-flight boot promise stored in
 * `bootLocks`. Two concurrent subscribers awaiting the same lock must
 * see the same outcome (sessionId on success, code/message on failure)
 * so the second one can route the response without re-doing the work.
 */
type BootLockResult =
  | { ok: true; sessionId: SessionId }
  | { ok: false; code: string; message: string };

function handleMessage(
  event: IpcMessageEvent,
  supervisor: DaemonSupervisor,
  subscribeRegistry: SubscribeRegistry,
  bootLocks: Map<string, Promise<BootLockResult>>,
  shutdown: () => Promise<void>,
): void {
  const { message, reply } = event;

  // P1-7 — single declarative source of truth for subscribe-socket
  // authorization. Two tiers of pre-dispatch enforcement; the switch
  // cases themselves do NOT contain per-action rejection branches for
  // subscribe sockets — all such rejections happen here.
  //
  // Tier 1: SUBSCRIBE_NEVER_ALLOWED — blocked on ALL subscribe sockets,
  // including bidirectional ones. Checked before the bidirectional gate
  // so both tiers of subscribers are covered.
  if (
    subscribeRegistry.has(event.connectionId) &&
    SUBSCRIBE_NEVER_ALLOWED.has(message.action)
  ) {
    reply({
      type: "response",
      action: message.action,
      id: message.id,
      payload: {
        code: "E_RPC_NOT_AUTHORIZED",
        message: `action "${message.action}" is not allowed on a subscribe socket`,
      },
    });
    return;
  }

  // Tier 2: bidirectional flag enforcement. A connection registered as a
  // subscribe socket without supportsBidirectionalRpc can only call the
  // always-allowed admin/re-subscribe set. Fresh-socket sends (not in
  // subscribeRegistry) bypass this gate entirely.
  if (
    subscribeRegistry.has(event.connectionId) &&
    !subscribeRegistry.isBidirectional(event.connectionId) &&
    !SUBSCRIBE_ALWAYS_ALLOWED.has(message.action)
  ) {
    reply({
      type: "response",
      action: message.action,
      id: message.id,
      payload: {
        code: "E_RPC_NOT_AUTHORIZED",
        message: `action "${message.action}" requires supportsBidirectionalRpc on this subscribe socket`,
      },
    });
    return;
  }

  switch (message.action) {
    case "daemon/ping":
      reply({
        type: "response",
        action: "daemon/ping",
        id: message.id,
        payload: { daemonVersion: DAEMON_VERSION, hostRange: HOST_RANGE },
      });
      return;

    case "daemon/shutdown":
      // Subscribe-socket rejection is handled pre-dispatch by
      // SUBSCRIBE_NEVER_ALLOWED — no per-case check needed here.
      reply({
        type: "response",
        action: "daemon/shutdown",
        id: message.id,
        payload: { ok: true },
      });
      // Ack first; flip to shutdown on the next tick so the reply drains
      // through the socket before we close it.
      setImmediate(() => {
        void shutdown();
      });
      return;

    case "session/start": {
      // Subscribe-socket rejection is handled pre-dispatch by
      // SUBSCRIBE_NEVER_ALLOWED — no per-case check needed here.
      void handleSessionStart(event, supervisor);
      return;
    }

    case "session/stop":
      void handleSessionStop(event, supervisor);
      return;

    case "session/status":
      handleSessionStatus(event, supervisor);
      return;

    case "sessions/list":
      handleSessionsList(event, supervisor);
      return;

    case "events/subscribe":
      void handleEventsSubscribe(event, supervisor, subscribeRegistry, bootLocks);
      return;

    default:
      if (isClientRpcAction(message.action)) {
        void handleClientRpc(event, supervisor);
        return;
      }
      // `registerModulesIpc` attaches a second `ipc.on("message")` listener
      // that asynchronously dispatches `modules/*` + `marketplace/*` actions
      // (see src/app/modules-ipc.ts). Both listeners fire on every message,
      // so a synchronous E_UNKNOWN_ACTION reply here would race ahead of the
      // modules dispatcher's async reply and the client would see "unknown
      // action" for every modules RPC. Skip those actions and let the
      // dispatcher answer. The dispatcher is only wired once a session has
      // booted (`registerModulesIpc` is called inside `bootSessionServices`
      // / `fakeBootSessionServices`); before that, modules actions fall
      // through to E_SESSION_NOT_RUNNING via the pre-session guard below
      // rather than E_UNKNOWN_ACTION, which is the more accurate signal.
      if (MODULES_ACTIONS.has(message.action)) {
        if (supervisor.listSessions().every((s) => s.wired === null)) {
          reply({
            type: "response",
            action: message.action,
            id: message.id,
            payload: {
              code: "E_SESSION_NOT_RUNNING",
              message:
                "no session is currently running — call session/start before issuing modules RPCs",
            },
          });
        }
        return;
      }
      reply({
        type: "response",
        action: "daemon/error",
        id: message.id,
        payload: {
          code: "E_UNKNOWN_ACTION",
          requestedAction: message.action,
        },
      } satisfies IpcMessage);
      return;
  }
}

async function handleSessionStart(
  event: IpcMessageEvent,
  supervisor: DaemonSupervisor,
): Promise<void> {
  // Phase D2 — `session/start` is a back-compat path retained for
  // tests + tooling that drive the boot via a separate RPC (the
  // canonical D2 flow is `events/subscribe { profile }`, which
  // boots-and-attaches in one round-trip). This handler does NOT add
  // the calling connection to the supervisor's refcount — doing so
  // would auto-release on send-conn close (a few ms after the
  // response) and tear the session down underneath the caller.
  //
  // Multi-session semantics: this handler preserves the single-session
  // invariant from the pre-D2 world — if ANY session is already active
  // it rejects with `E_SESSION_ALREADY_RUNNING`. Multi-session callers
  // boot additional sessions via `events/subscribe { profile }` on a
  // fresh socket. D8 flips this rule (the `session-boot.test.ts:287`
  // assertion).
  const payloadCandidate = event.message.payload;
  const profileCandidate =
    payloadCandidate &&
    typeof payloadCandidate === "object" &&
    "profile" in payloadCandidate
      ? (payloadCandidate as { profile: unknown }).profile
      : undefined;

  const validation = validateProfile(profileCandidate);
  if (!validation.ok) {
    event.reply({
      type: "response",
      action: "session/start",
      id: event.message.id,
      payload: { code: validation.code, message: validation.message },
    });
    return;
  }

  const active = activeSessions(supervisor);
  if (active.length > 0) {
    event.reply({
      type: "response",
      action: "session/start",
      id: event.message.id,
      payload: {
        code: "E_SESSION_ALREADY_RUNNING",
        message: `session is ${active[0].state.status}; stop it before starting a new one`,
      },
    });
    return;
  }

  const sessionId = generateSessionId();
  const result = await supervisor.startSession(sessionId, validation.profile);
  if (result.kind === "error") {
    event.reply({
      type: "response",
      action: "session/start",
      id: event.message.id,
      payload: { code: result.code, message: result.message },
    });
    return;
  }
  // Phase D2 — surface the minted sessionId so clients can route
  // follow-up RPCs (status / stop / client/*) by id rather than relying
  // on the single-active-session back-compat fallback.
  event.reply({
    type: "response",
    action: "session/start",
    id: event.message.id,
    payload: { status: result.status, sessionId: result.sessionId },
  });
}

async function handleSessionStop(
  event: IpcMessageEvent,
  supervisor: DaemonSupervisor,
): Promise<void> {
  let sid: SessionId | undefined;
  try {
    sid = optionalSessionId(event.message.payload);
  } catch (err) {
    if (err instanceof RpcArgError) {
      event.reply({
        type: "response",
        action: "session/stop",
        id: event.message.id,
        payload: { code: err.code, message: err.message },
      });
      return;
    }
    throw err;
  }
  if (!sid) {
    // Back-compat single-session fallback. No sessionId → stop the only
    // active session. Zero active → already stopped (no-op ok). Two+
    // active → ambiguous, surface candidates so a multi-session client
    // can retry with `{ sessionId }`.
    const active = activeSessions(supervisor);
    if (active.length === 0) {
      event.reply({
        type: "response",
        action: "session/stop",
        id: event.message.id,
        payload: { status: "stopped" },
      });
      return;
    }
    if (active.length > 1) {
      event.reply({
        type: "response",
        action: "session/stop",
        id: event.message.id,
        payload: ambiguousPayload(active),
      });
      return;
    }
    sid = active[0].sessionId;
  }
  const result = await supervisor.stopSession(sid);
  if (result.kind === "error") {
    event.reply({
      type: "response",
      action: "session/stop",
      id: event.message.id,
      payload: { code: result.code, message: result.message },
    });
    return;
  }
  event.reply({
    type: "response",
    action: "session/stop",
    id: event.message.id,
    payload: { status: result.status },
  });
}

function handleSessionStatus(
  event: IpcMessageEvent,
  supervisor: DaemonSupervisor,
): void {
  let sid: SessionId | undefined;
  try {
    sid = optionalSessionId(event.message.payload);
  } catch (err) {
    if (err instanceof RpcArgError) {
      event.reply({
        type: "response",
        action: "session/status",
        id: event.message.id,
        payload: { code: err.code, message: err.message },
      });
      return;
    }
    throw err;
  }
  let entry: SessionEntry | undefined;
  if (sid) {
    entry = supervisor.getSessionEntry(sid);
    if (!entry) {
      event.reply({
        type: "response",
        action: "session/status",
        id: event.message.id,
        payload: {
          code: "E_UNKNOWN_SESSION",
          message: `session ${sid} not found`,
        },
      });
      return;
    }
  } else {
    // Back-compat single-session fallback. Zero active → stopped (legacy
    // shape with no worktreeKey, matches pre-D2 INITIAL_SESSION_STATE).
    const active = activeSessions(supervisor);
    if (active.length === 0) {
      event.reply({
        type: "response",
        action: "session/status",
        id: event.message.id,
        payload: {
          status: "stopped",
          services: {},
          worktreeKey: supervisor.getWorktree(),
          attached: 0,
        },
      });
      return;
    }
    if (active.length > 1) {
      event.reply({
        type: "response",
        action: "session/status",
        id: event.message.id,
        payload: ambiguousPayload(active),
      });
      return;
    }
    entry = active[0];
  }
  event.reply({
    type: "response",
    action: "session/status",
    id: event.message.id,
    payload: {
      status: entry.state.status,
      services: entry.state.services ?? {},
      // Joiners use this to backfill `worktreeKey` when they attach to
      // an already-running session and miss the session/status edge
      // that would otherwise carry it.
      worktreeKey: entry.sessionWorktreeKey,
      attached: entry.attachedConnections.size,
      sessionId: entry.sessionId,
    },
  });
}

/**
 * Phase D2 — `sessions/list` returns a snapshot of every active
 * session. Synchronous, no events, no subscription. Closes the
 * spec-flow gaps that D0.5 deepening surfaced: renderer rehydration
 * after a daemon restart, MCP cold-start, and `E_UNKNOWN_SESSION`
 * recovery (the client retries with the right sessionId from this
 * snapshot).
 */
function handleSessionsList(
  event: IpcMessageEvent,
  supervisor: DaemonSupervisor,
): void {
  const sessions = supervisor.listSessions().map((entry) => ({
    sessionId: entry.sessionId,
    profileName: entry.activeProfile.name,
    worktreeKey: entry.sessionWorktreeKey,
    status: entry.state.status,
    services: entry.state.services,
  }));
  event.reply({
    type: "response",
    action: "sessions/list",
    id: event.message.id,
    payload: { sessions },
  });
}

/**
 * Active-session snapshot used by the back-compat fallbacks in
 * `session/stop` and `session/status`. Excludes stopped entries — the
 * supervisor keeps them around briefly during teardown but they're not
 * candidates for the "only active session" shortcut. Stopping entries
 * count: a client that calls `session/stop` while one is already
 * stopping should be told it's already in-flight, not get a new boot.
 */
function activeSessions(supervisor: DaemonSupervisor): readonly SessionEntry[] {
  return supervisor.listSessions().filter((e) => e.state.status !== "stopped");
}

/**
 * `E_SESSION_AMBIGUOUS` payload carrying every candidate session — a
 * client that called `session/stop` (or any sessionId-defaulting RPC)
 * without `sessionId` against a multi-session daemon retries with one
 * from `availableSessions` (plan § B2). The `SessionAmbiguousData`
 * type lives in `src/daemon/error-codes.ts` (D0.5).
 */
function ambiguousPayload(active: readonly SessionEntry[]): {
  code: "E_SESSION_AMBIGUOUS";
  message: string;
  data: SessionAmbiguousData;
} {
  return {
    code: "E_SESSION_AMBIGUOUS",
    message: `multiple sessions active; pass sessionId to disambiguate`,
    data: {
      availableSessions: active.map((e) => ({
        sessionId: e.sessionId,
        profileName: e.activeProfile.name,
      })),
    },
  };
}

async function handleEventsSubscribe(
  event: IpcMessageEvent,
  supervisor: DaemonSupervisor,
  subscribeRegistry: SubscribeRegistry,
  bootLocks: Map<string, Promise<BootLockResult>>,
): Promise<void> {
  // Phase D2 — events/subscribe is the canonical attacher path with a
  // shrunk 2-cell input matrix (plan § B2):
  //   `{ profile }`   → boot-or-join. Boots a new session if none
  //                     matches the profile, joins the existing one
  //                     if it does. The first concurrent subscriber
  //                     for a `(worktree, profileName)` pair takes
  //                     the boot lock; later subscribers `await` it
  //                     and join. Returns `{ subscribed: true,
  //                     sessionId }`.
  //   `{ sessionId }` → attach-by-id. Looks up the existing session
  //                     and attaches; rejects with `E_UNKNOWN_SESSION`
  //                     if absent. Returns `{ subscribed: true,
  //                     sessionId }`.
  //   `{ profile && sessionId }` → `E_SUBSCRIBE_INVALID_ARGS`.
  //   `{ neither }`              → `E_SUBSCRIBE_INVALID_ARGS`
  //                                (observer mode CUT — rehydration
  //                                goes through `sessions/list`).
  //
  // Listener registration ordering: register the `supervisor.onEvent`
  // listener BEFORE awaiting attach(). `bootAsync`'s "running" edge
  // can fire on the same microtask drain that resolves attach(), and
  // a listener attached after the await would miss it.
  //
  // Reject re-subscribe on an already-subscribed socket.
  if (subscribeRegistry.has(event.connectionId)) {
    event.reply({
      type: "response",
      action: "events/subscribe",
      id: event.message.id,
      payload: {
        code: "E_RPC_NOT_AUTHORIZED",
        message:
          "this connection is already subscribed; close and reopen to re-subscribe",
      },
    });
    return;
  }

  // Parse kinds + bidirectional flag — the input matrix narrowing
  // below cares about `profile` / `sessionId` exclusively, but both
  // those modes share the same per-event filter and bidirectional
  // gate semantics.
  const rawPayload = parseSubscribeAuxPayload(event.message.payload);
  const kindsResult = parseKinds(rawPayload.kinds);
  if (!kindsResult.ok) {
    event.reply({
      type: "response",
      action: "events/subscribe",
      id: event.message.id,
      payload: { code: kindsResult.code, message: kindsResult.message },
    });
    return;
  }
  const kindFilter = kindsResult.kinds;
  const bidirectional = rawPayload.supportsBidirectionalRpc === true;

  // Phase D2 — parse the `{ profile } | { sessionId }` discriminated
  // union. `parseEventsSubscribeInput` throws `RpcArgError` with
  // `E_SUBSCRIBE_INVALID_ARGS` for both-fields / neither-fields, and
  // the validator's `E_PROFILE_*` codes for malformed profiles.
  let input;
  try {
    input = parseEventsSubscribeInput(event.message.payload, "events/subscribe");
  } catch (err) {
    if (err instanceof RpcArgError) {
      event.reply({
        type: "response",
        action: "events/subscribe",
        id: event.message.id,
        payload: { code: err.code, message: err.message },
      });
      return;
    }
    throw err;
  }

  const push = (evt: SessionEvent): void => {
    if (!matchesKindFilter(kindFilter, evt.kind)) return;
    event.reply({
      type: "event",
      action: "session/event",
      id: event.message.id,
      payload: evt,
    });
  };
  const detach = supervisor.onEvent(push);

  // Register before any await, so socket-close cleanup always matches
  // a registered entry.
  subscribeRegistry.register(event.connectionId, { bidirectional });

  const subscribeConnId = event.connectionId;
  event.onClose(() => {
    detach();
    subscribeRegistry.clearConnection(subscribeConnId);
    void supervisor.releaseConnectionFromAllSessions(subscribeConnId);
  });

  // Shared rejection path — undo the listener + registry side effects
  // before replying. Closure captures `detach` + `event.connectionId`
  // so neither callsite has to thread them through.
  const rejectAndCleanup = (code: string, message: string): void => {
    detach();
    subscribeRegistry.clearConnection(subscribeConnId);
    event.reply({
      type: "response",
      action: "events/subscribe",
      id: event.message.id,
      payload: { code, message },
    });
  };

  if (input.mode === "attach-by-id") {
    const entry = supervisor.getSessionEntry(input.sessionId);
    if (!entry) {
      rejectAndCleanup(
        "E_UNKNOWN_SESSION",
        `session ${input.sessionId} not found`,
      );
      return;
    }
    const attachResult = supervisor.attachToSession(
      input.sessionId,
      subscribeConnId,
      entry.activeProfile,
    );
    if (attachResult.kind === "error") {
      rejectAndCleanup(attachResult.code, attachResult.message);
      return;
    }
    event.reply({
      type: "response",
      action: "events/subscribe",
      id: event.message.id,
      payload: {
        subscribed: true,
        status: attachResult.status,
        started: attachResult.started,
        attached: attachResult.attached,
        sessionId: attachResult.sessionId,
      },
    });
    return;
  }

  // boot-or-join. Resolve the boot lock first so two concurrent
  // subscribers for the same `(worktree, profileName)` pair don't
  // both race a fresh `startSession` (plan § A8).
  const profile = input.profile;
  const lockKey = bootLockKey(profile);
  const inFlight = bootLocks.get(lockKey);

  // Existing entry shortcut — read-only, race-free in a single-threaded
  // JS world: the path between `findSessionByProfile` and `attachToSession`
  // contains no awaits, so no other handler can split the difference.
  const existing = supervisor.findSessionByProfile(
    profile.name,
    profile.worktree,
  );
  if (existing) {
    const attachResult = supervisor.attachToSession(
      existing.sessionId,
      subscribeConnId,
      profile,
    );
    if (attachResult.kind === "error") {
      rejectAndCleanup(attachResult.code, attachResult.message);
      return;
    }
    event.reply({
      type: "response",
      action: "events/subscribe",
      id: event.message.id,
      payload: {
        subscribed: true,
        status: attachResult.status,
        started: attachResult.started,
        attached: attachResult.attached,
        sessionId: attachResult.sessionId,
      },
    });
    return;
  }

  // Lock held by a sibling subscriber — await its boot result and
  // attach to the sessionId it minted.
  if (inFlight) {
    const result = await inFlight;
    if (!result.ok) {
      rejectAndCleanup(result.code, result.message);
      return;
    }
    const attachResult = supervisor.attachToSession(
      result.sessionId,
      subscribeConnId,
      profile,
    );
    if (attachResult.kind === "error") {
      rejectAndCleanup(attachResult.code, attachResult.message);
      return;
    }
    event.reply({
      type: "response",
      action: "events/subscribe",
      id: event.message.id,
      payload: {
        subscribed: true,
        status: attachResult.status,
        started: attachResult.started,
        attached: attachResult.attached,
        sessionId: attachResult.sessionId,
      },
    });
    return;
  }

  // We're the first subscriber for this `(worktree, profileName)` pair.
  // Mint a fresh sessionId, register the lock BEFORE the first await,
  // and let any sibling subscriber that arrives during boot await our
  // promise instead of racing.
  const sessionId = generateSessionId();
  const lockPromise: Promise<BootLockResult> = supervisor
    .startSession(sessionId, profile)
    .then((r): BootLockResult => {
      if (r.kind === "error") return { ok: false, code: r.code, message: r.message };
      return { ok: true, sessionId: r.sessionId };
    });
  bootLocks.set(lockKey, lockPromise);
  // Self-cleanup so a follow-up boot for the same key can proceed once
  // we've published the sessionId. Use `finally` so success and failure
  // both clear the lock; siblings holding a ref to the promise still see
  // the resolved value via their own `await`.
  lockPromise.finally(() => {
    if (bootLocks.get(lockKey) === lockPromise) {
      bootLocks.delete(lockKey);
    }
  });

  const result = await lockPromise;
  if (!result.ok) {
    rejectAndCleanup(result.code, result.message);
    return;
  }
  const attachResult = supervisor.attachToSession(
    result.sessionId,
    subscribeConnId,
    profile,
  );
  if (attachResult.kind === "error") {
    rejectAndCleanup(attachResult.code, attachResult.message);
    return;
  }
  event.reply({
    type: "response",
    action: "events/subscribe",
    id: event.message.id,
    payload: {
      subscribed: true,
      status: attachResult.status,
      started: true,
      attached: attachResult.attached,
      sessionId: attachResult.sessionId,
    },
  });
}

/**
 * Phase D2 — boot-lock key derived from `(worktree, profileName)`.
 * Mirrors `findSessionByProfile`'s comparison: `null` worktree
 * normalises to `""` so the same lock guards both single-worktree and
 * worktree-less profiles. The lock state lives at the dispatcher
 * layer per plan § A8 — the supervisor's `findSessionByProfile` stays
 * a pure read.
 */
function bootLockKey(profile: ValidatedProfile): string {
  return `${profile.worktree ?? ""}:${profile.name}`;
}

/**
 * Phase D2 — separate aux-payload parser for `kinds` +
 * `supportsBidirectionalRpc`. Mirrors `parseSessionEventEnvelope`'s
 * runtime-narrowing discipline (Kieran P1-3 on PR #17). The
 * discriminated profile/sessionId fields go through
 * `parseEventsSubscribeInput` (D0.5 narrower); this parser handles the
 * orthogonal fields so the wire payload doesn't grow a parallel cast.
 */
function parseSubscribeAuxPayload(raw: unknown): {
  kinds: unknown;
  supportsBidirectionalRpc: boolean;
} {
  if (!raw || typeof raw !== "object") {
    return { kinds: undefined, supportsBidirectionalRpc: false };
  }
  const p = raw as Record<string, unknown>;
  return {
    kinds: "kinds" in p ? p.kinds : undefined,
    supportsBidirectionalRpc: p.supportsBidirectionalRpc === true,
  };
}

function detachAndExit(worktree: string, daemonEntryOverride?: string): never {
  // The child runs the daemon loop in-process via --foreground; see
  // `spawnDetachedDaemon` for the detach mechanics (detached=true,
  // stdio=ignore, unref). This function is the "I am the CLI-level
  // daemon command, now fork myself and exit" wrapper around that
  // primitive.
  try {
    const child = spawnDetachedDaemon(worktree, daemonEntryOverride);
    process.stdout.write(
      `rn-dev daemon: spawned detached pid=${child.pid ?? "?"}, worktree=${worktree}\n`,
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `rn-dev daemon: ${err instanceof Error ? err.message : String(err)} — re-run with --foreground\n`,
    );
    process.exit(1);
  }
}
