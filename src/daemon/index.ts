import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  IpcServer,
  type IpcMessage,
  type IpcMessageEvent,
} from "../core/ipc.js";
import { ModuleLockfile } from "../core/module-host/lockfile.js";

// ---------------------------------------------------------------------------
// Daemon entry for `rn-dev daemon <worktree>`. Phase 13.1 ships lifecycle
// primitives only — pid arbitration, socket listen, daemon/ping, and
// daemon/shutdown. Session + service ownership arrive in Phase 13.2.
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
}

export async function runDaemon(opts: RunDaemonOptions): Promise<void> {
  const worktree = resolve(opts.worktree);
  const foreground = opts.foreground === true;

  if (!foreground) {
    detachAndExit(worktree);
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

  const server = new IpcServer(sockPath);
  server.on("message", (event: IpcMessageEvent) => handleMessage(event, shutdown));

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
      await server.stop();
    } catch {
      /* ignore — best-effort cleanup */
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

    default:
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

function detachAndExit(worktree: string): never {
  // Re-invoke ourselves with --foreground so the child runs the daemon
  // loop in-process. `detached: true` + `stdio: "ignore"` gives us the
  // POSIX setsid + close-stdio shape we need; `.unref()` lets the parent
  // exit without waiting.
  //
  // Note for Phase 13.4: Electron's `process.argv[1]` points at the
  // packaged main.js, not the CLI entry. When `connectToDaemon()` is
  // called from Electron main it MUST thread an explicit daemonEntry
  // option (see spawn.ts TODO). For 13.1 the detach path is only
  // exercised manually, so the current argv[1] resolution is enough.
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) {
    process.stderr.write(
      "rn-dev daemon: cannot detach (missing process.argv[1]); re-run with --foreground\n",
    );
    process.exit(1);
  }
  if (!existsSync(entry)) {
    process.stderr.write(
      `rn-dev daemon: cannot detach — entry ${entry} does not exist; re-run with --foreground\n`,
    );
    process.exit(1);
  }
  try {
    const wtStat = statSync(worktree);
    if (!wtStat.isDirectory()) {
      process.stderr.write(
        `rn-dev daemon: worktree ${worktree} is not a directory\n`,
      );
      process.exit(1);
    }
  } catch {
    process.stderr.write(
      `rn-dev daemon: worktree ${worktree} does not exist\n`,
    );
    process.exit(1);
  }

  const child = spawn(
    process.execPath,
    [entry, "daemon", worktree, "--foreground"],
    {
      detached: true,
      stdio: "ignore",
      cwd: worktree,
    },
  );
  child.unref();
  process.stdout.write(
    `rn-dev daemon: spawned detached pid=${child.pid ?? "?"}, worktree=${worktree}\n`,
  );
  process.exit(0);
}
