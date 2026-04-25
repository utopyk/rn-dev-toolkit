import { afterEach, describe, expect, it } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../test/helpers/spawnTestDaemon.js";
import { connectToDaemonSession } from "../../src/app/client/session.js";
import type { Profile } from "../../src/core/types.js";

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

// Phase 13.4.1 merge gate — integration test #6. Pins the three new
// daemon RPCs the Electron panel-bridge depends on after the handler
// flip. Without these, panels can't fetch their manifest contribution
// (`modules/resolve-panel`), the renderer sidebar can't enumerate
// available panels (`modules/list-panels`), and host-capability calls
// from a panel preload can't reach the daemon's CapabilityRegistry
// (`modules/host-call`).
//
// The plan's broader "panel subprocess survives Electron drop" check
// lives in the follow-up — it needs a fake 3p module that registers
// both a panel and a host capability, which requires spawning a real
// subprocess under the daemon. That infrastructure lands alongside
// Phase 13.5 when the panel-bridge itself moves to daemon-side
// coordination. This test covers the wire contract; the follow-up
// covers the lifecycle contract.
//
// Uses `RN_DEV_DAEMON_BOOT_MODE=fake` so the supervisor exercises the
// module-system load path without Metro side effects — the built-in
// modules still register, so `modules/list-panels` has something
// non-empty to project.

describe("Phase 13.4.1 panel-bridge daemon RPCs (merge gate)", () => {
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

  async function bootSession(
    worktree: string,
  ): Promise<{ daemon: TestDaemonHandle; session: Awaited<ReturnType<typeof connectToDaemonSession>> }> {
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);
    // The modules IPC dispatcher only registers after the session is
    // running — mirror what Electron does by using connectToDaemonSession.
    // Phase 13.5 — disconnect() now decrements the daemon's session
    // refcount; with this client as the only attacher, disconnecting
    // would tear the session down before the test can issue its
    // modules/* RPCs. Keep the session attached until afterEach tears
    // down the daemon process (which closes our socket implicitly).
    const session = await connectToDaemonSession(worktree, fakeProfile(worktree));
    return { daemon, session };
  }

  it("modules/host-call returns MODULE_UNAVAILABLE when moduleId is not registered", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const { daemon } = await bootSession(worktree);

    const resp = await daemon.client.send({
      type: "command",
      action: "modules/host-call",
      id: "host-call-1",
      payload: {
        moduleId: "does-not-exist",
        capabilityId: "log",
        method: "info",
        args: ["hello"],
      },
    });

    expect(resp.type).toBe("response");
    const p = resp.payload as { kind?: string; code?: string };
    expect(p.kind).toBe("error");
    expect(p.code).toBe("MODULE_UNAVAILABLE");
  }, 15_000);

  it("modules/host-call returns HOST_CALL_FAILED on malformed payload", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const { daemon } = await bootSession(worktree);

    const resp = await daemon.client.send({
      type: "command",
      action: "modules/host-call",
      id: "host-call-bad",
      payload: { moduleId: 42, capabilityId: "log", method: "info" },
    });

    const p = resp.payload as { kind?: string; code?: string };
    expect(p.kind).toBe("error");
    expect(p.code).toBe("HOST_CALL_FAILED");
  }, 15_000);

  it("modules/list-panels returns { modules: [] } when no panel-contributing module is registered", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const { daemon } = await bootSession(worktree);

    const resp = await daemon.client.send({
      type: "command",
      action: "modules/list-panels",
      id: "list-panels-1",
    });

    expect(resp.type).toBe("response");
    const p = resp.payload as { modules?: unknown[] };
    expect(Array.isArray(p.modules)).toBe(true);
    // Built-ins don't contribute electron panels today — the renderer-side
    // Marketplace + Settings are implemented as regular React views, not
    // 3p-panel WebContentsViews. So the expected shape here is an empty
    // array. When a future built-in starts contributing a panel, update
    // this assertion to reference it by moduleId.
    expect(p.modules).toEqual([]);
  }, 15_000);

  it("modules/resolve-panel returns an error when moduleId is not registered", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);

    const { daemon } = await bootSession(worktree);

    const resp = await daemon.client.send({
      type: "command",
      action: "modules/resolve-panel",
      id: "resolve-panel-1",
      payload: { moduleId: "nope", panelId: "also-nope" },
    });

    const p = resp.payload as { kind?: string; code?: string };
    expect(p.kind).toBe("error");
    expect(p.code).toBe("E_PANEL_NOT_FOUND");
  }, 15_000);
});
