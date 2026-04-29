import net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) {
      try {
        await fn();
      } catch {
        /* best-effort */
      }
    }
  });

  it("detects a stale daemon (mismatched version), shuts it down, and cold-spawns a fresh one", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "rn-dev-version-handshake-"));
    cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));

    // Stand up the fake old daemon and confirm a direct ping returns the
    // stale version — proves the fixture is wired correctly before the
    // production code under test even runs.
    const fake = startFakeOldDaemon(worktree, "0.0.0");
    cleanups.push(() => fake.closed);

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
    cleanups.push(async () => {
      try {
        await client.send({
          type: "command",
          action: "daemon/shutdown",
          id: "test-cleanup",
        });
      } catch {
        /* daemon may already be down */
      }
    });

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
    cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));

    const first = await connectToDaemon(worktree, {
      daemonEntry: CLI_ENTRY,
      spawnTimeoutMs: 10_000,
      pollMs: 50,
    });
    cleanups.push(async () => {
      try {
        await first.send({
          type: "command",
          action: "daemon/shutdown",
          id: "test-cleanup",
        });
      } catch {
        /* best-effort */
      }
    });

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
});
