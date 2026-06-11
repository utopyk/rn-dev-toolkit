import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// MCP auto-reconnect e2e (2026-06 acme battle-test blocker).
//
// Pre-fix: the MCP server opened ONE long-lived events/subscribe socket
// at boot (connectToDaemonSession) with no `disconnected` listener. A
// dead daemon socket — daemon killed, crashed, or upgraded underneath a
// live agent session — left EVERY session-scoped RPC throwing
// "connection already closed" until the whole MCP client (Claude Code)
// was restarted. This was THE blocker for rn-dev as a dependable
// primary agent tool: the failure that motivated it was a daemon
// kill during probe prep severing a live acme agent session.
//
// The fix wires `session.lifecycle.on("disconnected")` →
// boot-or-join reconnect with bounded backoff (cold-spawns a fresh
// daemon when the old one is gone). This test kills the daemon out
// from under a live MCP server and asserts the next list-sessions
// reflects a healthy, re-booted session — no client restart.

interface SessionRow {
  status: string;
  sessionId?: string;
}

interface ListSessionsPayload {
  sessions?: SessionRow[];
}

describe("MCP auto-reconnect e2e", () => {
  const liveDaemons: TestDaemonHandle[] = [];
  const liveMcp: McpHarnessHandle[] = [];
  const cleanups: Array<() => void> = [];
  const worktrees: string[] = [];

  afterEach(async () => {
    // MCP first — once it's gone, nothing can resurrect the daemon we
    // are about to kill.
    for (const m of liveMcp.splice(0)) await m.stop();
    for (const d of liveDaemons.splice(0)) await d.stop();
    // The reconnect path cold-spawns its OWN daemon, which no
    // TestDaemonHandle tracks. Kill it via the pid file so the suite
    // doesn't leak daemons.
    for (const wt of worktrees.splice(0)) {
      try {
        const raw = readFileSync(join(wt, ".rn-dev", "pid"), "utf-8");
        const parsed = JSON.parse(raw) as { pid?: number };
        const pid = typeof parsed.pid === "number" ? parsed.pid : Number(raw.trim());
        if (Number.isFinite(pid) && pid > 1) process.kill(pid, "SIGTERM");
      } catch {
        // No pid file / already dead — fine.
      }
    }
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
    "kills the daemon under a live session and the next RPCs see a re-booted session",
    async () => {
      const { path: worktree, cleanup } = makeTestWorktree();
      cleanups.push(cleanup);
      worktrees.push(worktree);
      writeProfile(worktree);

      const daemon = await spawnTestDaemon(worktree, {
        env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
      });
      liveDaemons.push(daemon);

      // RN_DEV_DAEMON_BOOT_MODE propagates: the MCP server inherits it,
      // and the daemon its reconnect path cold-spawns inherits it from
      // the MCP process — so the resurrected daemon also fake-boots.
      const mcp = await spawnMcpServer({
        cwd: worktree,
        env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
      });
      liveMcp.push(mcp);

      // Healthy baseline: one running session.
      const before = parseToolJson<ListSessionsPayload>(
        await mcp.client.callTool({ name: "rn-dev/list-sessions", arguments: {} }),
      );
      expect(before.sessions?.length).toBe(1);
      const beforeId = before.sessions?.[0]?.sessionId;

      // Kill the daemon out from under the live subscribe socket — the
      // exact failure shape from the battle-test.
      await daemon.stop();

      // Pre-fix: every subsequent session RPC threw "connection already
      // closed" forever. Post-fix: the disconnected listener re-runs
      // connectToDaemonSession with backoff (first attempt at +1s),
      // cold-spawning a fresh daemon. Poll until a running session
      // reappears.
      const deadline = Date.now() + 30_000;
      let recovered: SessionRow | undefined;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1_000));
        try {
          const now = parseToolJson<ListSessionsPayload>(
            await mcp.client.callTool({
              name: "rn-dev/list-sessions",
              arguments: {},
            }),
          );
          recovered = now.sessions?.find((s) => s.status === "running");
          if (recovered) break;
        } catch {
          // Transitional window (socket dead / daemon mid-spawn) — the
          // contract is that this becomes healthy WITHOUT restarting
          // the MCP client, not that no call ever errors.
        }
      }

      expect(
        recovered,
        `no running session reappeared within 30s of daemon kill — stderr:\n${mcp.getStderr().slice(-2000)}`,
      ).toBeDefined();
      // Sanity: the reconnect minted a fresh daemon-side session.
      expect(recovered?.sessionId).toBeDefined();
      expect(recovered?.sessionId).not.toBe(beforeId);
    },
    60_000,
  );
});
