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
import { validateProfile } from "./profile-guard.js";
import type { SessionEvent } from "./session.js";
import { handleClientRpc, isClientRpcAction } from "./client-rpcs.js";

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

// Kept in sync with `src/cli/commands.ts::program.version(...)`. When we
// grow a shared version constant that both can import, retire the literal.
const DAEMON_VERSION = "0.1.0";
const HOST_RANGE = ">=0.1.0";

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
  const supervisor = new DaemonSupervisor({ worktree, ipc: server, bootFn });

  server.on("message", (event: IpcMessageEvent) =>
    handleMessage(event, supervisor, shutdown),
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
  shutdown: () => Promise<void>,
): void {
  const { message, reply } = event;
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

    case "session/start":
      void handleSessionStart(event, supervisor);
      return;

    case "session/stop":
      void handleSessionStop(event, supervisor);
      return;

    case "session/status":
      handleSessionStatus(event, supervisor);
      return;

    case "events/subscribe":
      handleEventsSubscribe(event, supervisor);
      return;

    default:
      if (isClientRpcAction(message.action)) {
        void handleClientRpc(event, supervisor);
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
  const payloadCandidate = event.message.payload;
  const profileCandidate =
    payloadCandidate &&
    typeof payloadCandidate === "object" &&
    "profile" in payloadCandidate
      ? (payloadCandidate as { profile: unknown }).profile
      : undefined;

  // Strict schema validation before anything downstream touches the
  // payload — see src/daemon/profile-guard.ts for the threat model.
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
    },
  });
}

function handleEventsSubscribe(
  event: IpcMessageEvent,
  supervisor: DaemonSupervisor,
): void {
  // Confirm the subscription so the client's subscribe() promise resolves.
  event.reply({
    type: "response",
    action: "events/subscribe",
    id: event.message.id,
    payload: { subscribed: true },
  });

  // Stream every subsequent session event on the same socket, reusing the
  // subscription id so the client can route it back to this subscription.
  const push = (evt: SessionEvent): void => {
    event.reply({
      type: "event",
      action: "session/event",
      id: event.message.id,
      payload: evt,
    });
  };
  const detach = supervisor.onEvent(push);
  event.onClose(() => {
    detach();
  });
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
