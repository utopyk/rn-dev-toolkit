import { afterEach, describe, expect, it } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";
import { IpcClient, type IpcMessage } from "../../core/ipc.js";

// Phase 13.3 merge gate — integration test #4. The daemon owns session
// lifecycle; a TUI client disconnect must NOT tear the session down. This
// is the architectural property that makes the upcoming 3-client model
// (TUI + Electron + MCP) viable — if session survival were tied to any
// single client socket, quitting the TUI would kill Metro + DevTools +
// module subprocesses out from under the other two.
//
// Uses `RN_DEV_DAEMON_BOOT_MODE=fake` so the state machine + event
// fan-out are exercised without spawning real Metro. The production boot
// path is covered by `src/daemon/__tests__/session-boot.test.ts`.

describe("tui daemon client (integration)", () => {
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

  it("session survives subscription-client churn", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const profile = {
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

    // --- Client #1: the "TUI" that quits mid-session -----------------
    const client1 = new IpcClient(daemon.sockPath);

    const events1: IpcMessage[] = [];
    const sub1 = await client1.subscribe(
      { type: "command", action: "events/subscribe", id: "sub-1" },
      { onEvent: (evt) => events1.push(evt) },
    );
    expect(sub1.initial.type).toBe("response");

    const start = await client1.send({
      type: "command",
      action: "session/start",
      id: "start-1",
      payload: { profile },
    });
    expect((start.payload as { status: string }).status).toBe("starting");

    // Wait for the fake boot's running emit before disconnecting so
    // the churn happens mid-session, not pre-boot.
    await waitForEvent(events1, (evt) => {
      const p = evt.payload as
        | { kind?: string; data?: { status?: string } }
        | undefined;
      return (
        p?.kind === "metro/status" && p.data?.status === "running"
      );
    }, 3_000);

    // Simulate TUI quit: drop the subscription socket.
    sub1.close();

    // --- Client #2: a fresh reconnect after "TUI restart" -------------
    // Session state must persist across the disconnect — that's the
    // whole point of moving services into the daemon.
    const client2 = new IpcClient(daemon.sockPath);

    const statusResp = await client2.send({
      type: "command",
      action: "session/status",
      id: "status-after-churn",
    });
    const statusPayload = statusResp.payload as { status?: string };
    expect(statusPayload.status).toBe("running");

    // New subscription must still receive metro events — daemon kept
    // the supervisor + service emitters alive.
    const events2: IpcMessage[] = [];
    const sub2 = await client2.subscribe(
      { type: "command", action: "events/subscribe", id: "sub-2" },
      { onEvent: (evt) => events2.push(evt) },
    );
    expect(sub2.initial.type).toBe("response");

    // Trigger a new event the second client can observe — session/stop
    // causes the fake boot's dispose path to emit "stopped". If the
    // daemon had torn the session down when client #1 disconnected,
    // `dispose` would have already fired, there'd be nothing running
    // to stop, and no "stopped" event would land on sub2.
    await client2.send({
      type: "command",
      action: "session/stop",
      id: "stop-1",
    });

    await waitForEvent(events2, (evt) => {
      const p = evt.payload as
        | { kind?: string; data?: { status?: string } }
        | undefined;
      return (
        p?.kind === "metro/status" && p.data?.status === "stopped"
      );
    }, 3_000);

    sub2.close();
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
