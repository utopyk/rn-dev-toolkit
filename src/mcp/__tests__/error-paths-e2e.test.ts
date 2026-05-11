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

// M1d — MCP error-path real-process gate.
//
// The CallTool handler in src/mcp/server.ts wraps every `tool.handler`
// invocation in a try/catch and converts thrown errors into
// `{ isError: true, content: [{ type: "text", text: message }] }`.
// In-process tests don't go through this wrapper, so a regression that
// turned a thrown Error into a transport crash would surface only
// against the real stdio server.
//
// What this gates:
//   - Calling an unknown tool produces a structured error, not a
//     stalled / disconnected transport.
//   - The SDK Client receives the response and surfaces isError=true.
//   - The error message contains enough signal to diagnose the failure.

describe("MCP error-path e2e (M1d)", () => {
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

  async function setup(): Promise<{ mcp: McpHarnessHandle }> {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    writeProfile(worktree);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveDaemons.push(daemon);

    const mcp = await spawnMcpServer({ cwd: worktree });
    liveMcp.push(mcp);

    return { mcp };
  }

  it(
    "calling an unknown tool returns isError=true with a useful message, not a crashed transport",
    async () => {
      const { mcp } = await setup();

      // The SDK client may either resolve with isError=true or reject
      // with a JSON-RPC error — either is a "structured error", not a
      // transport crash. Both are acceptable for an unknown-tool call;
      // what we're gating is "the server kept the transport alive."
      let isError: boolean | undefined;
      let message: string | undefined;
      try {
        const r = await mcp.client.callTool({
          name: "rn-dev/this-tool-does-not-exist",
          arguments: {},
        });
        isError = (r as { isError?: boolean }).isError;
        const content = (r as { content?: Array<{ type: string; text: string }> })
          .content;
        message = content?.[0]?.text;
      } catch (err) {
        // SDK rejected — also acceptable. Capture so we can keep the
        // assertion shape uniform.
        message = err instanceof Error ? err.message : String(err);
        isError = true;
      }

      expect(
        isError,
        `Expected isError=true for unknown tool. Message: ${message}\nMCP stderr:\n${mcp.getStderr()}`,
      ).toBe(true);
      expect(typeof message).toBe("string");
      expect(message?.length ?? 0).toBeGreaterThan(0);

      // Sanity: a follow-up legitimate call still works after the error
      // path. Catches the regression where a thrown handler error
      // tears down the stdio transport for subsequent tool calls.
      const result = await mcp.client.callTool({
        name: "rn-dev/list-profiles",
        arguments: {},
      });
      expect((result as { isError?: boolean }).isError).toBeFalsy();
    },
    20_000,
  );
});
