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

// Bug 6 — MCP-side e2e merge gate.
//
// Before this test landed, the entire Phase-13.6 + Phase-13.4 test grid
// covered MCP behavior only by:
//   - calling `connectToDaemonSession` from inside vitest (verifies wire
//     contract but not the actual MCP-server-process behavior), and
//   - asserting tools list / handler outputs against a mocked context
//     (verifies tool-handler logic but not the server boot path).
//
// Neither layer would catch a bug like "MCP server's `kinds` filter
// excludes `session/log` events from the daemon, so `bootSessionServices`
// progress never lands in any tool's output." This test boots the actual
// MCP server as a child process via stdio, drives it through the real
// SDK `Client`, and asserts that daemon-emitted `session/log` lines
// round-trip into the new `rn-dev/session-logs` tool's output.
//
// Pattern transfers to TUI: a future TUI harness will spawn the CLI via
// node-pty, drive screen interactions, and assert the same round-trip.

interface SessionLogLine {
  level: string;
  message: string;
  ts: number;
}

describe("MCP session-logs e2e (Bug 6 merge gate)", () => {
  const liveDaemons: TestDaemonHandle[] = [];
  const liveMcp: McpHarnessHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    // MCP first — closing the client cleanly closes the SDK transport,
    // which closes our subscribe socket and drops the daemon's refcount
    // entry for this connection. Closing in the other order leaves a
    // stale entry that delays the daemon's last-release teardown until
    // the socket eventually closes itself.
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
    "rn-dev/session-logs returns daemon-emitted session/log lines from boot",
    async () => {
      // Spawn the daemon (fake boot — no real Metro). Fake-boot now
      // emits a `session/log` line via `opts.emit(...)` so the contract
      // production exercises (every `bootSessionServices` step calls
      // `emit(line)`) is honored under fake mode too.
      const { path: worktree, cleanup } = makeTestWorktree();
      cleanups.push(cleanup);
      writeProfile(worktree);

      const daemon = await spawnTestDaemon(worktree, {
        env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
      });
      liveDaemons.push(daemon);

      // Spawn the MCP server as a child process pointed at the same
      // worktree. MCP's `detectProjectRoot` + `ProfileStore` find the
      // profile we wrote; `connectToDaemonSession` finds the daemon's
      // socket at `<worktree>/.rn-dev/sock` and joins the running
      // session. The MCP server's SessionClient subscribe lands BEFORE
      // the daemon's bootAsync finishes, so the fake-boot emit() lines
      // flow into the SessionClient's internal ring (which the
      // `rn-dev/session-logs` tool reads on demand).
      const mcp = await spawnMcpServer({ cwd: worktree });
      liveMcp.push(mcp);

      // Poll session-logs until at least one line arrives. The tool
      // reads `SessionClient.recentLogs()` synchronously, so once the
      // daemon's emit() has fanned out and the MCP-side router has
      // dispatched, the tool returns the line. 5s budget is generous
      // for a fake-boot daemon.
      let lines: SessionLogLine[] = [];
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const r = await mcp.client.callTool({
          name: "rn-dev/session-logs",
          arguments: { limit: 50 },
        });
        const candidate = (r as unknown as {
          structuredContent?: { lines?: SessionLogLine[] };
        }).structuredContent?.lines;
        if (Array.isArray(candidate) && candidate.length > 0) {
          lines = candidate;
          break;
        }
        await new Promise((res) => setTimeout(res, 100));
      }

      expect(
        lines.length,
        `session-logs should have collected at least one line within 5s.\nMCP stderr:\n${mcp.getStderr()}\nDaemon stderr:\n${daemon.getStderr()}`,
      ).toBeGreaterThan(0);

      // Assert the fake-boot-emitted line round-tripped end-to-end:
      // daemon supervisor → events/subscribe → routeEventToAdapters
      // → SessionClient → tool output. The Bug 6 regression sat at the
      // routeEventToAdapters drop AND at the MCP kinds filter that
      // excluded session/log entirely. Pre-fix, this assertion fails.
      const messages = lines.map((l) => l.message);
      expect(messages).toContain("[fake-boot] session services starting");

      // Sanity: every line carries a level + numeric ts.
      for (const line of lines) {
        expect(typeof line.level).toBe("string");
        expect(typeof line.ts).toBe("number");
        expect(line.ts).toBeGreaterThan(0);
      }
    },
    20_000,
  );
});
