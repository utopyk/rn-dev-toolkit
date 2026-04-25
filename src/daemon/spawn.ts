import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync, unlinkSync } from "node:fs";
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
  /**
   * Absolute path to the CLI entry used when the daemon needs to be
   * cold-spawned. Electron's `process.argv[1]` points at the packaged
   * main.js, not the CLI entry, so Electron callers (Phase 13.4) MUST
   * pass this explicitly. Omit for CLI/TUI callers — those resolve
   * correctly from `process.argv[1]`.
   */
  daemonEntry?: string;
}

export async function connectToDaemon(
  worktree: string,
  opts: ConnectToDaemonOptions = {},
): Promise<IpcClient> {
  const { spawnTimeoutMs = 5_000, pollMs = 100, daemonEntry } = opts;

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

  spawnDetachedDaemon(wt, daemonEntry);
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

/**
 * Fork a detached daemon subprocess and return its pid. Used by both
 * `connectToDaemon` (client side — we need a daemon to talk to) and
 * `runDaemon` when invoked without `--foreground` (daemon side —
 * detach from the parent shell).
 *
 * Validates daemonEntry + worktree up front so both call sites share
 * the same error discipline — previously `runDaemon::detachAndExit`
 * duplicated these checks with slightly different phrasing (deferred
 * Simplicity #2 from Phase 13.2; collapsed in PR #17).
 */
export function spawnDetachedDaemon(
  worktree: string,
  daemonEntry?: string,
): ChildProcess {
  const entry = daemonEntry ?? process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error(
      "spawnDetachedDaemon: cannot locate CLI entry (pass daemonEntry option or ensure process.argv[1] is set)",
    );
  }
  if (!existsSync(entry)) {
    throw new Error(
      `spawnDetachedDaemon: CLI entry ${entry} does not exist on disk`,
    );
  }
  try {
    const wtStat = statSync(worktree);
    if (!wtStat.isDirectory()) {
      throw new Error(
        `spawnDetachedDaemon: worktree ${worktree} is not a directory`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("spawnDetachedDaemon:")) {
      throw err;
    }
    throw new Error(
      `spawnDetachedDaemon: worktree ${worktree} does not exist`,
    );
  }

  // process.execPath under Electron is the Electron binary — spawning
  // it with our CLI entry would launch a second Electron app, not a
  // Node process. The daemon entry is either a .tsx (dev: needs bun
  // or a Node + tsx loader) or compiled .js (runs under any Node-
  // compatible runtime). Pick the right interpreter:
  //   - .tsx + RN_DEV_DAEMON_INTERPRETER set → use that (CI override)
  //   - .tsx → bun (every dev path the project supports)
  //   - .js → process.execPath when it looks like node, else node
  const interpreter = pickDaemonInterpreter(entry);
  const child = spawn(
    interpreter,
    interpreter === "bun"
      ? ["run", entry, "daemon", worktree, "--foreground"]
      : [entry, "daemon", worktree, "--foreground"],
    {
      detached: true,
      stdio: "ignore",
      cwd: worktree,
    },
  );
  child.unref();
  return child;
}

function pickDaemonInterpreter(entry: string): string {
  const override = process.env.RN_DEV_DAEMON_INTERPRETER;
  if (override) return override;
  if (entry.endsWith(".tsx") || entry.endsWith(".ts")) return "bun";
  // Compiled .js — process.execPath works UNLESS the parent is
  // Electron (where execPath is the Electron binary). Detect Electron
  // by sniffing for the electron-specific globals injected at boot.
  const isElectron =
    typeof process.versions === "object" &&
    "electron" in (process.versions as Record<string, unknown>);
  if (isElectron) return "node";
  return process.execPath;
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
