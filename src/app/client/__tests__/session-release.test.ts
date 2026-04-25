import { afterEach, describe, expect, it } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../../test/helpers/spawnTestDaemon.js";
import { connectToDaemonSession } from "../session.js";
import type { Profile } from "../../../core/types.js";

// Phase 13.5 — ref-counted session attach/release.
//
// Three behaviors under test:
//   a. Two clients attach to the same daemon. First releases. Daemon
//      keeps the session running for the second.
//   b. The second releases. Daemon transitions session to stopped.
//   c. A third client attaching after both released boots a fresh
//      session (proves the refcount tear-down didn't leak state).
//
// Negative case:
//   d. A second client attempting to attach with a *different*
//      profile gets `E_PROFILE_MISMATCH`, leaving the active
//      session intact for the first client.

describe("connectToDaemonSession ref-counted release (Phase 13.5)", () => {
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

  const makeProfile = (
    worktree: string,
    name: string = "test",
  ): Profile => ({
    name,
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
    projectRoot: worktree,
  });

  it("two clients can attach to the same daemon; first release leaves session running for the second", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);
    const prevSock = process.env.RN_DEV_DAEMON_SOCK;
    process.env.RN_DEV_DAEMON_SOCK = daemon.sockPath;
    cleanups.push(() => {
      if (prevSock === undefined) delete process.env.RN_DEV_DAEMON_SOCK;
      else process.env.RN_DEV_DAEMON_SOCK = prevSock;
    });

    const sessionA = await connectToDaemonSession(worktree, makeProfile(worktree));
    const sessionB = await connectToDaemonSession(worktree, makeProfile(worktree));

    expect(sessionA.worktreeKey).toBeTruthy();
    expect(sessionB.worktreeKey).toBe(sessionA.worktreeKey);

    let bDisconnected = false;
    sessionB.metro.on("disconnected", () => {
      bDisconnected = true;
    });

    await sessionA.release();

    // Give the daemon a beat to process the release.
    await new Promise((r) => setTimeout(r, 100));

    // Session B is still attached. The daemon must NOT have torn down.
    expect(bDisconnected).toBe(false);

    // Confirm via session/status that the daemon thinks one client is
    // still attached.
    const statusResp = await sessionB.client.send({
      type: "command",
      action: "session/status",
      id: "status-after-a-release",
    });
    const sp = statusResp.payload as { status?: string; attached?: number };
    expect(sp.status).toBe("running");
    expect(sp.attached).toBe(1);

    await sessionB.release();
  });

  it("last release tears the session down; a fresh attach boots a new session", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);
    const prevSock = process.env.RN_DEV_DAEMON_SOCK;
    process.env.RN_DEV_DAEMON_SOCK = daemon.sockPath;
    cleanups.push(() => {
      if (prevSock === undefined) delete process.env.RN_DEV_DAEMON_SOCK;
      else process.env.RN_DEV_DAEMON_SOCK = prevSock;
    });

    const sessionA = await connectToDaemonSession(worktree, makeProfile(worktree));
    await sessionA.release();

    // Give the daemon a beat to process the release + tear down.
    await new Promise((r) => setTimeout(r, 200));

    // A fresh client should be able to attach. If state from the
    // previous session leaked, this either hangs or rejects.
    const sessionC = await connectToDaemonSession(worktree, makeProfile(worktree));
    expect(sessionC.worktreeKey).toBeTruthy();
    await sessionC.release();
  });

  it("attach with a different profile is rejected with E_PROFILE_MISMATCH", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);
    const prevSock = process.env.RN_DEV_DAEMON_SOCK;
    process.env.RN_DEV_DAEMON_SOCK = daemon.sockPath;
    cleanups.push(() => {
      if (prevSock === undefined) delete process.env.RN_DEV_DAEMON_SOCK;
      else process.env.RN_DEV_DAEMON_SOCK = prevSock;
    });

    const sessionA = await connectToDaemonSession(
      worktree,
      makeProfile(worktree, "alpha"),
    );

    let mismatchError: Error | null = null;
    try {
      await connectToDaemonSession(worktree, makeProfile(worktree, "beta"));
    } catch (err) {
      mismatchError = err as Error;
    }
    expect(mismatchError).not.toBeNull();
    expect(mismatchError?.message).toMatch(/E_PROFILE_MISMATCH/);

    // Session A is still healthy.
    const statusResp = await sessionA.client.send({
      type: "command",
      action: "session/status",
      id: "status-after-mismatch",
    });
    const sp = statusResp.payload as { status?: string; attached?: number };
    expect(sp.status).toBe("running");
    expect(sp.attached).toBe(1);

    await sessionA.release();
  });

  it("release() is idempotent — calling twice does not throw", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);
    const prevSock = process.env.RN_DEV_DAEMON_SOCK;
    process.env.RN_DEV_DAEMON_SOCK = daemon.sockPath;
    cleanups.push(() => {
      if (prevSock === undefined) delete process.env.RN_DEV_DAEMON_SOCK;
      else process.env.RN_DEV_DAEMON_SOCK = prevSock;
    });

    const session = await connectToDaemonSession(worktree, makeProfile(worktree));
    await session.release();
    // Second release is a no-op (closed flag short-circuits the wire op).
    await expect(session.release()).resolves.toBeUndefined();
  });

  it("socket-close from a crashed client auto-releases its refcount", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);
    const prevSock = process.env.RN_DEV_DAEMON_SOCK;
    process.env.RN_DEV_DAEMON_SOCK = daemon.sockPath;
    cleanups.push(() => {
      if (prevSock === undefined) delete process.env.RN_DEV_DAEMON_SOCK;
      else process.env.RN_DEV_DAEMON_SOCK = prevSock;
    });

    const sessionA = await connectToDaemonSession(worktree, makeProfile(worktree));
    const sessionB = await connectToDaemonSession(worktree, makeProfile(worktree));

    // Simulate sessionA's process being killed mid-flight by ripping
    // its IpcClient socket out from under it. The daemon's socket-on-
    // close handler must auto-release the refcount.
    (sessionA.client as unknown as { destroy?: () => void }).destroy?.();
    sessionA.disconnect();

    // Give the daemon a beat to observe + auto-release.
    await new Promise((r) => setTimeout(r, 200));

    const statusResp = await sessionB.client.send({
      type: "command",
      action: "session/status",
      id: "status-after-crash",
    });
    const sp = statusResp.payload as { status?: string; attached?: number };
    expect(sp.status).toBe("running");
    // A's auto-release should have brought the count back to 1 (B only).
    expect(sp.attached).toBe(1);

    await sessionB.release();
  });
});
