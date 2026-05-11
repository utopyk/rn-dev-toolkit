import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
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

// M1b — MCP read-tool real-process gate.
//
// Catches the class of bug where a read tool's handler regresses such
// that the MCP transport returns a malformed response, the structured
// content shape drifts, or the tool gets disconnected from its
// underlying store. Every tool here goes:
//   SDK Client.callTool()
//   → MCP server stdio (CallTool request)
//   → registered handler in src/mcp/tools.ts
//   → ctx.profileStore / getWorktrees(ctx.projectRoot)
//   → CallTool response back over stdio
//   → SDK Client receives structuredContent
//
// In-process tests bypass the entire stdio + transport layer, so a bug
// in CallToolResult assembly (e.g., undefined names, missing
// inputSchema, content/structuredContent split drifted) would not
// surface there.
//
// See docs/plans/2026-05-06-tui-mcp-real-process-test-parity.md.

interface Profile {
  name: string;
  isDefault: boolean;
  branch: string;
  platform: string;
  mode: string;
}

/**
 * Most MCP tool handlers return plain data (e.g. `{ profiles: [...] }`),
 * which the server wraps as a single `content[0].text` JSON string. Only
 * a handful (session-logs) opt into the SDK's `structuredContent` shape.
 * This helper unwraps the legacy path so tests assert on the same data
 * the agent ultimately parses.
 *
 * If a future commit moves a tool from the legacy path to
 * `structuredContent`, this helper still works (we fall back to the
 * structured field when the text content is missing).
 */
function parseToolJson<T>(result: unknown): T {
  const r = result as {
    content?: Array<{ type: string; text: string }>;
    structuredContent?: T;
  };
  if (r.structuredContent) return r.structuredContent;
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(
      `Tool result has neither structuredContent nor a text content block: ${JSON.stringify(result)}`,
    );
  }
  return JSON.parse(text) as T;
}

describe("MCP read-tools e2e (M1b)", () => {
  const liveDaemons: TestDaemonHandle[] = [];
  const liveMcp: McpHarnessHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const m of liveMcp.splice(0)) await m.stop();
    for (const d of liveDaemons.splice(0)) await d.stop();
    for (const c of cleanups.splice(0)) c();
  });

  function writeProfiles(worktree: string): void {
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
    writeFileSync(
      join(profilesDir, "secondary.json"),
      JSON.stringify({
        name: "secondary",
        isDefault: false,
        worktree: null,
        branch: "develop",
        platform: "android",
        mode: "clean",
        metroPort: 8082,
        devices: {},
        buildVariant: "release",
        preflight: { checks: [], frequency: "once" },
        onSave: [],
        env: {},
        projectRoot: worktree,
      }),
    );
  }

  /**
   * Initialize the test worktree as a real git repo so
   * `rn-dev/list-worktrees` (which shells out to `git worktree list`)
   * doesn't fail. Without this, getWorktrees() returns an error
   * instead of an empty-ish list and the tool would surface that error.
   */
  function gitInit(worktree: string): void {
    execSync("git init -q", { cwd: worktree });
    execSync("git config user.email test@example.com", { cwd: worktree });
    execSync("git config user.name 'Test'", { cwd: worktree });
    execSync("git commit --allow-empty -m 'init' -q", { cwd: worktree });
  }

  async function setup(): Promise<{ worktree: string; mcp: McpHarnessHandle }> {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    writeProfiles(worktree);
    gitInit(worktree);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveDaemons.push(daemon);

    const mcp = await spawnMcpServer({ cwd: worktree });
    liveMcp.push(mcp);

    return { worktree, mcp };
  }

  it(
    "rn-dev/list-profiles returns both fixture profiles with stable shape",
    async () => {
      const { mcp } = await setup();

      const r = await mcp.client.callTool({
        name: "rn-dev/list-profiles",
        arguments: {},
      });

      const profiles = parseToolJson<{ profiles?: Profile[] }>(r).profiles;

      expect(profiles, `MCP stderr:\n${mcp.getStderr()}`).toBeDefined();
      const list = profiles ?? [];
      expect(list.length).toBe(2);
      const names = new Set(list.map((p) => p.name));
      expect(names.has("default")).toBe(true);
      expect(names.has("secondary")).toBe(true);

      // Stable-shape assertions: every profile has the fields agents
      // depend on. A regression that drops `branch` or `platform` from
      // the wire (e.g. ProfileStore serializer drift) would break agent
      // workflows silently.
      for (const p of list) {
        expect(typeof p.name).toBe("string");
        expect(typeof p.branch).toBe("string");
        expect(typeof p.platform).toBe("string");
        expect(typeof p.mode).toBe("string");
        expect(typeof p.isDefault).toBe("boolean");
      }
    },
    20_000,
  );

  it(
    "rn-dev/get-profile returns the default profile for branch=main",
    async () => {
      const { mcp } = await setup();

      const r = await mcp.client.callTool({
        name: "rn-dev/get-profile",
        arguments: {},
      });

      const profile = parseToolJson<{ profile?: Profile }>(r).profile;

      expect(profile, `MCP stderr:\n${mcp.getStderr()}`).toBeDefined();
      expect(profile?.name).toBe("default");
      expect(profile?.isDefault).toBe(true);
      expect(profile?.branch).toBe("main");
    },
    20_000,
  );

  it(
    "rn-dev/list-worktrees returns at least the current worktree",
    async () => {
      const { worktree, mcp } = await setup();

      const r = await mcp.client.callTool({
        name: "rn-dev/list-worktrees",
        arguments: {},
      });

      const parsed = parseToolJson<{ worktrees?: Array<{ path: string; branch?: string }> }>(r);
      const worktrees = parsed.worktrees;

      // Sanity: worktrees must be an array, not a serialized Promise
      // (`{}`) — the bug this test caught on its first run.
      expect(
        Array.isArray(worktrees),
        `Expected worktrees array; got ${typeof worktrees} (raw: ${JSON.stringify(parsed)}).`,
      ).toBe(true);
      const list = worktrees ?? [];
      expect(list.length).toBeGreaterThanOrEqual(1);
      // The current worktree should be in the list. `git worktree list`
      // resolves symlinks, so compare via endsWith instead of strict ===.
      const includesCurrent = list.some((w) => worktree.endsWith(w.path) || w.path.endsWith(worktree.split("/").slice(-1)[0]));
      expect(
        includesCurrent,
        `Expected list-worktrees to include ${worktree}; got ${JSON.stringify(list)}`,
      ).toBe(true);
    },
    20_000,
  );
});
