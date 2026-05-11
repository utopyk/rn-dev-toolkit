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

// M2-prereq — MCP session lifecycle e2e.
//
// Pre-fix: rn-dev/start-session, stop-session, list-sessions sent
// hyphen-cased RPC names (`start-session`) that the daemon never
// registered (it expects `session/start`). Every call fell through to
// the always-null ctx.metro fallback and returned
// `{ error: "No running session" }` regardless of actual state — agents
// could not start, stop, or observe a session through MCP.
//
// This test exercises the fixed wire and pins the new contract:
//   1. The session is already running when MCP boots (auto-started by
//      connectToDaemonSession with the default profile). list-sessions
//      returns it as a single-element array.
//   2. start-session is idempotent — returns the running session.
//   3. stop-session tears down the session via session/stop.
//   4. After stop, list-sessions returns an empty array.

interface SessionRow {
  status: string;
  worktreeKey?: string;
  attached?: number;
}

interface ListSessionsPayload {
  sessions?: SessionRow[];
}

describe("MCP session lifecycle e2e (M2-prereq)", () => {
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

  async function setup(): Promise<{ mcp: McpHarnessHandle; worktree: string }> {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    writeProfile(worktree);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveDaemons.push(daemon);

    const mcp = await spawnMcpServer({ cwd: worktree });
    liveMcp.push(mcp);

    return { mcp, worktree };
  }

  function parseToolJson<T>(result: unknown): T {
    const r = result as {
      content?: Array<{ type: string; text: string }>;
      structuredContent?: T;
    };
    if (r.structuredContent) return r.structuredContent;
    const text = r.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error(`No usable content: ${JSON.stringify(result)}`);
    }
    return JSON.parse(text) as T;
  }

  it(
    "list-sessions reports the running session that connectToDaemonSession booted",
    async () => {
      const { mcp } = await setup();

      const r = await mcp.client.callTool({
        name: "rn-dev/list-sessions",
        arguments: {},
      });

      const payload = parseToolJson<ListSessionsPayload>(r);
      expect(payload.sessions).toBeDefined();
      expect(Array.isArray(payload.sessions)).toBe(true);
      expect(payload.sessions?.length).toBe(1);
      const session = payload.sessions?.[0];
      expect(session?.status).toMatch(/^(running|starting)$/);
    },
    20_000,
  );

  it(
    "start-session is idempotent — returns the already-running session",
    async () => {
      const { mcp } = await setup();

      const r = await mcp.client.callTool({
        name: "rn-dev/start-session",
        arguments: {},
      });

      const payload = parseToolJson<{ status?: string }>(r);
      // Pre-fix this returned { error: "No running session" }; post-fix
      // it surfaces the daemon's session/status payload (status is
      // "running" or "starting" depending on timing).
      expect(payload.status).toMatch(/^(running|starting)$/);
    },
    20_000,
  );

  it(
    "stop-session tears down via session/stop and list-sessions reflects it",
    async () => {
      const { mcp } = await setup();

      const stopResult = await mcp.client.callTool({
        name: "rn-dev/stop-session",
        arguments: {},
      });
      const stopPayload = parseToolJson<{ status?: string }>(stopResult);
      // stop returns { status: "stopped" } on success — not an "error"
      // surface, since stop-while-running is the happy path.
      expect(stopPayload.status).toBe("stopped");

      const listResult = await mcp.client.callTool({
        name: "rn-dev/list-sessions",
        arguments: {},
      });
      const listPayload = parseToolJson<ListSessionsPayload>(listResult);
      expect(listPayload.sessions).toEqual([]);
    },
    20_000,
  );
});
