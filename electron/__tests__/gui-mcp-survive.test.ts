import { afterEach, describe, expect, it } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../test/helpers/spawnTestDaemon.js";
import { IpcClient, type IpcMessage } from "../../src/core/ipc.js";
import { connectToDaemonSession } from "../../src/app/client/session.js";
import type { Profile } from "../../src/core/types.js";

// Phase 13.4 merge gate — integration test #5. When the Electron GUI
// process quits, the daemon + any live MCP client session MUST continue
// unaffected. This is the flip-side of test #4: #4 proved the session
// survives subscription-client churn from ANY client; #5 pins that
// behavior specifically against the new Electron wiring pattern
// (`connectToDaemonSession` + `session.stop()`).
//
// What this test actually exercises:
//   1. `connectToDaemonSession` boots, just like Electron main will do.
//   2. A second IpcClient plays the MCP role — subscribes + queries status.
//   3. The "Electron" session closes its subscription abruptly (simulating
//      GUI window quit — NOT a clean `session/stop`; that would kill the
//      session by design).
//   4. MCP MUST see the session still running + issue a working RPC.
//
// We don't spawn a real Electron binary here. Electron's main.ts in
// Phase 13.4 is a thin wrapper around `connectToDaemonSession`; if the
// orchestrator+daemon pair preserves session state when the caller
// disappears, Electron does too. Phase 13.5 will extend this with a
// real electron-spawn test once MCP moves onto `connectToDaemon`.
//
// Uses `RN_DEV_DAEMON_BOOT_MODE=fake` so the state machine is exercised
// without a real Metro process.

describe("GUI quit / MCP survive (integration)", () => {
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

  it("daemon + MCP survive when the Electron-style client disappears", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const profile: Profile = {
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
    };

    // --- MCP-like observer: raw IpcClient, long-lived subscription. ---
    // Phase 13.5 — MCP must be an attacher (subscribe with profile) to
    // hold a refcount that keeps the session alive when the GUI client
    // disconnects. A listener-only subscription wouldn't survive the
    // GUI's auto-release on socket-close. This mirrors what the real
    // MCP server will do once it flips to a daemon-client (PR-C).
    const mcp = new IpcClient(daemon.sockPath);
    const mcpEvents: IpcMessage[] = [];
    const mcpSub = await mcp.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "mcp-sub-1",
        payload: { profile },
      },
      { onEvent: (evt) => mcpEvents.push(evt) },
    );
    expect(mcpSub.initial.type).toBe("response");
    expect(
      (mcpSub.initial.payload as { subscribed?: boolean }).subscribed,
    ).toBe(true);

    // --- "Electron" client: the same `connectToDaemonSession` pathway
    //     Electron main will use in Phase 13.4. `connectToDaemon`
    //     reuses the already-running daemon at worktree/.rn-dev/sock;
    //     no cold spawn happens in this test. -----------------------
    const guiSession = await connectToDaemonSession(worktree, profile);

    // Sanity: adapters resolved + session reached running via the
    // orchestrator's own subscription.
    expect(guiSession.metro).toBeDefined();
    expect(guiSession.devtools).toBeDefined();
    expect(guiSession.builder).toBeDefined();
    expect(guiSession.watcher).toBeDefined();
    expect(guiSession.worktreeKey).toBeTruthy();

    // MCP confirms "running" before we tear down the GUI client.
    const preStatus = await mcp.send({
      type: "command",
      action: "session/status",
      id: "mcp-status-1",
    });
    expect((preStatus.payload as { status?: string }).status).toBe("running");

    // --- Simulate GUI window quit: abandon the session WITHOUT calling
    //     `session/stop`. Real Electron quit drops the socket the same
    //     way. `disconnect()` is introduced in Phase 13.4 alongside the
    //     daemon-death handling (prereq #1) — it closes the client's
    //     subscription + TCP socket without asking the daemon to shut
    //     down the session. -----------------------------------------
    guiSession.disconnect();

    // Give the daemon a beat to process the socket close. Session state
    // MUST be unaffected — separating client lifetime from session
    // lifetime is the whole point of Phase 13.
    await new Promise((r) => setTimeout(r, 100));

    // MCP: session still running.
    const postStatus = await mcp.send({
      type: "command",
      action: "session/status",
      id: "mcp-status-2",
    });
    expect((postStatus.payload as { status?: string }).status).toBe("running");

    // MCP: metro/reload RPC executes cleanly through the daemon even
    // after the GUI client's death. The daemon handler uses the
    // session's Metro instance — if it had been torn down when the GUI
    // client disappeared, this would fail with a "no session" error.
    const reloadResp = await mcp.send({
      type: "command",
      action: "metro/reload",
      id: "mcp-reload-1",
    });
    expect((reloadResp.payload as { ok?: boolean }).ok).toBe(true);

    // MCP's subscription is still live + still delivering events. The
    // daemon never closed MCP's socket when the GUI client went away.
    await waitForEvent(
      mcpEvents,
      (evt) => {
        const p = evt.payload as { kind?: string } | undefined;
        return p?.kind === "metro/status";
      },
      3_000,
    );

    mcpSub.close();
  }, 20_000);
});

async function waitForEvent(
  events: IpcMessage[],
  pred: (evt: IpcMessage) => boolean,
  timeoutMs: number,
): Promise<IpcMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(pred);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `waitForEvent: timed out after ${timeoutMs}ms. Events seen: ${JSON.stringify(
      events.map((e) => e.payload),
    )}`,
  );
}
