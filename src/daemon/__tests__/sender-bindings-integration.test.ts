import { afterEach, describe, expect, it } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";
import { connectToDaemonSession } from "../../app/client/session.js";
import type { Profile } from "../../core/types.js";

// Phase 13.6 PR-C — end-to-end gate behavior.
//
// Gate is default-ON. The env flag stays as an emergency off-switch
// (`RN_DEV_HOSTCALL_BIND_GATE=0` to disable). Production callers
// (Electron, MCP) ride a long-lived multiplexed subscribe socket
// (connectToDaemonSession), so bind-sender and host-call share
// connectionId.
//
// These tests pin both behaviors: tests that need the gate ON leave
// the env unset (default); the test that pins the gate-OFF semantic
// sets RN_DEV_HOSTCALL_BIND_GATE=0 explicitly.

describe("modules/bind-sender + host-call gate (integration)", () => {
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
    // Gate is default-ON; no explicit env flag needed.
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
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

describe("modules/host-call gate explicitly disabled (RN_DEV_HOSTCALL_BIND_GATE=0)", () => {
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

  it("host-call without bind-sender succeeds when gate is explicitly off", async () => {
    // Pins the gate-OFF semantic: when an operator sets
    // RN_DEV_HOSTCALL_BIND_GATE=0, host-call proceeds without a
    // prior bind-sender. This is the emergency off-switch path.
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    // Explicitly disable the gate via env flag.
    const daemon = await spawnTestDaemon(worktree, {
      env: {
        RN_DEV_DAEMON_BOOT_MODE: "fake",
        RN_DEV_HOSTCALL_BIND_GATE: "0",
      },
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
    // call resolves to a real capability. With the gate disabled, the
    // binding check is skipped — either we get { kind: "ok" } or some
    // other unrelated error, but NOT MODULE_UNAVAILABLE-with-binding-message.
    const p = resp.payload as { kind?: string; code?: string; message?: string };
    if (p.kind === "error") {
      // If host-call errors for an unrelated reason (capability not
      // resolved, etc.), that's fine — what we're pinning is "the
      // gate didn't deny with the binding-message."
      expect(p.message ?? "").not.toMatch(/binding/i);
    }
  }, 15_000);
});
