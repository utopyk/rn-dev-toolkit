import { afterEach, describe, expect, it } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../../test/helpers/spawnTestDaemon.js";
import { connectToDaemonSession } from "../session.js";
import type { Profile } from "../../../core/types.js";

// Phase 13.4 prereq #1 — daemon-death handling.
//
// Two orthogonal concerns:
//   a. `disconnect()` — client-initiated cleanup that closes the
//      subscription + client sockets WITHOUT asking the daemon to
//      teardown the session. Electron's window-close goes through
//      this; `stop()` stays for the CLI path where quitting the TUI
//      actually means "return the daemon to idle".
//   b. `disconnected` event on every adapter — fires when the
//      subscription socket closes unexpectedly (daemon crashed /
//      SIGKILLed / machine lost). `disconnect()` itself does NOT
//      fire it — voluntary closes aren't errors. Electron's main
//      process will listen for this and surface "daemon gone" in
//      the UI; a production follow-up can add auto-reconnect on
//      top of the signal.

describe("connectToDaemonSession disconnect lifecycle", () => {
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

  const makeProfile = (worktree: string): Profile => ({
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
    projectRoot: worktree,
  });

  it("disconnect() closes client sockets without stopping the daemon session (when another client remains attached)", async () => {
    // Phase 13.5 — refcount semantic: disconnect() decrements the
    // daemon's session refcount. With ONE attacher, disconnect tears
    // the session down (matches the new "no clients left = no point
    // running" contract). With TWO attachers, the second's refcount
    // keeps the session alive — that's what this test asserts.
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const sessionA = await connectToDaemonSession(worktree, makeProfile(worktree));
    const sessionB = await connectToDaemonSession(worktree, makeProfile(worktree));

    // Register a disconnected listener — voluntary disconnect must
    // NOT fire it on either session.
    let aDisconnectedFired = false;
    let bDisconnectedFired = false;
    sessionA.metro.on("disconnected", () => {
      aDisconnectedFired = true;
    });
    sessionB.metro.on("disconnected", () => {
      bDisconnectedFired = true;
    });

    sessionA.disconnect();

    // Give the daemon a beat to process the socket close + auto-release.
    await new Promise((r) => setTimeout(r, 100));

    // Voluntary disconnect doesn't emit disconnected on the
    // disconnecting adapter — the adapter stays "unused but not
    // erroring" from the caller's perspective.
    expect(aDisconnectedFired).toBe(false);
    // Session B is still attached, so its adapters didn't disconnect.
    expect(bDisconnectedFired).toBe(false);

    // The daemon's session is still running because B holds a refcount.
    const status = await sessionB.client.send({
      type: "command",
      action: "session/status",
      id: "status-after-a-disconnect",
    });
    expect((status.payload as { status?: string }).status).toBe("running");
    expect((status.payload as { attached?: number }).attached).toBe(1);
  }, 15_000);

  it("fires 'disconnected' on every adapter when the daemon dies unexpectedly", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const session = await connectToDaemonSession(worktree, makeProfile(worktree));

    const fired = {
      metro: false,
      devtools: false,
      builder: false,
      watcher: false,
      modules: false,
    };
    session.metro.on("disconnected", () => {
      fired.metro = true;
    });
    session.devtools.on("disconnected", () => {
      fired.devtools = true;
    });
    session.builder.on("disconnected", () => {
      fired.builder = true;
    });
    session.watcher.on("disconnected", () => {
      fired.watcher = true;
    });
    session.modules.on("disconnected", () => {
      fired.modules = true;
    });

    // SIGKILL simulates abrupt daemon death — the daemon doesn't get
    // to close its sockets cleanly, which is the failure mode we need
    // the client to survive.
    daemon.proc.kill("SIGKILL");

    // Poll until all four fired or 3s — the subscription socket's
    // close event propagates asynchronously from kernel to event loop.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (
        fired.metro &&
        fired.devtools &&
        fired.builder &&
        fired.watcher &&
        fired.modules
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(fired).toEqual({
      metro: true,
      devtools: true,
      builder: true,
      watcher: true,
      modules: true,
    });

    // After the unexpected disconnect, explicit disconnect() must
    // still be idempotent — callers should be able to clean up
    // without hitting an "already disconnected" error.
    expect(() => session.disconnect()).not.toThrow();
  }, 15_000);
});
