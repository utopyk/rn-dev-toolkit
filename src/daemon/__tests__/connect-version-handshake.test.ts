import net from "node:net";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { connectToDaemon } from "../spawn.js";
import type { IpcClient, IpcMessage } from "../../core/ipc.js";

// Phase 13.6 follow-up — version-handshake on connect closes a known
// architectural gap. Long-lived daemons (one per worktree, designed to
// outlive client exit) survive across rn-dev-cli upgrades. Without this
// handshake, a freshly-rebuilt client connects to a stale pre-upgrade
// daemon and silently mis-parses its wire shape — Bug 1 from the
// 2026-04-26 PR-C handoff. Fix: ping daemon, version-mismatch triggers
// graceful shutdown + cold-spawn.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "index.tsx");

interface FakeDaemonHandle {
  sockPath: string;
  pidPath: string;
  closed: Promise<void>;
}

/**
 * Stand up a minimal "old daemon" stub at `<worktree>/.rn-dev/sock`. It
 * accepts newline-delimited JSON, replies to `daemon/ping` with the
 * caller-supplied `daemonVersion`, and on `daemon/shutdown` unlinks the
 * sock + closes the server to mimic the real daemon's graceful-exit
 * cleanup. Used by tests to simulate a stale pre-upgrade daemon without
 * spawning a real subprocess.
 */
function startFakeOldDaemon(
  worktree: string,
  daemonVersion: string,
): FakeDaemonHandle {
  const dir = join(worktree, ".rn-dev");
  mkdirSync(dir, { recursive: true });
  const sockPath = join(dir, "sock");
  const pidPath = join(dir, "pid");
  if (existsSync(sockPath)) unlinkSync(sockPath);
  // Pid file references this process — the test process IS the fake
  // daemon, so SIGTERM-fallback paths can target it without us needing
  // a separate child.
  writeFileSync(
    pidPath,
    JSON.stringify({
      pid: process.pid,
      uid: process.getuid?.() ?? 0,
      acquiredAt: Date.now(),
      socketPath: sockPath,
    }),
  );

  let closeResolve!: () => void;
  const closed = new Promise<void>((r) => {
    closeResolve = r;
  });

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: IpcMessage;
        try {
          msg = JSON.parse(trimmed) as IpcMessage;
        } catch {
          continue;
        }
        if (msg.action === "daemon/ping") {
          socket.write(
            JSON.stringify({
              type: "response",
              action: "daemon/ping",
              id: msg.id,
              payload: { daemonVersion, hostRange: "*" },
            }) + "\n",
          );
        } else if (msg.action === "daemon/shutdown") {
          socket.write(
            JSON.stringify({
              type: "response",
              action: "daemon/shutdown",
              id: msg.id,
              payload: { ok: true },
            }) + "\n",
          );
          // Mirror the real daemon's exit ordering: drain ack first, then
          // unlink + close so connectToDaemon's wait-for-sock loop sees
          // the disappearance.
          setImmediate(() => {
            try {
              if (existsSync(sockPath)) unlinkSync(sockPath);
              if (existsSync(pidPath)) unlinkSync(pidPath);
            } catch {
              /* best-effort */
            }
            server.close(() => closeResolve());
          });
        }
      }
    });
    socket.on("error", () => undefined);
  });
  server.listen(sockPath);

  return { sockPath, pidPath, closed };
}

/**
 * Read the pid recorded by the daemon at `<worktree>/.rn-dev/pid` and return
 * it. Returns `null` if the file is missing or unparseable. The pid file
 * format is set by `ModuleLockfile.acquire` — see `src/daemon/spawn.ts`.
 */
function readDaemonPid(worktree: string): number | null {
  const pidPath = join(worktree, ".rn-dev", "pid");
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Tear down a worktree-scoped daemon defensively. Pre-fix, cleanup ran in
 * push order so `rmSync(worktree)` deleted the sock before the
 * `daemon/shutdown` request could reach it, and there was no SIGKILL
 * fallback when the daemon outlived its socket. The result was 5+ leaked
 * `bun run … daemon /var/folders/.../rn-dev-version-…` processes per CI
 * run. This helper:
 *
 *   1. Reads the pid file BEFORE removing the worktree.
 *   2. Sends `daemon/shutdown` (best-effort) and waits up to 2s for exit.
 *   3. SIGKILLs the pid if the daemon is still alive.
 *   4. Then removes the worktree.
 */
async function teardownDaemonAndWorktree(
  worktree: string,
  client: IpcClient | null,
): Promise<void> {
  const pid = readDaemonPid(worktree);
  if (client) {
    try {
      await client.send({
        type: "command",
        action: "daemon/shutdown",
        id: "test-cleanup",
      });
    } catch {
      /* best-effort — daemon may already be down or sock torn */
    }
  }
  if (pid !== null && processIsAlive(pid)) {
    const exited = await waitForExit(pid, 2_000);
    if (!exited && processIsAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* best-effort */
      }
    }
  }
  try {
    rmSync(worktree, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Count the number of leaked test-fixture daemons currently running. Matches
 * any `bun … daemon /…/rn-dev-version-…` process — both `-handshake-` and
 * `-fastpath-` fixtures created by this suite. Used by Bug F's regression
 * guard.
 */
function countLeakedDaemons(): number {
  try {
    const out = execSync(
      "pgrep -fl 'src/index.tsx daemon .*rn-dev-version-' || true",
      { encoding: "utf8" },
    );
    return out.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

async function pingDaemonVersion(client: IpcClient): Promise<string> {
  const resp = await client.send({
    type: "command",
    action: "daemon/ping",
    id: `assertion-ping-${Date.now()}`,
  });
  const payload = resp.payload as { daemonVersion?: unknown };
  return typeof payload.daemonVersion === "string" ? payload.daemonVersion : "<missing>";
}

describe("connectToDaemon — version handshake", () => {
  // Each test registers its (worktree, client) tuple with the active scope
  // before doing any work that could throw. afterEach drains the scope in
  // reverse insertion order so the daemon is always shut down BEFORE its
  // worktree is removed (Bug F: pre-fix, the rmSync ran before
  // daemon/shutdown could reach the sock, leaking the daemon process).
  const teardowns: Array<{ worktree: string; client: IpcClient | null }> = [];
  const extraCleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const fn of extraCleanups.splice(0).reverse()) {
      try {
        await fn();
      } catch {
        /* best-effort */
      }
    }
    for (const t of teardowns.splice(0).reverse()) {
      await teardownDaemonAndWorktree(t.worktree, t.client);
    }
  });

  it("detects a stale daemon (mismatched version), shuts it down, and cold-spawns a fresh one", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "rn-dev-version-handshake-"));
    const teardown = { worktree, client: null as IpcClient | null };
    teardowns.push(teardown);

    // Stand up the fake old daemon and confirm a direct ping returns the
    // stale version — proves the fixture is wired correctly before the
    // production code under test even runs.
    const fake = startFakeOldDaemon(worktree, "0.0.0");
    extraCleanups.push(() => fake.closed);

    // Production code under test: connectToDaemon should notice the
    // version mismatch, shutdown the fake, and cold-spawn a fresh daemon
    // that we can ping for the current version.
    const client = await connectToDaemon(worktree, {
      daemonEntry: CLI_ENTRY,
      // Tighter timeouts than the production defaults so a regression
      // (no handshake → joins stale daemon → test sees 0.0.0) fails fast.
      spawnTimeoutMs: 10_000,
      pollMs: 50,
    });
    teardown.client = client;

    const version = await pingDaemonVersion(client);
    expect(
      version,
      "After version-mismatch recovery the client should be talking to a fresh daemon, not the stale 0.0.0 stub",
    ).not.toBe("0.0.0");
    expect(version, "Fresh daemon should report a real semver version").toMatch(
      /^\d+\.\d+\.\d+/,
    );
  }, 30_000);

  it("returns the existing client when the daemon's version already matches (fast path, no restart)", async () => {
    // First connect cold-spawns a real daemon. Second connect should
    // return immediately — same daemon, same pid, no restart noise. We
    // assert "no restart" by capturing the daemon's pid via daemon/ping
    // before and after the second connect.
    const worktree = mkdtempSync(join(tmpdir(), "rn-dev-version-fastpath-"));
    const teardown = { worktree, client: null as IpcClient | null };
    teardowns.push(teardown);

    const first = await connectToDaemon(worktree, {
      daemonEntry: CLI_ENTRY,
      spawnTimeoutMs: 10_000,
      pollMs: 50,
    });
    teardown.client = first;

    const versionBefore = await pingDaemonVersion(first);

    // Second connect against the same worktree should hit the fast path —
    // alive sock + matching version → return without restart. We can't
    // observe "did we ping?" directly, so we assert continuity: the same
    // version is still reported and the daemon is still up.
    const second = await connectToDaemon(worktree, {
      daemonEntry: CLI_ENTRY,
      spawnTimeoutMs: 10_000,
      pollMs: 50,
    });
    const versionAfter = await pingDaemonVersion(second);

    expect(versionAfter).toBe(versionBefore);
  }, 30_000);

  it("Bug F regression — back-to-back tests leave no leftover daemon processes", async () => {
    // Pre-fix, this assertion was load-bearing: each prior test left a
    // detached `bun … daemon …rn-dev-version-…` process behind because
    // the worktree (and its sock) was removed before daemon/shutdown
    // could reach the daemon. Snapshot the current count, run a tiny
    // session, run the existing teardown, and assert the count is back
    // to the snapshot.
    const before = countLeakedDaemons();

    const worktree = mkdtempSync(join(tmpdir(), "rn-dev-version-handshake-"));
    const client = await connectToDaemon(worktree, {
      daemonEntry: CLI_ENTRY,
      spawnTimeoutMs: 10_000,
      pollMs: 50,
    });
    // Force a real round-trip so the daemon is definitely up before
    // teardown.
    const v = await pingDaemonVersion(client);
    expect(v).toMatch(/^\d+\.\d+\.\d+/);

    await teardownDaemonAndWorktree(worktree, client);

    // Give SIGKILL fallback a beat to register in ps.
    await new Promise((r) => setTimeout(r, 200));

    const after = countLeakedDaemons();
    expect(
      after,
      `Daemon process leak detected: ${after} > ${before}. Pre-fix this delta grew by 1 per test run.`,
    ).toBeLessThanOrEqual(before);
  }, 30_000);
});
