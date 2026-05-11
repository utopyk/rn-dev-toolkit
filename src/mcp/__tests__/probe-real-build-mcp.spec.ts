// MCP-side analog of tests/electron-real-e2e/probe-real-build.spec.ts.
//
// Spawns the real MCP server against the user's acme fixture, calls
// rn-dev/build, and polls rn-dev/build-status to observe progress
// — the exact agent flow we want to certify works for production
// agents driving the daemon via MCP.
//
// PROBE-gated, like the Electron probe. Set PROBE=1 to run; otherwise
// it skips. Mirrors the long-session pattern: 12 minutes of build
// observation, screenshots / DOM are replaced with periodic polls of
// the build-status tool.
//
// What this proves end-to-end:
//   1. MCP boots against a real RN profile + project.
//   2. connectToDaemonSession spawns the daemon and joins the running
//      session.
//   3. rn-dev/build over MCP → builder/build over daemon RPC → real
//      xcodebuild + react-native CLI run.
//   4. Builder events flow back through events/subscribe → BuilderClient
//      ring → rn-dev/build-status tool — agents can observe progress.
//   5. The build either succeeds (done.success === true) or surfaces
//      diagnostics in line events the agent can read.
//
// See docs/plans/2026-05-06-tui-mcp-real-process-test-parity.md (Phase
// M2a) for the broader plan.

import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

describe("Probe — real build via MCP against acme + iPhone", () => {
  const liveMcp: McpHarnessHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const m of liveMcp.splice(0)) await m.stop();

    // Same daemon-leak fix as tests/electron-real-e2e/probe-real-build:
    // the daemon was spawned (detached) by connectToDaemonSession during
    // MCP boot. Closing the SDK client drops the subscribe-socket
    // refcount, but the daemon doesn't always exit promptly — we've
    // observed it surviving the test and squatting on the metro port.
    // Read the pid from .rn-dev/pid, SIGTERM with a 5s grace, SIGKILL
    // backstop. ESRCH is the happy case.
    const pidPath = join(ACME, ".rn-dev", "pid");
    let daemonPid: number | null = null;
    try {
      const raw = readFileSync(pidPath, "utf8").trim();
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) daemonPid = parsed;
    } catch {
      // pid file already gone — daemon exited cleanly.
    }
    if (daemonPid !== null) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
          console.warn(`SIGTERM to daemon pid ${daemonPid} failed:`, err);
        }
      }
      const killDeadline = Date.now() + 5_000;
      while (Date.now() < killDeadline) {
        try {
          process.kill(daemonPid, 0);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") {
            daemonPid = null;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (daemonPid !== null) {
        try {
          process.kill(daemonPid, "SIGKILL");
          console.warn(`Daemon pid ${daemonPid} did not exit on SIGTERM within 5s; SIGKILLed.`);
        } catch {
          // Already gone — fine.
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
    "rn-dev/build kicks a real iOS build and rn-dev/build-status surfaces progress",
    async () => {
      // Reuse the Electron probe's profile-write approach so the same
      // scheme/configuration/device pinning applies. A throwaway
      // profile name keeps this test from interfering with the user's
      // real default profile.
      const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: ACME }).toString().trim();
      const profileDir = join(ACME, ".rn-dev", "profiles");
      mkdirSync(profileDir, { recursive: true });

      // The fixture may have an existing isDefault:true profile (the
      // user's actual default). MCP's auto-pick uses
      // `profiles.find((p) => p.isDefault)` against readdirSync's
      // FS-determined order, which is NOT guaranteed alphabetical.
      // Flip every existing default to non-default for the duration
      // of the probe so our probe profile is the only one returned.
      // Restore on cleanup so the user's environment isn't left
      // mutated.
      const flippedProfiles: Array<{ path: string; original: string }> = [];
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
              flippedProfiles.push({ path: fp, original });
            }
          } catch {
            // Malformed profile — skip.
          }
        }
      } catch {
        // No existing profiles dir contents — fine.
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

      const profileName = "rn-dev-probe-real-build-mcp";
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
          rmSync(join(ACME, ".rn-dev", "sock"), { force: true });
        } catch {
          // best-effort
        }
      });

      const mcp = await spawnMcpServer({ cwd: ACME });
      liveMcp.push(mcp);

      // Quick sanity check that listTools succeeds before kicking the build.
      const tools = await mcp.client.listTools();
      expect(tools.tools.find((t) => t.name === "rn-dev/build")).toBeDefined();

      // Kick the build off — should return { ok: true } immediately.
      const buildResp = await mcp.client.callTool({
        name: "rn-dev/build",
        arguments: { platform: "ios" },
      });
      const buildPayload = parseToolJson<{ ok?: boolean; code?: string; message?: string }>(
        buildResp,
      );
      expect(
        buildPayload.ok,
        `rn-dev/build did not ack: ${JSON.stringify(buildPayload)}`,
      ).toBe(true);

      // Poll build-status every 10s for up to 12 minutes. Print a
      // sample of recent events so the test log shows ongoing progress
      // (matches the Electron probe's screenshot cadence).
      const deadline = Date.now() + 12 * 60_000;
      let lastSeenCount = 0;
      let done: BuildStatusEvent | undefined;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 10_000));
        const r = await mcp.client.callTool({
          name: "rn-dev/build-status",
          arguments: { limit: 500 },
        });
        const payload = parseToolJson<{ events?: BuildStatusEvent[] }>(r);
        const events = payload.events ?? [];
        if (events.length > lastSeenCount) {
          const recent = events.slice(lastSeenCount);
          for (const evt of recent.slice(-6)) {
            const kind = evt.kind;
            const summary =
              kind === "line"
                ? (evt.data.text ?? "").slice(0, 200)
                : kind === "progress"
                  ? `phase: ${evt.data.phase}`
                  : `success: ${evt.data.success}`;
            console.log(`  ${kind}: ${summary}`);
          }
          lastSeenCount = events.length;
        }
        done = events.find((e) => e.kind === "done");
        if (done) break;
      }

      const r = await mcp.client.callTool({
        name: "rn-dev/build-status",
        arguments: { limit: 500 },
      });
      const finalEvents = parseToolJson<{ events?: BuildStatusEvent[] }>(r).events ?? [];

      const kinds = finalEvents.map((e) => e.kind);
      console.log(
        `\nFINAL — line: ${kinds.filter((k) => k === "line").length}, ` +
          `progress: ${kinds.filter((k) => k === "progress").length}, ` +
          `done: ${kinds.filter((k) => k === "done").length}`,
      );

      // The point is OBSERVABILITY: agents must be able to see SOMETHING
      // happen. Whether xcodebuild succeeds depends on the cert chain,
      // which we don't gate here. Pre-refactor (synchronous execSync
      // build), the build-status tool didn't exist and there'd be zero
      // events to observe.
      expect(
        finalEvents.length,
        "rn-dev/build-status returned zero events — builder/* is not flowing through MCP.",
      ).toBeGreaterThan(0);

      // After the build completes, give the iPhone app a chance to
      // launch and emit traffic + Metro logs, then poll the
      // devtools-network and metro-logs modules through MCP. This is
      // the M2d coverage layer — proves real captured data flows
      // back to agents, not just module subprocesses being alive.
      // Skipped when the build never finished (`done` undefined) —
      // there's no app to observe.
      if (done && done.data.success) {
        console.log("\n--- M2d: polling devtools-network + metro-logs ---");
        // The iPhone app needs ~30-60s after react-native run-ios
        // returns to actually finish launching + connect its CDP
        // bridge to the proxy. Poll for up to 120s; print whatever
        // arrives so the test log surfaces the agent-visible data.
        const m2dDeadline = Date.now() + 120_000;
        let captureSeen = false;
        let metroLineSeen = false;
        let targetSelected = false;
        while (Date.now() < m2dDeadline) {
          await new Promise((res) => setTimeout(res, 5_000));

          const dn = await mcp.client.callTool({
            name: "devtools-network__status",
            arguments: {},
          });
          const dnPayload = parseToolJson<{
            meta?: { proxyStatus?: string };
            targets?: Array<{ id?: string; title?: string }>;
            proxyPort?: number;
            rnVersion?: string | null;
          }>(dn);
          console.log(
            `devtools-network__status: proxy=${dnPayload.meta?.proxyStatus} ` +
              `port=${dnPayload.proxyPort} targets=${dnPayload.targets?.length ?? 0} ` +
              `selected=${targetSelected}`,
          );

          // Once targets surface, select the first one — without this
          // proxyStatus stays "no-target" and no traffic gets captured.
          // This mirrors what an agent would do: see targets in
          // __status, pick one, then start polling __list.
          const targets = dnPayload.targets ?? [];
          if (!targetSelected && targets.length > 0 && targets[0]?.id) {
            const targetId = targets[0].id;
            const selectResp = await mcp.client.callTool({
              name: "devtools-network__select-target",
              arguments: { targetId },
            });
            const selectPayload = parseToolJson<Record<string, unknown>>(selectResp);
            console.log(
              `devtools-network__select-target("${targetId}") -> ${JSON.stringify(selectPayload).slice(0, 200)}`,
            );
            targetSelected = true;
          }

          if (targetSelected) {
            const dnList = await mcp.client.callTool({
              name: "devtools-network__list",
              arguments: { limit: 20 },
            });
            const dnListPayload = parseToolJson<{
              entries?: Array<{ url?: string; method?: string; status?: number }>;
            }>(dnList);
            const entries = dnListPayload.entries ?? [];
            console.log(`devtools-network__list: ${entries.length} captured entries`);
            for (const e of entries.slice(0, 5)) {
              console.log(`  ${e.method} ${e.status} ${(e.url ?? "").slice(0, 120)}`);
            }
            if (entries.length > 0) captureSeen = true;
          }

          const ml = await mcp.client.callTool({
            name: "metro-logs__list",
            arguments: { limit: 20 },
          });
          const mlPayload = parseToolJson<{
            entries?: Array<{ stream?: string; line?: string }>;
          }>(ml);
          const mlEntries = mlPayload.entries ?? [];
          if (mlEntries.length > 0 && !metroLineSeen) {
            console.log(`metro-logs__list: ${mlEntries.length} lines (showing first 5):`);
            for (const e of mlEntries.slice(0, 5)) {
              console.log(`  [${e.stream}] ${(e.line ?? "").slice(0, 200)}`);
            }
            metroLineSeen = true;
          }

          if (captureSeen && metroLineSeen) break;
        }

        console.log(
          `\nM2d coverage — devtools captures: ${captureSeen ? "YES" : "no"}, ` +
            `metro logs: ${metroLineSeen ? "YES" : "no"}, ` +
            `target selected: ${targetSelected ? "YES" : "no"}`,
        );
      }

      // If the build actually finished, surface the result. Don't
      // hard-fail on success===false — diagnostics are the point of the
      // probe, and a cert-related failure is informative.
      if (done) {
        console.log(
          `Build done — success: ${done.data.success}, errors: ${(done.data.errors ?? []).length}`,
        );
      } else {
        console.log("Build did not complete within 12m — observation cap reached.");
      }
    },
    20 * 60_000,
  );
});

