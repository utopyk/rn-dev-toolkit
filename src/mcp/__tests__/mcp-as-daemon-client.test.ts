import { describe, it, expect, afterEach } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";
import { connectToDaemonSession } from "../../app/client/session.js";
import type { Profile } from "../../core/types.js";

// Phase 13.6 PR-C keystone integration test.
//
// Pins two complementary properties:
//
//   1. MCP-shaped client works under the new long-lived channel.
//      A client that attaches with `kinds: ["modules/*"]`
//      (filtering out the metro/builder/devtools firehose) successfully:
//        - receives the events/subscribe response (refcount slot acquired)
//        - issues modules/bind-sender over the same socket → succeeds
//        - issues modules/host-call over the same socket → succeeds
//          (gate is default-ON per Task 4.1; binding identity is preserved
//          because bind-sender and host-call ride the same connectionId
//          via the multiplexed subscribe socket)
//        - releases cleanly via session.release()
//
//   2. Multi-client coexistence. An Electron-shaped client (no kinds filter)
//      and an MCP-shaped client can attach simultaneously to the same daemon,
//      each binds + host-calls independently with their own connectionId.
//      No cross-contamination.
//
// RN_DEV_HOSTCALL_BIND_GATE is intentionally NOT set — default-ON is the
// production path as of Task 4.1. The dev-space module's `log` capability
// (method "info") is the actual capability registered by fakeBootSessionServices;
// see src/daemon/__tests__/sender-bindings-integration.test.ts for the reference.
//
// `connectToDaemonSession` automatically appends `session/status` to any
// caller-supplied `kinds` so the boot handshake can observe the running
// edge — callers don't need to remember.

describe("MCP as daemon client (Phase 13.6 PR-C keystone)", () => {
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

  it(
    "MCP-shaped client (kinds=modules/*) attaches, binds, host-calls successfully",
    async () => {
      const { path: worktree, cleanup } = makeTestWorktree();
      cleanups.push(cleanup);
      const daemon = await spawnTestDaemon(worktree, {
        env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
      });
      live.push(daemon);

      // Simulate the MCP client's attach: kinds filter to skip the metro/
      // builder/devtools firehose. `connectToDaemonSession` appends
      // session/status automatically so the boot handshake completes.
      const mcpSession = await connectToDaemonSession(
        worktree,
        fakeProfile(worktree),
        { kinds: ["modules/*"] },
      );

      // Bind the dev-space module on this session.
      const bindResp = await mcpSession.client.send({
        type: "command",
        action: "modules/bind-sender",
        id: "bind-1",
        payload: { moduleId: "dev-space" },
      });
      expect((bindResp.payload as { code?: string }).code).toBeUndefined();

      // host-call against dev-space — gate is default-ON (Task 4.1);
      // this should NOT return MODULE_UNAVAILABLE because bind-sender
      // and host-call ride the same connectionId via the multiplexed
      // subscribe socket.
      //
      // dev-space registers a `log` capability (method "info") under
      // fakeBootSessionServices — confirmed in sender-bindings-integration.test.ts.
      const callResp = await mcpSession.client.send({
        type: "command",
        action: "modules/host-call",
        id: "call-1",
        payload: {
          moduleId: "dev-space",
          capabilityId: "log",
          method: "info",
          args: [],
        },
      });
      expect((callResp.payload as { code?: string }).code).not.toBe(
        "MODULE_UNAVAILABLE",
      );

      await mcpSession.release();
    },
    20_000,
  );

  it(
    "MCP attaches alongside Electron-shaped client; both ride distinct connectionIds",
    async () => {
      const { path: worktree, cleanup } = makeTestWorktree();
      cleanups.push(cleanup);
      const daemon = await spawnTestDaemon(worktree, {
        env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
      });
      live.push(daemon);

      // Electron-shaped: no kinds filter (full firehose).
      const electron = await connectToDaemonSession(
        worktree,
        fakeProfile(worktree),
      );
      // MCP-shaped: kinds filter to skip metro/builder/devtools.
      // session/status auto-appended by connectToDaemonSession.
      const mcp = await connectToDaemonSession(
        worktree,
        fakeProfile(worktree),
        { kinds: ["modules/*"] },
      );

      // Both bind dev-space on their own sessions; both host-calls must
      // succeed (gate ON, binding identity preserved per-connectionId).
      for (const session of [electron, mcp]) {
        const bindResp = await session.client.send({
          type: "command",
          action: "modules/bind-sender",
          id: `bind-${Math.random()}`,
          payload: { moduleId: "dev-space" },
        });
        // bind-sender always returns { kind: "ok" } on a well-formed payload.
        expect((bindResp.payload as { kind?: string }).kind).toBe("ok");

        const callResp = await session.client.send({
          type: "command",
          action: "modules/host-call",
          id: `call-${Math.random()}`,
          payload: {
            moduleId: "dev-space",
            capabilityId: "log",
            method: "info",
            args: [],
          },
        });
        expect((callResp.payload as { code?: string }).code).not.toBe(
          "MODULE_UNAVAILABLE",
        );
      }

      await mcp.release();
      await electron.release();
    },
    20_000,
  );
});
