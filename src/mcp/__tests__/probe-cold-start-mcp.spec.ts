// Phase M6 — cold-start probe for the MCP multi-session flow.
//
// Simulates an agent encountering a project with no prior context: it
// discovers profiles, picks one, starts a session, verifies it shows up,
// then stops it cleanly. The full discovery loop is the parity surface
// every multi-session-aware agent must be able to walk through.
//
// PROBE-gated so it doesn't run in the CI gate; ENABLED when the user
// is running PROBE=1 against acme (or any project with at least one
// profile on disk).
//
// Coverage path:
//   1. rn-dev/list-profiles                 — discover names
//   2. rn-dev/list-sessions                 — see what's already up
//   3. rn-dev/start-session { profileName } — boot the picked profile
//   4. rn-dev/list-sessions                 — confirm new session present
//   5. rn-dev/stop-session                  — destructive consent path
//   6. rn-dev/list-sessions                 — confirm teardown

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
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
  worktreeKey?: string;
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

describe("Probe — MCP cold-start discovery flow (acme fixture)", () => {
  const liveMcp: McpHarnessHandle[] = [];

  afterEach(async () => {
    for (const m of liveMcp.splice(0)) await m.stop();

    // Daemon teardown — same pattern as the other PROBE specs. The
    // discovery flow's last step is stop-session, but a probe failure
    // halfway can leave the daemon alive squatting on the metro port.
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
  });

  it.skipIf(!ENABLED)(
    "agent can discover → start → list → stop without prior session context",
    async () => {
      const mcp = await spawnMcpServer({ cwd: ACME });
      liveMcp.push(mcp);

      // Step 1 — discover available profile names.
      const profilesResp = await mcp.client.callTool({
        name: "rn-dev/list-profiles",
        arguments: {},
      });
      const profilesPayload = parseToolJson<{
        profiles: Array<{ name: string; isDefault?: boolean }>;
      }>(profilesResp);
      expect(profilesPayload.profiles.length).toBeGreaterThan(0);

      // Pick the default profile if one exists, otherwise the first
      // alphabetically. Production agents would typically prompt the
      // user, but for the probe we pick deterministically.
      const targetName =
        profilesPayload.profiles.find((p) => p.isDefault)?.name ??
        profilesPayload.profiles[0]?.name;
      expect(targetName).toBeDefined();
      console.log(`Cold-start probe targeting profile: ${targetName}`);

      // Step 2 — list-sessions before we touch anything.
      // MCP auto-attaches a session at boot for the default profile;
      // the post-list-profiles call may show 1 (the auto-attached) or 0
      // (no default profile) sessions. The probe tolerates either.
      const beforeResp = await mcp.client.callTool({
        name: "rn-dev/list-sessions",
        arguments: {},
      });
      const before = parseToolJson<{ sessions: SessionRow[] }>(beforeResp);
      console.log(`Sessions before start: ${before.sessions.length}`);

      // Step 3 — start-session { profileName }. If the profile is the
      // auto-attached default, the response carries alreadyAttached:true.
      const startResp = await mcp.client.callTool({
        name: "rn-dev/start-session",
        arguments: { profileName: targetName },
      });
      const start = parseToolJson<{
        sessionId: string;
        status: string;
        alreadyAttached?: boolean;
      }>(startResp);
      expect(start.sessionId).toBeDefined();
      expect(typeof start.sessionId).toBe("string");
      expect(start.status).toMatch(/^(running|starting)$/);
      console.log(
        `Started/attached session ${start.sessionId} (status=${start.status}, alreadyAttached=${start.alreadyAttached})`,
      );

      // Step 4 — list-sessions surfaces it.
      const afterResp = await mcp.client.callTool({
        name: "rn-dev/list-sessions",
        arguments: {},
      });
      const after = parseToolJson<{ sessions: SessionRow[] }>(afterResp);
      const match = after.sessions.find((s) => s.sessionId === start.sessionId);
      expect(match, `Started sessionId ${start.sessionId} did not appear in list-sessions`).toBeDefined();
      expect(match?.status).toMatch(/^(running|starting)$/);

      // Step 5 — stop-session with per-call consent.
      const stopResp = await mcp.client.callTool({
        name: "rn-dev/stop-session",
        arguments: {
          sessionId: start.sessionId,
          permissionsAccepted: ["rn-dev/stop-session"],
        },
      });
      const stop = parseToolJson<{ sessionId: string; status?: string }>(stopResp);
      expect(stop.sessionId).toBe(start.sessionId);
      console.log(`Stopped session ${stop.sessionId}: ${JSON.stringify(stop)}`);

      // Step 6 — list-sessions reflects teardown. The supervisor deletes
      // the entry on clean stop, so the previously-listed sessionId is
      // no longer present.
      const finalResp = await mcp.client.callTool({
        name: "rn-dev/list-sessions",
        arguments: {},
      });
      const final = parseToolJson<{ sessions: SessionRow[] }>(finalResp);
      const stillThere = final.sessions.find((s) => s.sessionId === start.sessionId);
      expect(stillThere, `Stopped session ${start.sessionId} still present`).toBeUndefined();
    },
    60_000,
  );

  it.skipIf(!ENABLED)(
    "stop-session refuses without permissionsAccepted (destructive gating)",
    async () => {
      const mcp = await spawnMcpServer({ cwd: ACME });
      liveMcp.push(mcp);

      const listResp = await mcp.client.callTool({
        name: "rn-dev/list-sessions",
        arguments: {},
      });
      const list = parseToolJson<{ sessions: SessionRow[] }>(listResp);
      if (list.sessions.length === 0) {
        // Nothing to gate on — start a session to verify the destructive
        // gate fires on real call.
        const startResp = await mcp.client.callTool({
          name: "rn-dev/start-session",
          arguments: {},
        });
        const start = parseToolJson<{ sessionId: string }>(startResp);
        list.sessions = [{ sessionId: start.sessionId, status: "running" }];
      }

      const sid = list.sessions[0]?.sessionId;
      expect(sid).toBeDefined();

      // Stop WITHOUT consent — must refuse with E_DESTRUCTIVE_REQUIRES_CONFIRM.
      const stopNoConsent = await mcp.client.callTool({
        name: "rn-dev/stop-session",
        arguments: { sessionId: sid },
      });
      const payload = parseToolJson<{ code?: string; message?: string }>(
        stopNoConsent,
      );
      expect(payload.code).toBe("E_DESTRUCTIVE_REQUIRES_CONFIRM");

      // Now stop WITH consent — happy path.
      const stopWithConsent = await mcp.client.callTool({
        name: "rn-dev/stop-session",
        arguments: {
          sessionId: sid,
          permissionsAccepted: ["rn-dev/stop-session"],
        },
      });
      const ok = parseToolJson<{ sessionId?: string; status?: string }>(
        stopWithConsent,
      );
      expect(ok.sessionId).toBe(sid);
    },
    60_000,
  );
});
