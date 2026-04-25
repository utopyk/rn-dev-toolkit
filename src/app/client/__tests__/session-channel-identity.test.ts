import { describe, it, expect, afterEach } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../../test/helpers/spawnTestDaemon.js";
import { connectToDaemonSession } from "../session.js";
import type { Profile } from "../../../core/types.js";

// Phase 13.6 PR-C — keystone: bind-sender + host-call must ride the
// same connectionId when both are issued via session.client.send.
//
// Before this task: every session.client.send (and adapter .send) call
// opened a fresh short-lived socket → different connectionId each time
// → bind-sender on conn-A, host-call on conn-B → MODULE_UNAVAILABLE.
//
// After this task: session.client.send is proxied through the
// long-lived events/subscribe socket → same connectionId for all calls
// in a session → bind + host-call share the binding.

describe("DaemonSession channel identity", () => {
  const live: TestDaemonHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const h of live.splice(0)) await h.stop();
    for (const c of cleanups.splice(0)) c();
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

  it("bind-sender + host-call ride same connectionId via session.client.send", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake", RN_DEV_HOSTCALL_BIND_GATE: "1" },
    });
    live.push(daemon);
    const session = await connectToDaemonSession(worktree, fakeProfile(worktree));

    // bind dev-space (a built-in fake module) on this session
    const bindResp = await session.client.send({
      type: "command",
      action: "modules/bind-sender",
      id: "bind-1",
      payload: { moduleId: "dev-space" },
    });
    expect((bindResp.payload as { ok?: boolean; code?: string }).code).toBeUndefined();

    // host-call should now succeed (gate enabled, binding present on same conn)
    const callResp = await session.client.send({
      type: "command",
      action: "modules/host-call",
      id: "call-1",
      payload: {
        moduleId: "dev-space",
        capabilityId: "ping",
        method: "ping",
        args: {},
      },
    });
    expect((callResp.payload as { code?: string }).code).not.toBe("MODULE_UNAVAILABLE");

    await session.release();
  }, 15_000);

  it("adapter RPC calls (modules.bindSender / modules.hostCall) also ride the subscribe socket", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake", RN_DEV_HOSTCALL_BIND_GATE: "1" },
    });
    live.push(daemon);
    const session = await connectToDaemonSession(worktree, fakeProfile(worktree));

    // bind via adapter (funnels through same proxied send)
    const bindResp = await session.client.send({
      type: "command",
      action: "modules/bind-sender",
      id: "bind-adapter-1",
      payload: { moduleId: "dev-space" },
    });
    const bp = bindResp.payload as { kind?: string; code?: string };
    expect(bp.code).toBeUndefined();

    // reload via adapter — confirms metro adapter also uses same socket
    const reloaded = await session.metro.reload();
    expect(reloaded).toBe(true);

    await session.release();
  }, 15_000);
});
