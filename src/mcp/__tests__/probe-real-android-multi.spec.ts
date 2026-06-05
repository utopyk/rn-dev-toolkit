// Goal probe (Task 4): TWO concurrent real Android sessions through MCP,
// each with independent Metro logs + network capture + DevTools target,
// no cross-contamination. This is the MCP arm of the /goal.
//
//   Session A: acme betaDebug on the physical device (R5CX23WBLKE), Metro 8090
//   Session B: acme betaDebug on the Pixel_6 emulator (emulator-5554), Metro 8091
//
// Builds are sequential (one gradle build per project dir at a time) and
// installs are device-scoped via env.ANDROID_SERIAL so B's build can't
// disrupt A's already-running app. Each session is detected "up" by its
// Hermes target appearing (request/response poll — immune to the event
// push stall, Task 7). Capture is verified per session via
// devtools-network__list, Metro logs via metro-logs__list, and isolation
// by asserting each session's target is its OWN device and the proxy
// ports differ.
//
// PROBE-gated. Verbose. ~5-8min wall clock (two warm betaDebug builds).

import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  spawnMcpServer,
  type McpHarnessHandle,
} from "../../../test/helpers/spawnMcpServer.js";

const ACME =
  process.env.PROBE_ACME ?? "/Users/martincouso/Documents/GitHub/acme-mobile-app";
const DEVICE_A = process.env.PROBE_ANDROID_DEVICE ?? "R5CX23WBLKE";
const DEVICE_B = process.env.PROBE_ANDROID_EMU ?? "emulator-5554";
const APP_ID = process.env.PROBE_APP_ID ?? "com.acme.beta";
const ENABLED = process.env.PROBE === "1" || process.env.PROBE_ACME === "1";

const START = Date.now();
const ts = () => `+${Math.round((Date.now() - START) / 1000)}s`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseToolJson<T>(result: unknown): T {
  const r = result as {
    content?: Array<{ type: string; text: string }>;
    structuredContent?: T;
  };
  if (r.structuredContent) return r.structuredContent as T;
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error(`No usable content: ${JSON.stringify(result)}`);
  return JSON.parse(text) as T;
}

interface Target { id?: string; title?: string; description?: string }
interface DvtStatus { meta?: { proxyStatus?: string }; proxyStatus?: string; proxyPort?: number; targets?: Target[] }
interface NetEntry { requestId?: string; url?: string; method?: string; status?: number }
interface SessionRow { sessionId: string; profileName?: string; status: string }

describe("Probe — TWO concurrent Android sessions, independent capture (acme)", () => {
  const liveMcp: McpHarnessHandle[] = [];
  const cleanups: Array<() => void> = [];

  async function call(mcp: McpHarnessHandle, name: string, args: Record<string, unknown>): Promise<unknown> {
    return await Promise.race([
      mcp.client.callTool({ name, arguments: args }),
      sleep(30_000).then(() => {
        throw new Error(`callTool ${name} timed out after 30s`);
      }),
    ]);
  }

  // Build a session, wait for its Hermes target, select it, confirm
  // connected, and return the captured network + metro snapshots + proxyPort.
  async function bringUpAndCapture(
    mcp: McpHarnessHandle,
    sessionId: string,
    label: string,
    deviceSerial: string,
  ): Promise<{ target: Target; proxyPort?: number; net: NetEntry[]; metro: string[] }> {
    // Force-stop so the build cold-starts the app → it re-runs its launch
    // API burst. Without this, the assemble-only build doesn't reinstall,
    // so run-android's `am start` just foregrounds an already-running,
    // already-loaded (idle) app — no burst, nothing to capture. Combined
    // with daemon-side auto-arm, the cold-start burst is captured.
    try {
      execSync(`adb -s ${deviceSerial} shell am force-stop ${APP_ID}`, { stdio: "ignore" });
      console.log(`[${ts()}] [${label}] force-stopped ${APP_ID} on ${deviceSerial} (cold start)`);
    } catch {
      /* best-effort */
    }
    console.log(`[${ts()}] [${label}] triggering build (sessionId=${sessionId.slice(0, 8)})`);
    const kick = parseToolJson(await call(mcp, "rn-dev/build", { sessionId }));
    console.log(`[${ts()}] [${label}] build kick: ${JSON.stringify(kick).slice(0, 120)}`);

    let target: Target | undefined;
    let proxyPort: number | undefined;
    const targetDeadline = Date.now() + 15 * 60_000;
    let lastLog = 0;
    while (Date.now() < targetDeadline && !target) {
      let st: DvtStatus;
      try {
        st = parseToolJson<DvtStatus>(await call(mcp, "devtools-network__status", { sessionId }));
      } catch (e) {
        console.log(`[${ts()}] [${label}] status error (retry): ${(e as Error).message}`);
        await sleep(4000);
        continue;
      }
      proxyPort = st.proxyPort;
      const proxy = st.meta?.proxyStatus ?? st.proxyStatus;
      const tcount = st.targets?.length ?? 0;
      if (Date.now() - lastLog > 15_000 || tcount > 0) {
        console.log(`[${ts()}] [${label}] proxy=${proxy} port=${proxyPort} targets=${tcount}`);
        lastLog = Date.now();
      }
      if (tcount > 0) target = st.targets![0];
      else await sleep(2000);
    }
    expect(target?.id, `[${label}] no Hermes target within 15min`).toBeTruthy();
    console.log(`[${ts()}] [${label}] target: ${target!.title}`);

    // The daemon already auto-armed capture (Network.enable) the instant
    // the target was discovered (pollTargets auto-select), so by the time
    // we see the target here the launch burst is being captured. We still
    // re-select (a no-op re-arm) to be explicit, then poll. No reload — a
    // reload bounces the inspector ws and races the re-arm; arming-early
    // via the daemon's fast discovery poll is the reliable path.
    await call(mcp, "devtools-network__select-target", { sessionId, targetId: target!.id });
    const connDeadline = Date.now() + 30_000;
    while (Date.now() < connDeadline) {
      const st = parseToolJson<DvtStatus>(await call(mcp, "devtools-network__status", { sessionId }));
      proxyPort = st.proxyPort;
      if ((st.meta?.proxyStatus ?? st.proxyStatus) === "connected") break;
      await sleep(1500);
    }

    let net: NetEntry[] = [];
    const netDeadline = Date.now() + 150_000;
    while (Date.now() < netDeadline && net.length === 0) {
      const payload = parseToolJson<{ entries?: NetEntry[]; requests?: NetEntry[] }>(
        await call(mcp, "devtools-network__list", { sessionId, limit: 50 }),
      );
      net = payload.entries ?? payload.requests ?? [];
      if (net.length === 0) await sleep(2500);
    }
    console.log(`[${ts()}] [${label}] network entries: ${net.length}`);

    const metroPayload = parseToolJson<{ entries?: Array<{ line?: string }> }>(
      await call(mcp, "metro-logs__list", { sessionId, limit: 50 }),
    );
    const metro = (metroPayload.entries ?? []).map((e) => e.line ?? "").filter(Boolean);

    console.log(`[${ts()}] [${label}] captured net=${net.length} metro=${metro.length} port=${proxyPort}`);
    return { target: target!, proxyPort, net, metro };
  }

  afterEach(async () => {
    for (const m of liveMcp.splice(0)) await m.stop();
    const pidPath = join(ACME, ".rn-dev", "pid");
    let pid: number | null = null;
    try {
      const raw = readFileSync(pidPath, "utf8").trim();
      const parsed = raw.startsWith("{") ? (JSON.parse(raw) as { pid?: number }).pid ?? null : Number.parseInt(raw, 10);
      if (parsed && Number.isFinite(parsed) && parsed > 0) pid = parsed;
    } catch {
      /* gone */
    }
    if (pid !== null) {
      try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { process.kill(pid, 0); } catch { pid = null; break; }
        await sleep(250);
      }
      if (pid !== null) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
    try {
      rmSync(pidPath, { force: true });
      rmSync(join(ACME, ".rn-dev", "sock"), { force: true });
    } catch {
      /* best-effort */
    }
    for (const c of cleanups.splice(0)) c();
  });

  it.skipIf(!ENABLED)(
    "two sessions on two real Android targets capture independent network + metro logs",
    async () => {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: ACME }).toString().trim();
      const profileDir = join(ACME, ".rn-dev", "profiles");
      mkdirSync(profileDir, { recursive: true });

      // Flip existing defaults off; restore on teardown.
      const flipped: Array<{ path: string; original: string }> = [];
      for (const f of readdirSync(profileDir).filter((x) => x.endsWith(".json"))) {
        const fp = join(profileDir, f);
        const original = readFileSync(fp, "utf8");
        try {
          const p = JSON.parse(original) as { isDefault?: boolean };
          if (p.isDefault === true) {
            p.isDefault = false;
            writeFileSync(fp, JSON.stringify(p, null, 2));
            flipped.push({ path: fp, original });
          }
        } catch { /* skip */ }
      }
      cleanups.push(() => {
        for (const { path, original } of flipped) {
          try { writeFileSync(path, original); } catch { /* best-effort */ }
        }
      });

      const mkProfile = (name: string, isDefault: boolean, port: number, device: string) => ({
        name, isDefault, worktree: null, branch,
        platform: "android" as const, mode: "dirty" as const, metroPort: port,
        devices: { ios: null, android: device }, buildVariant: "debug" as const,
        configuration: "betaDebug", appIdSuffix: "beta",
        preflight: { checks: [], frequency: "once" as const }, onSave: [],
        env: { ANDROID_SERIAL: device }, projectRoot: ACME, packageManager: "pnpm" as const,
      });
      const nameA = "probe-multi-a", nameB = "probe-multi-b";
      const pathA = join(profileDir, `${nameA}.json`);
      const pathB = join(profileDir, `${nameB}.json`);
      writeFileSync(pathA, JSON.stringify(mkProfile(nameA, true, 8090, DEVICE_A), null, 2));
      writeFileSync(pathB, JSON.stringify(mkProfile(nameB, false, 8091, DEVICE_B), null, 2));
      cleanups.push(() => {
        try { rmSync(pathA, { force: true }); rmSync(pathB, { force: true }); } catch { /* best-effort */ }
      });

      // Pre-grant runtime permissions on both targets so a fresh install
      // isn't blocked behind a permission dialog (the notification prompt
      // stalled the emulator app before it could reach a screen that makes
      // API calls). `adb install -r` preserves these across the rebuild.
      const PERMS = [
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.READ_MEDIA_IMAGES",
        "android.permission.READ_EXTERNAL_STORAGE",
      ];
      for (const serial of [DEVICE_A, DEVICE_B]) {
        for (const perm of PERMS) {
          try {
            execSync(`adb -s ${serial} shell pm grant ${APP_ID} ${perm}`, { stdio: "ignore" });
          } catch {
            /* permission not declared / not grantable — fine */
          }
        }
      }
      console.log(`[${ts()}] pre-granted runtime permissions on both targets`);

      console.log(`[${ts()}] booting MCP (session A = ${DEVICE_A}:8090 default)`);
      const mcp = await spawnMcpServer({ cwd: ACME });
      liveMcp.push(mcp);

      // Discover session A (auto-booted default).
      const findSid = async (profileName: string): Promise<string | undefined> => {
        const list = parseToolJson<{ sessions: SessionRow[] }>(await call(mcp, "rn-dev/list-sessions", {}));
        return list.sessions.find((s) => s.profileName === profileName)?.sessionId;
      };
      let sidA: string | undefined;
      for (let i = 0; i < 30 && !sidA; i++) { sidA = await findSid(nameA); if (!sidA) await sleep(1000); }
      expect(sidA, "session A never appeared in list-sessions").toBeTruthy();

      // ---- Session A: build + capture -----------------------------------
      const a = await bringUpAndCapture(mcp, sidA!, "A", DEVICE_A);
      expect(a.net.length, "[A] no network captured").toBeGreaterThan(0);
      expect(a.metro.length, "[A] no metro logs").toBeGreaterThan(0);

      // ---- Start session B (emulator) -----------------------------------
      console.log(`[${ts()}] starting session B (${DEVICE_B}:8091)`);
      await call(mcp, "rn-dev/start-session", { profileName: nameB });
      let sidB: string | undefined;
      for (let i = 0; i < 30 && !sidB; i++) { sidB = await findSid(nameB); if (!sidB) await sleep(1000); }
      expect(sidB, "session B never appeared in list-sessions").toBeTruthy();
      expect(sidB, "session B shares sessionId with A").not.toBe(sidA);

      // ---- Session B: build + capture -----------------------------------
      const b = await bringUpAndCapture(mcp, sidB!, "B", DEVICE_B);
      expect(b.net.length, "[B] no network captured").toBeGreaterThan(0);
      expect(b.metro.length, "[B] no metro logs").toBeGreaterThan(0);

      // ---- Isolation assertions -----------------------------------------
      // 1. Distinct proxy ports → distinct module subprocesses / proxies.
      if (typeof a.proxyPort === "number" && typeof b.proxyPort === "number") {
        expect(a.proxyPort, "A and B share a devtools proxyPort (not session-isolated)").not.toBe(b.proxyPort);
      }
      // 2. Each session's target is its OWN device (no cross-contamination
      //    of the target list).
      console.log(`[${ts()}] A.target="${a.target.title}"  B.target="${b.target.title}"`);
      // A is the physical device; B is some OTHER target (the emulator).
      // Asserting B != device + B != A is robust without hardcoding the
      // emulator's marketing name.
      expect(a.target.title, "[A] target is not the physical device").toContain("SM-S711W");
      expect(b.target.title, "[B] target leaked the physical device").not.toContain("SM-S711W");
      expect(a.target.title, "[A] and [B] resolved the same target — cross-contamination").not.toBe(b.target.title);

      // 3. After B is up, A must STILL be connected + capturing (B's build
      //    must not have disrupted A — the ANDROID_SERIAL scoping check).
      const aStatusAfter = parseToolJson<DvtStatus>(await call(mcp, "devtools-network__status", { sessionId: sidA! }));
      console.log(`[${ts()}] A proxy after B up: ${aStatusAfter.meta?.proxyStatus ?? aStatusAfter.proxyStatus}`);
      expect(
        (aStatusAfter.meta?.proxyStatus ?? aStatusAfter.proxyStatus),
        "[A] proxy dropped after B started (cross-session disruption)",
      ).toBe("connected");

      // ---- Cleanup: stop both with destructive consent ------------------
      for (const sid of [sidA!, sidB!]) {
        await call(mcp, "rn-dev/stop-session", { sessionId: sid, permissionsAccepted: ["rn-dev/stop-session"] });
      }

      console.log(`[${ts()}] ✅ TWO-session Android capture verified — A(${a.net.length} net) B(${b.net.length} net), distinct ports ${a.proxyPort}/${b.proxyPort}`);
    },
    25 * 60_000,
  );
});
