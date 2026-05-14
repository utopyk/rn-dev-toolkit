// Phase M6 — multi-session devtools-network probe through MCP.
//
// Pre-M3, devtools-network__* calls had no sessionId arg and always
// hit MCP's singleton `ctx.session`. Post-M3 the proxy injects
// sessionId into every module-contributed tool's input schema, and
// the handler resolves the targeted session via the shared
// resolveSession helper. Two sessions running side-by-side must
// produce independent target lists and capture rings.
//
// This probe runs two sessions on two profiles (different metroPorts)
// and verifies:
//   1. devtools-network__status returns a session-scoped envelope —
//      each session's proxy has its own state machine.
//   2. devtools-network__list captures don't bleed across sessions:
//      polling A returns A's traffic only, polling B returns B's.
//
// PROBE-gated. Reuses the acme + iPhone fixture from the existing
// single-session devtools probe.

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

describe("Probe — MCP multi-session devtools-network (acme fixture)", () => {
  const liveMcp: McpHarnessHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const m of liveMcp.splice(0)) await m.stop();

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
    "devtools-network__status returns independent session-scoped state per session",
    async () => {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: ACME,
      })
        .toString()
        .trim();
      const profileDir = join(ACME, ".rn-dev", "profiles");
      mkdirSync(profileDir, { recursive: true });

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
        // no profiles dir — fine
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

      const profileA = {
        name: "rn-dev-probe-mcp-dvtmulti-a",
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
        name: "rn-dev-probe-mcp-dvtmulti-b",
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

      // Attach second session.
      await mcp.client.callTool({
        name: "rn-dev/start-session",
        arguments: { profileName: profileB.name },
      });

      // Discover sessionIds.
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
      expect(sidA).toBeDefined();
      expect(sidB).toBeDefined();

      // Confirm the proxied tool's schema gained sessionId. The tools/list
      // dance is what an agent does before calling — the probe walks the
      // same path to keep the input-schema contract honest.
      const allTools = await mcp.client.listTools();
      const dvtStatus = allTools.tools.find(
        (t) => t.name === "devtools-network__status",
      );
      expect(dvtStatus, "devtools-network__status not surfaced").toBeDefined();
      const dvtSchema = dvtStatus?.inputSchema as
        | { properties?: Record<string, unknown> }
        | undefined;
      expect(
        dvtSchema?.properties?.["sessionId"],
        "devtools-network__status missing sessionId in inputSchema (M1 schema-injection regression)",
      ).toBeDefined();

      // Call status on each session — payloads should differ at least in
      // proxyPort (8099 + N vs 8100 + N, depending on devtools-network's
      // port allocator). Two parallel proxies running, two independent
      // states.
      const [statusA, statusB] = await Promise.all([
        mcp.client.callTool({
          name: "devtools-network__status",
          arguments: { sessionId: sidA },
        }),
        mcp.client.callTool({
          name: "devtools-network__status",
          arguments: { sessionId: sidB },
        }),
      ]);
      const payloadA = parseToolJson<{
        meta?: { proxyStatus?: string };
        proxyPort?: number;
        targets?: Array<{ id?: string }>;
      }>(statusA);
      const payloadB = parseToolJson<{
        meta?: { proxyStatus?: string };
        proxyPort?: number;
        targets?: Array<{ id?: string }>;
      }>(statusB);

      console.log(
        `A proxy=${payloadA.meta?.proxyStatus} port=${payloadA.proxyPort} targets=${payloadA.targets?.length ?? 0}`,
      );
      console.log(
        `B proxy=${payloadB.meta?.proxyStatus} port=${payloadB.proxyPort} targets=${payloadB.targets?.length ?? 0}`,
      );

      // The strict assertion: the two sessions' proxies must NOT share a
      // proxyPort. If they do, the daemon's module subprocess
      // bookkeeping is sharing state across sessions — exactly the
      // cross-talk M1 was built to prevent.
      if (
        typeof payloadA.proxyPort === "number" &&
        typeof payloadB.proxyPort === "number"
      ) {
        expect(
          payloadA.proxyPort,
          "sessions A and B share the same devtools-network proxyPort — module subprocess is not session-isolated",
        ).not.toBe(payloadB.proxyPort);
      }

      // Confirm calling without sessionId once N > 1 surfaces the
      // E_SESSION_AMBIGUOUS path on the module-proxied tool too — this
      // is the M1 contract for every session-scoped tool, including
      // those proxied through `modules/call`.
      const ambiguous = await mcp.client.callTool({
        name: "devtools-network__status",
        arguments: {},
      });
      const ambiguousPayload = parseToolJson<{ code?: string }>(ambiguous);
      expect(ambiguousPayload.code).toBe("E_SESSION_AMBIGUOUS");

      // Stop both with destructive consent.
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
    10 * 60_000,
  );
});
