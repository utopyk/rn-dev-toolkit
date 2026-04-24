import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";

// Phase 13.1 merge gate — integration test #2. A second daemon spawn on the
// same worktree must lose the pid-arbitration race and exit with a
// diagnostic on stderr, while the original daemon is unaffected.

describe("second-spawn detection (integration)", () => {
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

  it("refuses to start a second daemon on the same worktree", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemonA = await spawnTestDaemon(worktree);
    liveHandles.push(daemonA);

    const pidAFromFile = readFileSync(daemonA.pidPath, "utf-8").trim();

    // Spawn B — do NOT wait for ready, because B is expected to exit quickly.
    const daemonB = await spawnTestDaemon(worktree, { waitForReady: false });
    const exitB = await daemonB.waitForExit();

    // B must exit non-zero and point at the running daemon in its stderr.
    expect(exitB.code).not.toBe(0);
    expect(exitB.code).not.toBeNull();
    const stderrB = daemonB.getStderr();
    expect(stderrB).toMatch(/already running/i);
    expect(stderrB).toMatch(/pid=/i);

    // A is still alive and the pid file still points at A.
    expect(daemonA.proc.exitCode).toBeNull();
    expect(existsSync(daemonA.pidPath)).toBe(true);
    expect(existsSync(daemonA.sockPath)).toBe(true);
    const pidAfter = readFileSync(daemonA.pidPath, "utf-8").trim();
    expect(pidAfter).toBe(pidAFromFile);

    // Ping still works — A wasn't disturbed by B's attempt.
    const response = await daemonA.client.send({
      type: "command",
      action: "daemon/ping",
      id: "ping-after-race",
    });
    expect(response.id).toBe("ping-after-race");
  }, 15_000);
});
