// Phase M6 — multi-session real build probe through MCP.
//
// Boots MCP against acme, opens TWO sessions via rn-dev/start-session
// { profileName }, kicks rn-dev/build on each (sessionId-routed), and
// polls rn-dev/build-status on both. Pins:
//
//   1. Multi-session boot end-to-end via MCP (Phase M3's profileName
//      flow + Phase D7's daemon multi-session supervisor).
//   2. Builder events ring per-session — A's `done` doesn't appear in
//      B's status, and vice versa. This is the cross-talk regression
//      Phase D3 fixed at the adapter layer.
//   3. resolveSession's E_SESSION_AMBIGUOUS surfaces when an agent
//      forgets to pass sessionId once N > 1.
//
// PROBE-gated. Needs two profile fixtures on disk with distinct
// metroPort and platform (or scheme). The probe writes them as
// throwaway profiles named `rn-dev-probe-mcp-multi-{ios,android}` so
// they don't collide with the user's actual defaults; cleanup
// restores any isDefault flags that were flipped during setup.

import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  spawnMcpServer,
  type McpHarnessHandle,
} from "../../../test/helpers/spawnMcpServer.js";

const ACME = process.env.PROBE_ACME ?? "/Users/martincouso/Documents/GitHub/acme-mobile-app";
const ENABLED = process.env.PROBE === "1" || process.env.PROBE_ACME === "1";

interface BuildStatusEvent {
  kind: "line" | "progress" | "done";
  ts: number;
  data: {
    text?: string;
    stream?: string;
    phase?: string;
    success?: boolean;
    errors?: unknown[];
    platform?: string;
  };
}

interface SessionRow {
  sessionId: string;
  profileName?: string;
  status: string;
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

describe("Probe — MCP multi-session parallel builds (acme fixture)", () => {
  const liveMcp: McpHarnessHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const m of liveMcp.splice(0)) await m.stop();

    // Same daemon-leak teardown as the single-session probes.
    const pidPath = join(ACME, ".rn-dev", "pid");
    let daemonPid: number | null = null;
    try {
      const raw = readFileSync(pidPath, "utf8").trim();
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) daemonPid = parsed;
    } catch {
      // already gone
    }
    if (daemonPid !== null) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch {
        // already gone
      }
      const killDeadline = Date.now() + 5_000;
      while (Date.now() < killDeadline) {
        try {
          process.kill(daemonPid, 0);
        } catch {
          daemonPid = null;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (daemonPid !== null) {
        try {
          process.kill(daemonPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    try {
      rmSync(pidPath, { force: true });
      rmSync(join(ACME, ".rn-dev", "sock"), { force: true });
    } catch {
      // best-effort
    }

    for (const c of cleanups.splice(0)) c();
  });

  it.skipIf(!ENABLED)(
    "two builds run concurrently on two sessions with independent builder rings",
    async () => {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: ACME,
      })
        .toString()
        .trim();
      const profileDir = join(ACME, ".rn-dev", "profiles");
      mkdirSync(profileDir, { recursive: true });

      // Like the single-session probe — flip every existing isDefault
      // off so our throwaways are the only auto-discoverable defaults.
      const flippedProfiles: Array<{ path: string; original: string }> = [];
      try {
        const existing = readdirSync(profileDir).filter((f) =>
          f.endsWith(".json"),
        );
        for (const file of existing) {
          const fp = join(profileDir, file);
          const original = readFileSync(fp, "utf-8");
          try {
            const parsed = JSON.parse(original) as { isDefault?: boolean };
            if (parsed.isDefault === true) {
              parsed.isDefault = false;
              writeFileSync(fp, JSON.stringify(parsed, null, 2));
              flippedProfiles.push({ path: fp, original });
            }
          } catch {
            // malformed — skip
          }
        }
      } catch {
        // no profiles dir yet — fine
      }
      cleanups.push(() => {
        for (const { path, original } of flippedProfiles) {
          try {
            writeFileSync(path, original);
          } catch {
            // best-effort
          }
        }
      });

      // Two throwaway profiles. Both target the same project but with
      // different metroPort (so the supervisor doesn't reject the second
      // boot with E_PORT_CONFLICT) and different names so an agent can
      // disambiguate. The first profile is marked isDefault so MCP's
      // boot path auto-attaches it.
      const profileA = {
        name: "rn-dev-probe-mcp-multi-a",
        isDefault: true,
        worktree: null,
        branch,
        platform: "ios" as const,
        mode: "dirty" as const,
        metroPort: 8099,
        devices: { ios: "00008130-001A653A3E11001C", android: null },
        buildVariant: "debug" as const,
        scheme: "Acme",
        configuration: "Debug",
        preflight: { checks: [], frequency: "once" as const },
        onSave: [],
        env: {},
        projectRoot: ACME,
        packageManager: "pnpm" as const,
      };
      const profileB = {
        ...profileA,
        name: "rn-dev-probe-mcp-multi-b",
        isDefault: false,
        metroPort: 8100,
      };

      const pathA = join(profileDir, `${profileA.name}.json`);
      const pathB = join(profileDir, `${profileB.name}.json`);
      writeFileSync(pathA, JSON.stringify(profileA, null, 2));
      writeFileSync(pathB, JSON.stringify(profileB, null, 2));
      cleanups.push(() => {
        try {
          rmSync(pathA, { force: true });
          rmSync(pathB, { force: true });
          rmSync(join(ACME, ".rn-dev", "sock"), { force: true });
        } catch {
          // best-effort
        }
      });

      const mcp = await spawnMcpServer({ cwd: ACME });
      liveMcp.push(mcp);

      // The first session is auto-attached by connectToDaemonSession at
      // MCP boot (it found profileA's isDefault flag). Open the second
      // session explicitly via M3's profileName flow.
      const startB = await mcp.client.callTool({
        name: "rn-dev/start-session",
        arguments: { profileName: profileB.name },
      });
      const startBPayload = parseToolJson<{
        sessionId: string;
        status: string;
      }>(startB);
      expect(startBPayload.sessionId).toBeDefined();

      // Confirm both sessions show up.
      const listResp = await mcp.client.callTool({
        name: "rn-dev/list-sessions",
        arguments: {},
      });
      const list = parseToolJson<{ sessions: SessionRow[] }>(listResp);
      const sidA = list.sessions.find(
        (s) => s.profileName === profileA.name,
      )?.sessionId;
      const sidB = list.sessions.find(
        (s) => s.profileName === profileB.name,
      )?.sessionId;
      expect(sidA, "session A missing from list-sessions").toBeDefined();
      expect(sidB, "session B missing from list-sessions").toBeDefined();
      expect(sidA).not.toBe(sidB);

      // Verify resolveSession's ambiguous-error path: a session-scoped
      // tool call without sessionId must refuse.
      const ambiguous = await mcp.client.callTool({
        name: "rn-dev/build-status",
        arguments: {},
      });
      const ambiguousPayload = parseToolJson<{ code?: string }>(ambiguous);
      expect(ambiguousPayload.code).toBe("E_SESSION_AMBIGUOUS");

      // Kick builds on both sessions in parallel.
      const [buildA, buildB] = await Promise.all([
        mcp.client.callTool({
          name: "rn-dev/build",
          arguments: { sessionId: sidA, platform: "ios" },
        }),
        mcp.client.callTool({
          name: "rn-dev/build",
          arguments: { sessionId: sidB, platform: "ios" },
        }),
      ]);
      const buildAPayload = parseToolJson<{ ok?: boolean }>(buildA);
      const buildBPayload = parseToolJson<{ ok?: boolean }>(buildB);
      expect(buildAPayload.ok).toBe(true);
      expect(buildBPayload.ok).toBe(true);

      // Poll build-status on both. Each session's BuilderClient has its
      // own ring, so events for A must not appear in B's output. 12-minute
      // observation cap is generous since the iPhone is shared and the
      // builds serialize at the device level even though MCP fires them
      // simultaneously.
      const deadline = Date.now() + 12 * 60_000;
      let aEvents: BuildStatusEvent[] = [];
      let bEvents: BuildStatusEvent[] = [];
      let aDone: BuildStatusEvent | undefined;
      let bDone: BuildStatusEvent | undefined;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 10_000));
        const [rA, rB] = await Promise.all([
          mcp.client.callTool({
            name: "rn-dev/build-status",
            arguments: { sessionId: sidA, limit: 500 },
          }),
          mcp.client.callTool({
            name: "rn-dev/build-status",
            arguments: { sessionId: sidB, limit: 500 },
          }),
        ]);
        aEvents = parseToolJson<{ events?: BuildStatusEvent[] }>(rA).events ?? [];
        bEvents = parseToolJson<{ events?: BuildStatusEvent[] }>(rB).events ?? [];
        aDone = aEvents.find((e) => e.kind === "done");
        bDone = bEvents.find((e) => e.kind === "done");
        if (aDone && bDone) break;
        if (aEvents.length === 0 && bEvents.length === 0) continue;
        console.log(
          `Progress — A: ${aEvents.length} events (done=${!!aDone}) | B: ${bEvents.length} events (done=${!!bDone})`,
        );
      }

      // Cross-talk assertion. Each session's ring carries its own
      // builds. We don't have a foolproof way to fingerprint events
      // per session at this layer (timestamps are wall-clock-aligned),
      // so we instead assert that:
      //   1. Both rings produced events (so both builds ran).
      //   2. Both rings had at least one event that is NOT in the other
      //      ring's set (rules out a bug where both sessions read the
      //      same underlying ring).
      expect(
        aEvents.length,
        "A produced zero builder events — multi-session adapter regression?",
      ).toBeGreaterThan(0);
      expect(
        bEvents.length,
        "B produced zero builder events — multi-session adapter regression?",
      ).toBeGreaterThan(0);

      const aTexts = new Set(
        aEvents.map((e) => `${e.kind}:${e.ts}:${(e.data.text ?? "").slice(0, 40)}`),
      );
      const bTexts = new Set(
        bEvents.map((e) => `${e.kind}:${e.ts}:${(e.data.text ?? "").slice(0, 40)}`),
      );
      const aOnly = [...aTexts].filter((t) => !bTexts.has(t));
      const bOnly = [...bTexts].filter((t) => !aTexts.has(t));
      expect(
        aOnly.length,
        "A has no events that B doesn't see — rings are not isolated",
      ).toBeGreaterThan(0);
      expect(
        bOnly.length,
        "B has no events that A doesn't see — rings are not isolated",
      ).toBeGreaterThan(0);

      // Clean stop both with destructive consent.
      await mcp.client.callTool({
        name: "rn-dev/stop-session",
        arguments: {
          sessionId: sidA,
          permissionsAccepted: ["rn-dev/stop-session"],
        },
      });
      await mcp.client.callTool({
        name: "rn-dev/stop-session",
        arguments: {
          sessionId: sidB,
          permissionsAccepted: ["rn-dev/stop-session"],
        },
      });
    },
    20 * 60_000,
  );
});
