import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  IpcServer,
  type IpcMessage,
  type IpcMessageEvent,
} from "../core/ipc.js";
import { ModuleLockfile } from "../core/module-host/lockfile.js";
import { DaemonSupervisor, type SessionBootFn } from "./supervisor.js";
import { bootSessionServices } from "../core/session/boot.js";
import { fakeBootSessionServices } from "./fake-boot.js";
import { spawnDetachedDaemon } from "./spawn.js";
import { sweepOrphanModules } from "./orphan-sweep.js";
import { registerDaemon, unregisterDaemon } from "./registry.js";
import { validateProfile } from "./profile-guard.js";
import type { SessionEvent } from "./session.js";
import { handleClientRpc, isClientRpcAction } from "./client-rpcs.js";
import { MODULES_ACTIONS } from "../app/modules-ipc.js";
import {
  SubscribeRegistry,
  parseKinds,
  matchesKindFilter,
} from "./subscribe-registry.js";
import { DAEMON_VERSION, HOST_RANGE } from "./version.js";

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
// session/start: pre-Phase-13.5 back-compat path; subscribe sockets
//   boot via events/subscribe+profile instead.
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

  server.on("message", (event: IpcMessageEvent) =>
    handleMessage(event, supervisor, subscribeRegistry, shutdown),
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
      await supervisor.stop();
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

function handleMessage(
  event: IpcMessageEvent,
  supervisor: DaemonSupervisor,
  subscribeRegistry: SubscribeRegistry,
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

    case "events/subscribe":
      void handleEventsSubscribe(event, supervisor, subscribeRegistry);
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
        if (!supervisor.getServices()) {
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
  // Phase 13.5 — `session/start` is a back-compat path retained for
  // tests + tooling that drive the boot via a separate RPC (the
  // canonical Phase 13.5 flow is `events/subscribe { profile }`,
  // which boots-and-attaches in one round-trip). This handler does
  // NOT add the calling connection to the supervisor's refcount —
  // doing so would auto-release on send-conn close (a few ms after
  // the response) and tear the session down underneath the caller.
  //
  // Trade-off: a session booted via session/start with no follow-on
  // events/subscribe is "running with attached.size === 0," which
  // never tears down via the refcount path. Safe in tests because
  // the daemon is killed by SIGTERM in afterEach. In production,
  // callers should always subscribe — the only way to receive
  // session events anyway. Phase 13.6 may delete this handler
  // outright after migrating session-boot.test.ts and friends.
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

  const result = await supervisor.start({ profile: validation.profile });
  if (result.kind === "error") {
    event.reply({
      type: "response",
      action: "session/start",
      id: event.message.id,
      payload: { code: result.code, message: result.message },
    });
    return;
  }
  event.reply({
    type: "response",
    action: "session/start",
    id: event.message.id,
    payload: { status: result.status },
  });
}

async function handleSessionStop(
  event: IpcMessageEvent,
  supervisor: DaemonSupervisor,
): Promise<void> {
  const result = await supervisor.stop();
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
  const state = supervisor.getState();
  event.reply({
    type: "response",
    action: "session/status",
    id: event.message.id,
    payload: {
      status: state.status,
      services: state.services ?? {},
      // Phase 13.5 — joiners use this to backfill `worktreeKey` when
      // they attach to an already-running session and miss the
      // session/status edge that would otherwise carry it.
      worktreeKey: supervisor.getSessionWorktreeKey(),
      attached: supervisor.getAttachedCount(),
    },
  });
}

async function handleEventsSubscribe(
  event: IpcMessageEvent,
  supervisor: DaemonSupervisor,
  subscribeRegistry: SubscribeRegistry,
): Promise<void> {
  // Phase 13.6 — events/subscribe is the canonical attacher path.
  // Payload MUST carry a `profile`: it boots the session if stopped,
  // joins if running with matching profile, rejects on mismatch. The
  // connection's id is added to supervisor.attachedConnections; the
  // socket close auto-releases.
  //
  // New in Phase 13.6: optional `kinds` filter (validated by
  // parseKinds) gates per-event delivery; optional
  // `supportsBidirectionalRpc` declares that the subscribe socket
  // may also carry RPC requests (Task 1.4 enforces this).
  //
  // Listener registration ordering: register the supervisor.onEvent
  // listener BEFORE awaiting attach(). bootAsync's "running" edge
  // can fire on the same microtask drain that resolves attach(), and
  // a listener attached after the await would miss it.
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

  // P1-3: runtime parser — replace the raw `as` cast with a typed guard.
  // Mirrors parseSessionEventEnvelope + parseSubscribeResponse discipline
  // from Phase 13.5 (Kieran P1-3 on PR #17).
  const payload = parseSubscribePayload(event.message.payload);

  // Parse kinds first — invalid kinds aborts before any side effects.
  const kindsResult = parseKinds(payload.kinds);
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

  const bidirectional = payload.supportsBidirectionalRpc === true;

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

  // Register before any await, so socket-close cleanup always
  // matches a registered entry.
  subscribeRegistry.register(event.connectionId, {
    bidirectional,
  });

  const subscribeConnId = event.connectionId;
  event.onClose(() => {
    detach();
    subscribeRegistry.clearConnection(subscribeConnId);
    void supervisor.release(subscribeConnId);
  });

  // No profile → listener-only subscription. Back-compat path for
  // tests + tooling that drive the boot via session/start separately.
  // No refcount; the connection just receives the event stream until
  // the socket closes. Phase 13.6 may delete this branch after
  // migrating the last session-boot.test.ts callers.
  if (payload.profile === undefined) {
    event.reply({
      type: "response",
      action: "events/subscribe",
      id: event.message.id,
      payload: { subscribed: true },
    });
    return;
  }
  const validation = validateProfile(payload.profile);
  if (!validation.ok) {
    detach();
    subscribeRegistry.clearConnection(event.connectionId);
    event.reply({
      type: "response",
      action: "events/subscribe",
      id: event.message.id,
      payload: { code: validation.code, message: validation.message },
    });
    return;
  }
  const attachResult = await supervisor.attach(event.connectionId, {
    profile: validation.profile,
  });
  if (attachResult.kind === "error") {
    detach();
    subscribeRegistry.clearConnection(event.connectionId);
    event.reply({
      type: "response",
      action: "events/subscribe",
      id: event.message.id,
      payload: { code: attachResult.code, message: attachResult.message },
    });
    return;
  }
  // Confirm the subscription. `subscribed: true` is the load-bearing
  // field; status/started/attached let joiners detect the running-
  // already case without a separate status RPC.
  event.reply({
    type: "response",
    action: "events/subscribe",
    id: event.message.id,
    payload: {
      subscribed: true,
      status: attachResult.status,
      started: attachResult.started,
      attached: attachResult.attached,
    },
  });
}

/**
 * P1-3 — runtime parser for the events/subscribe wire payload. Mirrors the
 * `parseSessionEventEnvelope` / `parseSubscribeResponse` discipline established
 * in Phase 13.5 (Kieran P1-3 on PR #17). Replaces the raw `as { profile?:
 * unknown; … }` cast in `handleEventsSubscribe` with an explicit narrowing
 * that drops unrecognised fields instead of forwarding them unchecked.
 *
 * Returns a safe default (`{ profile: undefined, kinds: undefined,
 * supportsBidirectionalRpc: false }`) when the payload is absent or malformed,
 * so every callsite can assume the return type is always fully initialised.
 */
function parseSubscribePayload(raw: unknown): {
  profile: unknown;
  kinds: unknown;
  supportsBidirectionalRpc: boolean;
} {
  if (!raw || typeof raw !== "object") {
    return { profile: undefined, kinds: undefined, supportsBidirectionalRpc: false };
  }
  const p = raw as Record<string, unknown>;
  return {
    profile: "profile" in p ? p.profile : undefined,
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
