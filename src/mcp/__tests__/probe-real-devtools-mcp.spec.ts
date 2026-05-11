// Real-boot probe for devtools-network + metro-logs tools through MCP.
// PROBE-gated like probe-real-build-mcp.
//
// Different from M2b (module-proxy wire test): this exercises the
// actual installed module subprocesses, not a synthetic test manifest.
// Modules must be symlinked / installed under ~/.rn-dev/modules/
// (devtools-network and metro-logs ship in this repo at modules/*; a
// `bun run modules/<name>/build.ts` then `ln -sfn` to ~/.rn-dev/modules
// is enough).
//
// What this probe gates:
//   1. The daemon's loadUserGlobalModules picks up devtools-network
//      and metro-logs from ~/.rn-dev/modules/.
//   2. discoverModuleContributedTools surfaces each module's tools to
//      the SDK Client under <moduleId>__<tool>.
//   3. Calling devtools-network__status returns a structured envelope
//      (proxy state, CDP targets, version) — the agent's first call
//      before everything else.
//   4. Calling metro-logs__status returns Metro log capture state.
//
// What this probe does NOT cover (needs more setup):
//   - Live HTTP/HTTPS captured requests in devtools-network__list
//     (requires the iPhone app to be running and making requests through
//     the proxy). Today acme boots; future probe pushes a build, runs
//     the app, asserts captured traffic.
//   - metro-logs__list returning real Metro lines (requires Metro to be
//     active; the build probe shows Metro starts during builder/build).

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  spawnMcpServer,
  type McpHarnessHandle,
} from "../../../test/helpers/spawnMcpServer.js";

const ACME = process.env.PROBE_ACME ?? "/Users/martincouso/Documents/GitHub/acme-mobile-app";
const ENABLED = process.env.PROBE === "1" || process.env.PROBE_ACME === "1";

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

describe("Probe — real devtools-network + metro-logs through MCP (acme fixture)", () => {
  const liveMcp: McpHarnessHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const m of liveMcp.splice(0)) await m.stop();

    // Same daemon-leak teardown as probe-real-build-mcp.
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

  function flipExistingDefaults(profileDir: string): Array<{ path: string; original: string }> {
    const flipped: Array<{ path: string; original: string }> = [];
    try {
      const existing = readdirSync(profileDir).filter((f) => f.endsWith(".json"));
      for (const file of existing) {
        const fp = join(profileDir, file);
        const original = readFileSync(fp, "utf-8");
        try {
          const parsed = JSON.parse(original) as { isDefault?: boolean };
          if (parsed.isDefault === true) {
            parsed.isDefault = false;
            writeFileSync(fp, JSON.stringify(parsed, null, 2));
            flipped.push({ path: fp, original });
          }
        } catch {
          // malformed — skip
        }
      }
    } catch {
      // no profiles dir contents — fine
    }
    return flipped;
  }

  it.skipIf(!ENABLED)(
    "MCP exposes devtools-network__* and metro-logs__* tools and __status calls return structured payloads",
    async () => {
      // Same profile pinning approach as probe-real-build-mcp.
      const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: ACME }).toString().trim();
      const profileDir = join(ACME, ".rn-dev", "profiles");
      mkdirSync(profileDir, { recursive: true });

      const flipped = flipExistingDefaults(profileDir);
      cleanups.push(() => {
        for (const { path, original } of flipped) {
          try {
            writeFileSync(path, original);
          } catch {
            // best-effort
          }
        }
      });

      const profileName = "rn-dev-probe-devtools-mcp";
      const profilePath = join(profileDir, `${profileName}.json`);
      writeFileSync(
        profilePath,
        JSON.stringify(
          {
            name: profileName,
            isDefault: true,
            worktree: null,
            branch,
            platform: "ios",
            mode: "dirty",
            metroPort: 8099,
            devices: { ios: "00008130-001A653A3E11001C", android: null },
            buildVariant: "debug",
            scheme: "Acme",
            configuration: "Debug",
            // Skip preflight; we're not building, just exercising MCP.
            preflight: { checks: [], frequency: "once" },
            onSave: [],
            env: {},
            projectRoot: ACME,
            packageManager: "pnpm",
          },
          null,
          2,
        ),
      );
      cleanups.push(() => {
        try {
          rmSync(profilePath, { force: true });
        } catch {
          // best-effort
        }
      });

      const mcp = await spawnMcpServer({ cwd: ACME });
      liveMcp.push(mcp);

      // Pull session-logs to see what the daemon emitted at boot.
      // loadUserGlobalModules logs "Loaded N module manifest..." and
      // "Module manifest rejected (...)" lines — both are session/log
      // events that round-trip through MCP via rn-dev/session-logs.
      const logsResp = await mcp.client.callTool({
        name: "rn-dev/session-logs",
        arguments: { limit: 200 },
      });
      const logsPayload = (logsResp as { structuredContent?: { lines?: Array<{ message: string }> } }).structuredContent;
      const moduleLines = (logsPayload?.lines ?? []).filter((l) =>
        /Loaded|module|manifest/i.test(l.message),
      );
      console.log("session-logs (module-related):");
      for (const l of moduleLines) console.log(`  ${l.message}`);

      // Sanity: what does the daemon think is registered?
      const modulesListResp = await mcp.client.callTool({
        name: "rn-dev/modules-list",
        arguments: {},
      });
      const modulesPayload = (modulesListResp as { structuredContent?: { modules?: Array<{ id: string; tools?: unknown[] }> } }).structuredContent;
      console.log(
        "daemon modules-list:",
        JSON.stringify(
          modulesPayload?.modules?.map((m) => ({
            id: m.id,
            toolCount: Array.isArray(m.tools) ? m.tools.length : 0,
          })),
          null,
          2,
        ),
      );

      const tools = await mcp.client.listTools();
      const names = new Set(tools.tools.map((t) => t.name));
      const devtoolsTools = [...names].filter((n) => n.startsWith("devtools-network__"));
      const metroLogsTools = [...names].filter((n) => n.startsWith("metro-logs__"));

      console.log(`Tool surface — ${tools.tools.length} total tools`);
      console.log(`  devtools-network: ${devtoolsTools.length} —`, devtoolsTools);
      console.log(`  metro-logs:       ${metroLogsTools.length} —`, metroLogsTools);
      console.log("MCP stderr (last 2k):", mcp.getStderr().slice(-2000));

      expect(
        devtoolsTools.length,
        `Expected devtools-network tools surfaced via module proxy. ` +
          `Modules dir: ~/.rn-dev/modules/. MCP stderr:\n${mcp.getStderr()}`,
      ).toBeGreaterThan(0);
      expect(
        metroLogsTools.length,
        `Expected metro-logs tools surfaced via module proxy.`,
      ).toBeGreaterThan(0);

      // devtools-network__status — the safe-first call agents make.
      // Returns the capture envelope: proxy state, selected target, RN
      // version, buffer metadata. Should NOT error even with no app
      // running — the proxy is module-side state, not device-side.
      const statusResp = await mcp.client.callTool({
        name: "devtools-network__status",
        arguments: {},
      });
      const statusPayload = parseToolJson<Record<string, unknown>>(statusResp);
      console.log("\ndevtools-network__status response:");
      console.log(JSON.stringify(statusPayload, null, 2).slice(0, 2000));
      expect(
        (statusResp as { isError?: boolean }).isError,
        `devtools-network__status surfaced an error: ${JSON.stringify(statusPayload)}`,
      ).toBeFalsy();

      // metro-logs__status — capture state for Metro stdout/stderr.
      const metroStatusResp = await mcp.client.callTool({
        name: "metro-logs__status",
        arguments: {},
      });
      const metroStatusPayload = parseToolJson<Record<string, unknown>>(metroStatusResp);
      console.log("\nmetro-logs__status response:");
      console.log(JSON.stringify(metroStatusPayload, null, 2).slice(0, 2000));
      expect(
        (metroStatusResp as { isError?: boolean }).isError,
        `metro-logs__status surfaced an error: ${JSON.stringify(metroStatusPayload)}`,
      ).toBeFalsy();
    },
    60_000,
  );
});
