import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { IpcClient } from "../core/ipc.js";

// ---------------------------------------------------------------------------
// Client-side primitive. Later phases wire this into Electron/TUI/MCP so
// that every client path unconditionally ends up with a live daemon to
// talk to. Phase 13.1 ships it additive — nothing in the existing tree
// calls `connectToDaemon` yet.
// ---------------------------------------------------------------------------

export interface ConnectToDaemonOptions {
  /** Max wall-clock to wait for the socket to appear after a cold spawn. */
  spawnTimeoutMs?: number;
  /** Poll cadence for the socket-appearance check. */
  pollMs?: number;
}

export async function connectToDaemon(
  worktree: string,
  opts: ConnectToDaemonOptions = {},
): Promise<IpcClient> {
  const { spawnTimeoutMs = 5_000, pollMs = 100 } = opts;

  // Escape hatch for CI/tests and for the MCP-debug workflow where the
  // daemon was started out-of-band. Matches the `RN_DEV_DAEMON_SOCK` hook
  // documented in the spec and already honored by src/cli/module-commands.
  const envSock = process.env.RN_DEV_DAEMON_SOCK;
  if (typeof envSock === "string" && envSock.length > 0) {
    return new IpcClient(envSock);
  }

  const wt = resolve(worktree);
  const sockPath = join(wt, ".rn-dev", "sock");
  const pidPath = join(wt, ".rn-dev", "pid");

  if (await isDaemonAlive(sockPath)) {
    return new IpcClient(sockPath);
  }

  // Stale artifacts from a crashed daemon or a pid the kernel has since
  // reused can jam `ModuleLockfile.acquire` on next boot — the spec is
  // explicit: unlink BOTH pid and sock on the cold path.
  unlinkStale(sockPath);
  unlinkStale(pidPath);

  spawnDetachedDaemon(wt);
  await waitForSocket(sockPath, spawnTimeoutMs, pollMs);
  return new IpcClient(sockPath);
}

export async function isDaemonAlive(sockPath: string): Promise<boolean> {
  if (!existsSync(sockPath)) return false;
  // A stale socket file on disk (owner crashed without cleanup) will
  // answer `connect()` with ECONNREFUSED. `isServerRunning` captures
  // that via its error handler and returns false, so we don't also
  // need to peek the pid file here — fewer syscalls, no redundant
  // liveness check.
  const client = new IpcClient(sockPath);
  return client.isServerRunning();
}

export function unlinkStale(path: string): void {
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // best-effort — the daemon will overwrite on bind
  }
}

export function spawnDetachedDaemon(worktree: string): void {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error(
      "connectToDaemon: cannot locate CLI entry (process.argv[1] empty)",
    );
  }
  if (!existsSync(entry)) {
    throw new Error(
      `connectToDaemon: CLI entry ${entry} does not exist on disk`,
    );
  }

  // Phase 13.4 TODO: Electron's process.argv[1] points at main.js, not
  // the CLI entry. Thread an explicit `daemonEntry` option through
  // ConnectToDaemonOptions when Electron starts calling this.
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
}

export async function waitForSocket(
  sockPath: string,
  timeoutMs: number,
  pollMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(sockPath)) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `connectToDaemon: timed out after ${timeoutMs}ms waiting for ${sockPath}`,
  );
}
