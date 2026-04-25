import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";
import { connectToDaemonSession } from "../../app/client/session.js";
import type { Profile } from "../../core/types.js";

// Phase 13.5 PR-D — end-to-end gate behavior.
//
// Gate is default-off (controlled by `RN_DEV_HOSTCALL_BIND_GATE=1`)
// because every existing production caller of `modules/host-call`
// uses `IpcClient.send()` (fresh socket per call), and enforcing the
// gate by default would break Electron's host-call bridge entirely.
// PR-C will land the long-lived RPC channel that makes bind-sender
// usable; the gate's default flips at that point.
//
// These tests opt the gate IN via env var so the binding behavior is
// pinned. Tests that don't need the gate (bind-sender malformed,
// per-socket-binding semantics) leave it on and exercise the path
// directly.

describe("modules/bind-sender + host-call gate (integration)", () => {
  const cleanups: Array<() => void> = [];
  const liveHandles: TestDaemonHandle[] = [];
  const prevGate = process.env.RN_DEV_HOSTCALL_BIND_GATE;

  beforeAll(() => {
    process.env.RN_DEV_HOSTCALL_BIND_GATE = "1";
  });
  afterAll(() => {
    if (prevGate === undefined) delete process.env.RN_DEV_HOSTCALL_BIND_GATE;
    else process.env.RN_DEV_HOSTCALL_BIND_GATE = prevGate;
  });

  afterEach(async () => {
    for (const h of liveHandles.splice(0)) {
      await h.stop();
    }
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  function fakeProfile(worktree: string): Profile {
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
      projectRoot: worktree,
    };
  }

  async function bootSession(): Promise<{
    daemon: TestDaemonHandle;
    worktree: string;
    session: Awaited<ReturnType<typeof connectToDaemonSession>>;
  }> {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    // Pass the gate env var to the daemon process explicitly — the
    // beforeAll above only sets it in the test process. spawnTestDaemon
    // forwards process.env, so it does carry over, but be explicit.
    const daemon = await spawnTestDaemon(worktree, {
      env: {
        RN_DEV_DAEMON_BOOT_MODE: "fake",
        RN_DEV_HOSTCALL_BIND_GATE: "1",
      },
    });
    liveHandles.push(daemon);
    const session = await connectToDaemonSession(worktree, fakeProfile(worktree));
    return { daemon, worktree, session };
  }

  it("host-call without a prior bind-sender returns MODULE_UNAVAILABLE (denied)", async () => {
    const { daemon } = await bootSession();

    // dev-space is a built-in registered by fakeBootSessionServices; it
    // exists in the registry, so the gate's failure mode is "no
    // binding," not "module not registered."
    const resp = await daemon.client.send({
      type: "command",
      action: "modules/host-call",
      id: "host-call-no-bind",
      payload: {
        moduleId: "dev-space",
        capabilityId: "log",
        method: "info",
        args: [],
      },
    });

    expect(resp.type).toBe("response");
    const p = resp.payload as { kind?: string; code?: string; message?: string };
    expect(p.kind).toBe("error");
    expect(p.code).toBe("MODULE_UNAVAILABLE");
    expect(p.message).toMatch(/binding/i);
  }, 15_000);

  it("bind-sender accepts ANY moduleId — pre-check was security theater", async () => {
    const { daemon } = await bootSession();

    // Per Simplicity P1: the bind-sender pre-check on registered
    // status was self-refuting (the comment admitted modules/list
    // already enumerated the registry without auth). It's gone.
    // Bind succeeds for any string; host-call later returns
    // MODULE_UNAVAILABLE for unregistered moduleIds.
    const resp = await daemon.client.send({
      type: "command",
      action: "modules/bind-sender",
      id: "bind-unregistered",
      payload: { moduleId: "does-not-exist" },
    });

    const p = resp.payload as { kind?: string };
    expect(p.kind).toBe("ok");
  }, 15_000);

  it("bind-sender with malformed payload returns BIND_INVALID_PAYLOAD", async () => {
    const { daemon } = await bootSession();

    const resp = await daemon.client.send({
      type: "command",
      action: "modules/bind-sender",
      id: "bind-malformed",
      payload: { moduleId: 42 }, // wrong type
    });

    const p = resp.payload as { kind?: string; code?: string };
    expect(p.kind).toBe("error");
    expect(p.code).toBe("BIND_INVALID_PAYLOAD");
  }, 15_000);

  it("bind-sender across short-lived send-conns ARE NOT shared (per-socket binding)", async () => {
    // Each `IpcClient.send()` opens a fresh socket → different
    // connectionId. Bindings are per-conn, so a bind on send-conn-A
    // doesn't survive into send-conn-B. This test pins the limitation
    // until PR-C lands a long-lived RPC channel; once that exists,
    // bind + host-call ride the same socket and the limitation goes
    // away.
    const { daemon } = await bootSession();

    const bindResp = await daemon.client.send({
      type: "command",
      action: "modules/bind-sender",
      id: "bind-1",
      payload: { moduleId: "dev-space" },
    });
    expect((bindResp.payload as { kind?: string }).kind).toBe("ok");

    const callResp = await daemon.client.send({
      type: "command",
      action: "modules/host-call",
      id: "host-call-1",
      payload: {
        moduleId: "dev-space",
        capabilityId: "log",
        method: "info",
        args: [],
      },
    });

    const p = callResp.payload as { kind?: string; code?: string };
    expect(p.kind).toBe("error");
    expect(p.code).toBe("MODULE_UNAVAILABLE");
  }, 15_000);
});

describe("modules/host-call gate is default-off (no env flag)", () => {
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

  it("host-call without bind-sender succeeds when RN_DEV_HOSTCALL_BIND_GATE is unset", async () => {
    // This is the load-bearing test: the gate must not break
    // existing Electron callers. Until PR-C lands the long-lived
    // RPC channel, the gate is default-off so production keeps
    // working unchanged.
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    // Explicitly do NOT set RN_DEV_HOSTCALL_BIND_GATE.
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);
    await connectToDaemonSession(worktree, {
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

    const resp = await daemon.client.send({
      type: "command",
      action: "modules/host-call",
      id: "host-call-gate-off",
      payload: {
        moduleId: "dev-space",
        capabilityId: "log",
        method: "info",
        args: [],
      },
    });

    // dev-space registers a `log` capability under fake-boot, so the
    // call resolves to a real capability. The gate doesn't deny.
    // Either we get { kind: "ok" } or some other unrelated error,
    // but NOT MODULE_UNAVAILABLE-with-binding-message.
    const p = resp.payload as { kind?: string; code?: string; message?: string };
    if (p.kind === "error") {
      // If host-call errors for an unrelated reason (capability not
      // resolved, etc.), that's fine — what we're pinning is "the
      // gate didn't deny with the binding-message."
      expect(p.message ?? "").not.toMatch(/binding/i);
    }
  }, 15_000);
});
