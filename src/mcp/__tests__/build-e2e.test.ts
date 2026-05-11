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

// M2a — MCP rn-dev/build daemon-RPC wire test (fake-boot).
//
// Pre-refactor: rn-dev/build shelled out via execSync to
// `npx react-native run-ios`, blocking the entire MCP server for the
// build's duration (10+ minutes). No observability — agents could not
// poll progress, and the synchronous handler defeated the wire model
// that every other tool uses.
//
// Post-refactor: rn-dev/build sends `builder/build` over the daemon
// RPC and returns immediately with `{ ok: true }`. Agents observe
// progress via session events (the kinds filter exposes session/log
// today; builder/* events will be added in a follow-up that surfaces
// build progress through a new tool — see the spawned task).
//
// This test gates the wire contract:
//   - rn-dev/build with a profile-shaped fixture round-trips through
//     the daemon's builder/build dispatcher (fake-boot's deterministic
//     line → progress → done sequence).
//   - The response is `{ ok: true }` for the happy path, mirroring the
//     daemon's actual return value.

describe("MCP rn-dev/build wire e2e (M2a)", () => {
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
        devices: { ios: "fake-device-udid", android: null },
        buildVariant: "debug",
        scheme: "FakeApp",
        configuration: "Debug",
        preflight: { checks: [], frequency: "once" },
        onSave: [],
        env: {},
        projectRoot: worktree,
      }),
    );
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
    "rn-dev/build sends builder/build over the daemon RPC and returns { ok: true }",
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
        name: "rn-dev/build",
        arguments: { platform: "ios", variant: "debug" },
      });

      const payload = parseToolJson<{ ok?: boolean; code?: string; message?: string }>(r);

      // Pre-refactor this returned { status: "failed", error: ... } because
      // execSync against an empty fixture would fail. Post-refactor the
      // daemon's fake builder accepts the call and returns { ok: true }.
      expect(
        payload.ok,
        `Expected daemon-side OK; got ${JSON.stringify(payload)}.\nMCP stderr:\n${mcp.getStderr()}\nDaemon stderr:\n${daemon.getStderr()}`,
      ).toBe(true);
    },
    20_000,
  );

  it(
    "rn-dev/build defaults platform/variant/scheme from the loaded profile when args omit them",
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

      // Call without platform — should fall back to profile.platform = ios.
      const r = await mcp.client.callTool({
        name: "rn-dev/build",
        arguments: {},
      });
      const payload = parseToolJson<{ ok?: boolean }>(r);
      expect(payload.ok).toBe(true);
    },
    20_000,
  );

  it(
    "rn-dev/build-status surfaces fake-builder line/progress/done events to the agent",
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

      // Kick off the (fake) build.
      await mcp.client.callTool({
        name: "rn-dev/build",
        arguments: { platform: "ios" },
      });

      // Fake builder emits line → progress → done synchronously
      // (separate ticks). Poll up to ~5s for all three to arrive in
      // the BuilderClient ring on the MCP side.
      type Event = { kind: "line" | "progress" | "done"; data: unknown };
      let events: Event[] = [];
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const r = await mcp.client.callTool({
          name: "rn-dev/build-status",
          arguments: { limit: 100 },
        });
        const payload = parseToolJson<{ events?: Event[] }>(r);
        events = payload.events ?? [];
        if (events.some((e) => e.kind === "done")) break;
        await new Promise((res) => setTimeout(res, 100));
      }

      const kinds = events.map((e) => e.kind);
      expect(
        kinds,
        `Expected line + progress + done from fake builder.\nMCP stderr:\n${mcp.getStderr()}\nDaemon stderr:\n${daemon.getStderr()}`,
      ).toEqual(expect.arrayContaining(["line", "progress", "done"]));

      const done = events.find((e) => e.kind === "done");
      expect((done?.data as { success?: boolean })?.success).toBe(true);
    },
    20_000,
  );
});
