import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IpcClient } from "../../src/core/ipc.js";

// ---------------------------------------------------------------------------
// Shared across all Phase 13 integration tests. The helper owns:
//   - spawning the daemon (bun runs the CLI entry with `daemon <wt> --foreground`)
//   - piping stderr/stdout so tests can assert on them after exit
//   - a `waitForSocket` poll so tests don't race on daemon startup
//   - a uniform cleanup path (`stop()`) that afterEach handlers call
// ---------------------------------------------------------------------------

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "index.tsx");
const FIXTURE_MINIMAL_RN = join(REPO_ROOT, "test", "fixtures", "minimal-rn");

export interface TestDaemonHandle {
  proc: ChildProcess;
  pid: number;
  sockPath: string;
  pidPath: string;
  client: IpcClient;
  getStderr: () => string;
  getStdout: () => string;
  waitForExit: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface SpawnTestDaemonOptions {
  readyTimeoutMs?: number;
  /** If false, return immediately without waiting for the socket. */
  waitForReady?: boolean;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export async function spawnTestDaemon(
  worktree: string,
  opts: SpawnTestDaemonOptions = {},
): Promise<TestDaemonHandle> {
  const { readyTimeoutMs = 5_000, waitForReady = true, extraArgs = [], env } = opts;

  const proc = spawn(
    "bun",
    ["run", CLI_ENTRY, "daemon", worktree, "--foreground", ...extraArgs],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    },
  );

  if (proc.pid === undefined) {
    throw new Error("spawnTestDaemon: spawn returned no pid (spawn failed synchronously)");
  }
  const pid = proc.pid;

  let stderr = "";
  let stdout = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
  });

  const sockPath = join(worktree, ".rn-dev", "sock");
  const pidPath = join(worktree, ".rn-dev", "pid");

  const exitPromise = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((res) => {
    proc.once("exit", (code, signal) => {
      res({ code, signal });
    });
  });

  if (waitForReady) {
    await waitForSocket(sockPath, readyTimeoutMs, () => proc.exitCode);
  }

  const client = new IpcClient(sockPath);

  const stop = async (): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    if (proc.exitCode !== null || proc.signalCode !== null) return exitPromise;
    proc.kill("SIGTERM");
    // Fallback SIGKILL if the daemon misbehaves and does not exit within 3s.
    const killTimer = setTimeout(() => {
      if (proc.exitCode === null && !proc.killed) proc.kill("SIGKILL");
    }, 3_000);
    const info = await exitPromise;
    clearTimeout(killTimer);
    return info;
  };

  return {
    proc,
    pid,
    sockPath,
    pidPath,
    client,
    getStderr: () => stderr,
    getStdout: () => stdout,
    waitForExit: () => exitPromise,
    stop,
  };
}

async function waitForSocket(
  sockPath: string,
  timeoutMs: number,
  getExitCode: () => number | null,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(sockPath)) return;
    if (getExitCode() !== null) {
      throw new Error(
        `Daemon exited (code=${getExitCode()}) before creating socket at ${sockPath}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for socket at ${sockPath}`);
}

/**
 * Create a scratch worktree directory seeded with `test/fixtures/minimal-rn`.
 * Tests use this so pid/sock files written under `.rn-dev/` don't pollute
 * the checked-in fixture.
 */
export function makeTestWorktree(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "rn-dev-daemon-test-"));
  cpSync(FIXTURE_MINIMAL_RN, path, { recursive: true });
  const cleanup = (): void => {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };
  return { path, cleanup };
}
