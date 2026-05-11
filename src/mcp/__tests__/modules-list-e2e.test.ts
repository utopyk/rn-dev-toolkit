import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";
import {
  spawnMcpServer,
  type McpHarnessHandle,
} from "../../../test/helpers/spawnMcpServer.js";

// M1c — daemon-RPC round-trip via MCP.
//
// `rn-dev/modules-list` is the cleanest happy-path daemon-RPC surface
// to gate today: the handler issues `modules/list` over the long-lived
// subscribe socket via ctx.session.client.send (see ipcAction), and the
// daemon's modules-ipc dispatcher answers with the registered module
// list. fakeBootSessionServices wires the dispatcher up, so this works
// without a real Metro / RN toolchain.
//
// What this catches that in-process tests don't:
//   - long-lived subscribe socket lost framing between MCP and daemon
//   - bind-sender / connection-id propagation drifted
//   - okResult shape regressed from { structuredContent } to plain data
//   - modules dispatcher's response schema dropped the `modules` field
//
// The session-lifecycle tools (`rn-dev/start-session`, `stop-session`,
// `list-sessions`) are NOT used here even though the M1 plan originally
// pointed at them — they currently send hyphen-cased RPC names
// (start-session) that the daemon doesn't register (it expects
// session/start). Fix is tracked separately; see the corresponding
// spawned task.

interface ModulesListPayload {
  modules?: Array<{
    id: string;
    version: string;
    state: string;
    isBuiltIn: boolean;
  }>;
}

describe("MCP modules-list daemon-RPC e2e (M1c)", () => {
  const liveDaemons: TestDaemonHandle[] = [];
  const liveMcp: McpHarnessHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const m of liveMcp.splice(0)) await m.stop();
    for (const d of liveDaemons.splice(0)) await d.stop();
    for (const c of cleanups.splice(0)) c();
  });

  function writeProfile(worktree: string): void {
    const profilesDir = join(worktree, ".rn-dev", "profiles");
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(
      join(profilesDir, "default.json"),
      JSON.stringify({
        name: "default",
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
      }),
    );
  }

  it(
    "rn-dev/modules-list round-trips daemon modules dispatcher",
    async () => {
      const { path: worktree, cleanup } = makeTestWorktree();
      cleanups.push(cleanup);
      writeProfile(worktree);

      const daemon = await spawnTestDaemon(worktree, {
        env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
      });
      liveDaemons.push(daemon);

      const mcp = await spawnMcpServer({ cwd: worktree });
      liveMcp.push(mcp);

      const r = await mcp.client.callTool({
        name: "rn-dev/modules-list",
        arguments: {},
      });

      // modules-list uses okResult() which sets structuredContent
      // explicitly — the response should hit the structuredContent path,
      // not the legacy text-content fallback.
      const payload = (r as unknown as {
        structuredContent?: ModulesListPayload;
      }).structuredContent;
      expect(
        payload,
        `Expected structuredContent on modules-list response.\nMCP stderr:\n${mcp.getStderr()}\nDaemon stderr:\n${daemon.getStderr()}`,
      ).toBeDefined();
      expect(Array.isArray(payload?.modules)).toBe(true);

      // No assertion on the count: the test fixture has no modules
      // installed, so the list may be empty or contain whatever
      // built-ins fakeBootSessionServices registered. The wire contract
      // is what we're gating.
      for (const m of payload?.modules ?? []) {
        expect(typeof m.id).toBe("string");
        expect(typeof m.version).toBe("string");
        expect(typeof m.state).toBe("string");
        expect(typeof m.isBuiltIn).toBe("boolean");
      }

      // isError must NOT be set on a happy-path response. A `true`
      // here means the okResult / noSessionError split regressed.
      const isError = (r as { isError?: boolean }).isError;
      expect(isError).toBeFalsy();
    },
    20_000,
  );
});
