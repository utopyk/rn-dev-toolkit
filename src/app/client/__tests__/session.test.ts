import { afterEach, describe, expect, it } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../../test/helpers/spawnTestDaemon.js";
import { connectToDaemonSession } from "../session.js";
import type { Profile } from "../../../core/types.js";

// End-to-end for the client orchestrator: a caller should get a fully
// wired DaemonSession after one awaited call, with adapter events
// driven by the daemon's events/subscribe stream. Uses fake-boot so
// the daemon reports starting → running promptly without Metro.

describe("connectToDaemonSession (integration)", () => {
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

  function testProfile(projectRoot: string): Profile {
    return {
      name: "test",
      isDefault: true,
      worktree: null,
      branch: "main",
      platform: "ios",
      mode: "quick",
      metroPort: 8081,
      devices: {},
      buildVariant: "debug",
      preflight: { checks: [], frequency: "once" },
      onSave: [],
      env: {},
      projectRoot,
    };
  }

  it("returns a live DaemonSession after the daemon reports running; adapter events flow", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    // Pre-spawn the daemon (the orchestrator's connectToDaemon call
    // will reuse it via isDaemonAlive check) with the fake-boot env.
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const statusEvents: Array<{ status: string }> = [];
    // Use RN_DEV_DAEMON_SOCK to force the orchestrator onto the
    // test daemon's socket regardless of cwd lookup.
    const prevSock = process.env.RN_DEV_DAEMON_SOCK;
    process.env.RN_DEV_DAEMON_SOCK = daemon.sockPath;
    try {
      const session = await connectToDaemonSession(worktree, testProfile(worktree));
      session.metro.on("status", (evt: { status: string }) => {
        statusEvents.push(evt);
      });

      expect(session.worktreeKey.length).toBeGreaterThan(0);

      // Exercise a metro RPC + observe adapter event on builder.
      const reloaded = await session.metro.reload();
      expect(reloaded).toBe(true);

      const builderLines: string[] = [];
      session.builder.on("line", (evt: { text: string }) =>
        builderLines.push(evt.text),
      );
      await session.builder.build({
        projectRoot: worktree,
        platform: "ios",
        port: 8081,
        variant: "debug",
      });
      await waitUntil(() => builderLines.length > 0, 2_000);
      expect(builderLines[0]).toContain("[fake] building ios");

      await session.stop();
    } finally {
      if (prevSock === undefined) delete process.env.RN_DEV_DAEMON_SOCK;
      else process.env.RN_DEV_DAEMON_SOCK = prevSock;
    }
  }, 15_000);
});

async function waitUntil(
  pred: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
}
