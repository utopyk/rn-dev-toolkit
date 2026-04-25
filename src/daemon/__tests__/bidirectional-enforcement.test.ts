import { describe, it, expect, afterEach } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";
import { IpcClient } from "../../core/ipc.js";
import path from "node:path";

describe("bidirectional flag enforcement", () => {
  const liveHandles: TestDaemonHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const h of liveHandles.splice(0)) await h.stop();
    for (const c of cleanups.splice(0)) c();
  });

  it("rejects RPC on a subscribe socket without supportsBidirectionalRpc", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const client = new IpcClient(path.join(worktree, ".rn-dev", "sock"));
    const sub = await client.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "sub-1",
        payload: {},   // no supportsBidirectionalRpc
      },
      { onEvent: () => {} },
    );
    try {
      const r = await sub.send({
        type: "command",
        action: "metro/reload",
        id: "rpc-x",
      });
      expect((r.payload as { code: string }).code).toBe("E_RPC_NOT_AUTHORIZED");
    } finally {
      sub.close();
    }
  });

  it("accepts RPC on a subscribe socket WITH supportsBidirectionalRpc", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const client = new IpcClient(path.join(worktree, ".rn-dev", "sock"));
    const sub = await client.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "sub-1",
        payload: { supportsBidirectionalRpc: true },
      },
      { onEvent: () => {} },
    );
    try {
      // The daemon will reply with E_SESSION_NOT_RUNNING because no
      // session/start was issued, but crucially NOT E_RPC_NOT_AUTHORIZED.
      const r = await sub.send({
        type: "command",
        action: "metro/reload",
        id: "rpc-x",
      });
      expect((r.payload as { code: string }).code).not.toBe("E_RPC_NOT_AUTHORIZED");
    } finally {
      sub.close();
    }
  });

  // P0-1 regression: modules/bind-sender + modules/host-call must ALSO be
  // blocked by the gate on a non-bidirectional subscribe socket. Before the
  // fix, handleMessage replied E_RPC_NOT_AUTHORIZED but the modules-ipc
  // listener still fired and persisted the bind / executed the host-call.
  it("modules/bind-sender + modules/host-call ALSO rejected on non-bidirectional subscribe socket", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: {
        RN_DEV_DAEMON_BOOT_MODE: "fake",
        // Gate on — any binding attempted below must be denied
        RN_DEV_HOSTCALL_BIND_GATE: "1",
      },
    });
    liveHandles.push(daemon);
    const sockPath = path.join(worktree, ".rn-dev", "sock");

    // ── Boot the session via a bidirectional subscriber ───────────────────
    // We need a running session so that the modules-ipc dispatcher is wired
    // up. Without this, modules/* messages return E_SESSION_NOT_RUNNING,
    // not MODULE_UNAVAILABLE, and the bind bypass can't be demonstrated.
    const profile = {
      name: "test",
      isDefault: true,
      worktree: null as string | null,
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
    const bootClient = new IpcClient(sockPath);
    const bootSub = await bootClient.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "sub-boot",
        payload: { supportsBidirectionalRpc: true, profile },
      },
      { onEvent: () => {} },
    );
    // Wait for "running" edge (fake boot emits it after ~30ms).
    await new Promise<void>((res, rej) => {
      const timeout = setTimeout(() => rej(new Error("session did not reach running")), 5_000);
      const poll = setInterval(async () => {
        try {
          const r = await bootSub.send({
            type: "command",
            action: "session/status",
            id: `status-${Date.now()}`,
          });
          const p = r.payload as { status?: string };
          if (p.status === "running") {
            clearTimeout(timeout);
            clearInterval(poll);
            res();
          }
        } catch {
          // retry
        }
      }, 100);
    });

    // ── Connection A: non-bidirectional subscribe socket ──────────────────
    const clientA = new IpcClient(sockPath);
    const subA = await clientA.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "sub-A",
        payload: {},   // no supportsBidirectionalRpc
      },
      { onEvent: () => {} },
    );

    // Send bind-sender on the non-bidirectional socket: the response must
    // be E_RPC_NOT_AUTHORIZED (from handleMessage), and crucially the
    // modules-ipc dispatcher must NOT have persisted the binding.
    const bindResp = await subA.send({
      type: "command",
      action: "modules/bind-sender",
      id: "bind-A",
      payload: { moduleId: "dev-space" },
    });
    expect((bindResp.payload as { code?: string }).code).toBe("E_RPC_NOT_AUTHORIZED");

    // Send host-call on the non-bidirectional socket: must also be rejected.
    const hostCallResp = await subA.send({
      type: "command",
      action: "modules/host-call",
      id: "hc-A",
      payload: { moduleId: "dev-space", capabilityId: "ping", method: "ping", args: [] },
    });
    expect((hostCallResp.payload as { code?: string }).code).toBe("E_RPC_NOT_AUTHORIZED");
    subA.close();

    // ── Connection B: BIDIRECTIONAL subscribe socket ───────────────────────
    // B must NOT inherit a binding that A was rejected for. If the gate bypass
    // existed (pre-fix), A's bind-sender would have persisted and B could
    // execute a host-call without its own bind. After the fix, B requires its
    // own explicit bind-sender before host-call can succeed.
    const clientB = new IpcClient(sockPath);
    const subB = await clientB.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "sub-B",
        payload: { supportsBidirectionalRpc: true },
      },
      { onEvent: () => {} },
    );
    try {
      // B has NOT yet called bind-sender — the host-call must fail with
      // MODULE_UNAVAILABLE (no binding for this conn), not "ok".
      const hcRespB = await subB.send({
        type: "command",
        action: "modules/host-call",
        id: "hc-B",
        payload: { moduleId: "dev-space", capabilityId: "ping", method: "ping", args: [] },
      });
      // Proves A's (rejected) bind was never persisted: if it had been,
      // B would share the same senderBindings table and host-call would
      // succeed even without B's own bind.
      expect((hcRespB.payload as { code?: string }).code).toBe("MODULE_UNAVAILABLE");
    } finally {
      subB.close();
      bootSub.close();
    }
  }, 20_000);
});
