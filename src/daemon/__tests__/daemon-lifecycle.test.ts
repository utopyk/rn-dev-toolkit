import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";

// Phase 13.1 merge gate — integration test #1. Exercises the daemon binary
// end-to-end against a real process + real Unix-domain socket.

describe("daemon lifecycle (integration)", () => {
  const cleanups: Array<() => void> = [];
  const liveHandles: TestDaemonHandle[] = [];

  afterEach(async () => {
    for (const h of liveHandles.splice(0)) {
      await h.stop();
    }
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("creates pid + sock files, answers daemon/ping, cleans up on SIGTERM", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree);
    liveHandles.push(daemon);

    // Sock + pid both appear within the ready window.
    expect(existsSync(daemon.sockPath)).toBe(true);
    expect(existsSync(daemon.pidPath)).toBe(true);

    // Pid file references a live process.
    const pidContent = readFileSync(daemon.pidPath, "utf-8").trim();
    expect(pidContent.length).toBeGreaterThan(0);

    // daemon/ping → {daemonVersion, hostRange} envelope.
    const response = await daemon.client.send({
      type: "command",
      action: "daemon/ping",
      id: "ping-1",
    });
    expect(response.id).toBe("ping-1");
    expect(response.type).toBe("response");

    const payload = response.payload as { daemonVersion: string; hostRange: string };
    expect(typeof payload.daemonVersion).toBe("string");
    expect(payload.daemonVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof payload.hostRange).toBe("string");
    expect(payload.hostRange.length).toBeGreaterThan(0);

    // SIGTERM → graceful shutdown, pid + sock gone, exit code 0.
    const exit = await daemon.stop();
    expect(exit.code).toBe(0);
    expect(existsSync(daemon.sockPath)).toBe(false);
    expect(existsSync(daemon.pidPath)).toBe(false);
  }, 15_000);
});
