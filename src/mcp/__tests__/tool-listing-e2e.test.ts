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

// M1a — MCP tool-listing real-process gate.
//
// Until this landed, the only real-process MCP test was session-logs-e2e.
// That proves the boot path works for *one* tool. A bug like "tool
// registration regressed and the build/preflight/profile families never
// reach the SDK Client" would slip past the in-process tests (they call
// handlers directly, bypassing tool registration).
//
// This spawns the real MCP server, calls listTools(), and asserts that a
// curated stable subset of built-in tool names round-trips. We don't
// assert on the full 31-tool count because that's fragile to additions —
// the goal is "the boot path produced a usable tool registry for an
// agent," not "the registry is exactly N entries."
//
// See docs/plans/2026-05-06-tui-mcp-real-process-test-parity.md for the
// broader M1 plan.

const STABLE_TOOLS = [
  "rn-dev/start-session",
  "rn-dev/stop-session",
  "rn-dev/list-sessions",
  "rn-dev/session-logs",
  "rn-dev/build",
  "rn-dev/clean",
  "rn-dev/list-devices",
  "rn-dev/list-worktrees",
  "rn-dev/list-profiles",
  "rn-dev/get-profile",
  "rn-dev/modules-list",
] as const;

describe("MCP tool listing e2e (M1a)", () => {
  const liveDaemons: TestDaemonHandle[] = [];
  const liveMcp: McpHarnessHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    // MCP first — see session-logs-e2e for the rationale (closing the
    // client drops the daemon refcount before we tear the daemon down).
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
    "MCP server boot exposes the stable built-in tool set via listTools()",
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

      const result = await mcp.client.listTools();
      const names = new Set(result.tools.map((t) => t.name));

      const missing = STABLE_TOOLS.filter((n) => !names.has(n));
      expect(
        missing,
        `Stable tools missing from listTools() — boot path produced a partial registry.\nMCP stderr:\n${mcp.getStderr()}\nDaemon stderr:\n${daemon.getStderr()}`,
      ).toEqual([]);

      // Sanity: every entry has a non-empty name and an inputSchema. A
      // bug that shipped tools with undefined names would otherwise hide
      // here (Set dedups undefineds to one entry).
      for (const tool of result.tools) {
        expect(typeof tool.name).toBe("string");
        expect(tool.name.length).toBeGreaterThan(0);
        expect(tool.inputSchema).toBeDefined();
      }
    },
    20_000,
  );
});
