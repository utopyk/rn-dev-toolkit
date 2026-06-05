// De-risk probe (Task 3): single-session Android REAL network capture
// through MCP, end to end, against acme on a real device.
//
// This is the substrate the multi-session goal stands on and the one
// thing never verified on Android (iOS was verified once via M2d). It
// drives the full product path:
//
//   boot default session → rn-dev/build (run-android --mode betaDebug
//   --appIdSuffix beta on the real device) → app launches + attaches to
//   Metro → /json exposes the Hermes target → select-target connects the
//   CDP proxy + enables Network → acme's own API calls get captured →
//   devtools-network__list returns them, and metro-logs__list returns
//   Metro output.
//
// IMPORTANT — uses POLLING (request/response tools), never the daemon
// event push stream. The push stream stalls under the gradle stdout
// flood (see Task 7), so gating on the builder/done *event* is unsafe.
// The __status/__list tools read the daemon-side module ring directly,
// so "did the build finish + app attach" is detected by the Hermes
// target appearing in devtools-network__status, not by a build event.
//
// PROBE-gated. Verbose by design — every phase prints with elapsed time.

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
const DEVICE = process.env.PROBE_ANDROID_DEVICE ?? "R5CX23WBLKE";
const PORT = Number(process.env.PROBE_METRO_PORT ?? 8090);
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
  if (typeof text !== "string") {
    throw new Error(`No usable content: ${JSON.stringify(result)}`);
  }
  return JSON.parse(text) as T;
}

interface Target {
  id?: string;
  title?: string;
  description?: string;
  webSocketDebuggerUrl?: string;
}
interface DvtStatus {
  meta?: { proxyStatus?: string };
  proxyStatus?: string;
  proxyPort?: number;
  targets?: Target[];
}
interface NetEntry {
  requestId?: string;
  url?: string;
  method?: string;
  status?: number;
}

describe("Probe — single-session Android real network capture (acme)", () => {
  const liveMcp: McpHarnessHandle[] = [];
  const cleanups: Array<() => void> = [];

  // callTool with a hard timeout — a wedged daemon shouldn't freeze the
  // whole poll loop (the original probe hung 15min on exactly this).
  async function call(mcp: McpHarnessHandle, name: string, args: Record<string, unknown>): Promise<unknown> {
    return await Promise.race([
      mcp.client.callTool({ name, arguments: args }),
      sleep(30_000).then(() => {
        throw new Error(`callTool ${name} timed out after 30s`);
      }),
    ]);
  }

  afterEach(async () => {
    for (const m of liveMcp.splice(0)) await m.stop();
    const pidPath = join(ACME, ".rn-dev", "pid");
    let pid: number | null = null;
    try {
      const raw = readFileSync(pidPath, "utf8").trim();
      const parsed = raw.startsWith("{")
        ? (JSON.parse(raw) as { pid?: number }).pid ?? null
        : Number.parseInt(raw, 10);
      if (parsed && Number.isFinite(parsed) && parsed > 0) pid = parsed;
    } catch {
      /* gone */
    }
    if (pid !== null) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone */
      }
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          pid = null;
          break;
        }
        await sleep(250);
      }
      if (pid !== null) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
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
    "boots one Android session, builds+launches acme, captures Metro logs + network traffic",
    async () => {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: ACME })
        .toString()
        .trim();
      const profileDir = join(ACME, ".rn-dev", "profiles");
      mkdirSync(profileDir, { recursive: true });

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
        } catch {
          /* skip malformed */
        }
      }
      cleanups.push(() => {
        for (const { path, original } of flipped) {
          try {
            writeFileSync(path, original);
          } catch {
            /* best-effort */
          }
        }
      });

      const name = "probe-android-single-a";
      const profilePath = join(profileDir, `${name}.json`);
      writeFileSync(
        profilePath,
        JSON.stringify(
          {
            name,
            isDefault: true,
            worktree: null,
            branch,
            platform: "android",
            mode: "dirty",
            metroPort: PORT,
            devices: { ios: null, android: DEVICE },
            buildVariant: "debug",
            configuration: "betaDebug",
            appIdSuffix: "beta",
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
          /* best-effort */
        }
      });

      console.log(
        `[${ts()}] booting MCP against acme (device=${DEVICE}, metroPort=${PORT}, betaDebug)`,
      );
      const mcp = await spawnMcpServer({ cwd: ACME });
      liveMcp.push(mcp);

      // Force-stop so the build cold-starts the app → it re-runs its
      // launch API burst. With the assemble-only build (no reinstall), an
      // already-running idle app would just be foregrounded by `am start`
      // and make no new requests. Combined with daemon-side auto-arm +
      // the fast discovery poll, the cold-start burst is captured.
      try {
        execSync(`adb -s ${DEVICE} shell am force-stop ${APP_ID}`, { stdio: "ignore" });
        console.log(`[${ts()}] force-stopped ${APP_ID} on ${DEVICE} (cold start)`);
      } catch {
        /* best-effort */
      }

      // MCP boot attaches + starts Metro but does NOT auto-build (that's
      // the TUI/Electron start-flow). Kick the build explicitly; defaults
      // pull from the profile (android / betaDebug / appIdSuffix beta).
      console.log(`[${ts()}] triggering rn-dev/build`);
      const kick = parseToolJson(await call(mcp, "rn-dev/build", {}));
      console.log(`[${ts()}] build kick:`, JSON.stringify(kick).slice(0, 200));

      // ---- PHASE 1: wait for the app to attach (Hermes target appears) ---
      // The Hermes target appearing in devtools-network__status proves the
      // build finished, installed, launched, and the app connected to
      // Metro. Polled via request/response (immune to the event stall).
      let target: Target | undefined;
      const targetDeadline = Date.now() + 15 * 60_000;
      let lastLog = 0;
      while (Date.now() < targetDeadline && !target) {
        let st: DvtStatus;
        try {
          st = parseToolJson<DvtStatus>(
            await call(mcp, "devtools-network__status", {}),
          );
        } catch (e) {
          console.log(`[${ts()}] status poll error (retrying): ${(e as Error).message}`);
          await sleep(4000);
          continue;
        }
        const proxy = st.meta?.proxyStatus ?? st.proxyStatus;
        const tcount = st.targets?.length ?? 0;
        if (Date.now() - lastLog > 15_000 || tcount > 0) {
          console.log(`[${ts()}] proxy=${proxy} port=${st.proxyPort} targets=${tcount}`);
          lastLog = Date.now();
        }
        if (tcount > 0) {
          target =
            st.targets!.find((t) =>
              /hermes|reactnative|react native|metro/i.test(
                `${t.title ?? ""} ${t.description ?? ""}`,
              ),
            ) ?? st.targets![0];
          console.log(`[${ts()}] target found:`, JSON.stringify(target).slice(0, 200));
        } else {
          await sleep(4000);
        }
      }
      expect(target?.id, "no Hermes target appeared within 15min (build/launch/attach failed)").toBeTruthy();

      // ---- PHASE 2: select-target → proxy connects -----------------------
      await call(mcp, "devtools-network__select-target", { targetId: target!.id });
      let connected = false;
      const connDeadline = Date.now() + 60_000;
      while (Date.now() < connDeadline && !connected) {
        const st = parseToolJson<DvtStatus>(await call(mcp, "devtools-network__status", {}));
        const proxy = st.meta?.proxyStatus ?? st.proxyStatus;
        console.log(`[${ts()}] post-select proxy=${proxy}`);
        if (proxy === "connected") connected = true;
        else await sleep(2000);
      }
      expect(connected, "proxy did not reach 'connected' after select-target").toBe(true);

      // ---- PHASE 3: network capture --------------------------------------
      // acme fires API calls on launch/navigation. Poll the list.
      let net: NetEntry[] = [];
      const netDeadline = Date.now() + 4 * 60_000;
      while (Date.now() < netDeadline && net.length === 0) {
        const payload = parseToolJson<{ entries?: NetEntry[]; requests?: NetEntry[] }>(
          await call(mcp, "devtools-network__list", { limit: 50 }),
        );
        net = payload.entries ?? payload.requests ?? [];
        console.log(`[${ts()}] network entries captured: ${net.length}`);
        if (net.length === 0) await sleep(3000);
      }
      for (const e of net.slice(0, 10)) {
        console.log(`[${ts()}]   ${e.method ?? "?"} ${e.status ?? ""} ${e.url ?? ""}`.slice(0, 200));
      }
      expect(net.length, "no network traffic captured within 4min").toBeGreaterThan(0);

      // ---- PHASE 4: Metro logs -------------------------------------------
      const metroPayload = parseToolJson<{
        entries?: Array<{ message?: string; text?: string }>;
        lines?: Array<{ message?: string; text?: string }>;
      }>(await call(mcp, "metro-logs__list", { limit: 50 }));
      const metroLines = metroPayload.entries ?? metroPayload.lines ?? [];
      console.log(`[${ts()}] metro log lines: ${metroLines.length}`);
      for (const l of metroLines.slice(0, 5)) {
        console.log(`[${ts()}]   metro: ${(l.message ?? l.text ?? "").slice(0, 160)}`);
      }
      expect(metroLines.length, "no Metro log lines captured").toBeGreaterThan(0);

      console.log(`[${ts()}] ✅ single-session Android capture verified`);
    },
    20 * 60_000,
  );
});
