import { test, expect, _electron as electron } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IpcClient, type IpcMessage } from "../../src/core/ipc.js";

// Electron arm of the /goal — TWO real Android tabs, each with its own
// Metro, DevTools proxy, Metro logs, AND captured network traffic, no
// cross-contamination. This is the Electron counterpart to the MCP probe
// (src/mcp/__tests__/probe-real-android-multi.spec.ts) and goes one step
// beyond E7 (multi-session-full-stack.spec.ts), which proved both builds
// complete but DEFERRED Hermes-connect + network capture.
//
// Both tabs are Android (physical device + workspace-1 emulator) so there
// is no iOS code-signing modal to negotiate. Relies on the daemon-side
// capture fixes (auto-arm on target discovery + fast discovery poll +
// device-scoped assemble-only install) so capture is armed before each
// cold-started app's launch fetch burst and building tab B doesn't disrupt
// tab A. Network capture is asserted via the daemon's `devtools/delta`
// events (addedIds = CDP Network request IDs), tagged per sessionId — the
// same stream the renderer's DevTools panel consumes.
//
// Skipped unless REAL_BOOT_SMOKE=1. Expects:
//   - physical Android device online (RN_DEV_REAL_BOOT_ANDROID_A)
//   - workspace-1 emulator online (RN_DEV_REAL_BOOT_ANDROID_B), logged in
//   Boot the emulator via:
//     ~/Library/Android/sdk/emulator/emulator -avd workspace-1 -no-snapshot-load &

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const REAL_BOOT_ENABLED = process.env.REAL_BOOT_SMOKE === "1";

const PROJECT_ROOT =
  process.env.RN_DEV_REAL_BOOT_TARGET ?? "/Users/martincouso/Documents/GitHub/acme-mobile-app";
const PACKAGE_MANAGER = (process.env.RN_DEV_REAL_BOOT_PACKAGE_MANAGER ?? "pnpm") as
  | "npm" | "pnpm" | "yarn" | "bun";
const ANDROID_A = process.env.RN_DEV_REAL_BOOT_ANDROID_A ?? "R5CX23WBLKE";
const ANDROID_B = process.env.RN_DEV_REAL_BOOT_ANDROID_B ?? "emulator-5556";
const APP_ID = process.env.RN_DEV_REAL_BOOT_APP_ID ?? "com.acme.beta";
const CONFIGURATION = process.env.RN_DEV_REAL_BOOT_CONFIGURATION ?? "betaDebug";
const APP_ID_SUFFIX = process.env.RN_DEV_REAL_BOOT_APP_ID_SUFFIX ?? "beta";

const PORT_A = 8090;
const PORT_B = 8091;
const PROFILE_A = "default"; // renderer auto-attaches the default profile
const PROFILE_B = "e-android-b";
const SCREENSHOT_DIR = "/tmp/e-android-capture-screens";

const PERMS = [
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.CAMERA",
  "android.permission.RECORD_AUDIO",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.READ_MEDIA_IMAGES",
];

function androidProfile(name: string, isDefault: boolean, port: number, device: string, branch: string) {
  return {
    name, isDefault, worktree: null, branch,
    platform: "android" as const, mode: "dirty" as const, metroPort: port,
    devices: { ios: null, android: device }, buildVariant: "debug" as const,
    configuration: CONFIGURATION, appIdSuffix: APP_ID_SUFFIX,
    preflight: { checks: [], frequency: "once" as const }, onSave: [], env: { ANDROID_SERIAL: device },
    projectRoot: PROJECT_ROOT, packageManager: PACKAGE_MANAGER,
  };
}

function grantAndColdStart(serial: string): void {
  for (const perm of PERMS) {
    try { execSync(`adb -s ${serial} shell pm grant ${APP_ID} ${perm}`, { stdio: "ignore" }); } catch { /* ignore */ }
  }
  try { execSync(`adb -s ${serial} shell am force-stop ${APP_ID}`, { stdio: "ignore" }); } catch { /* ignore */ }
}

test.describe("Real-boot Electron — two Android tabs capture independent network", () => {
  test.skip(!REAL_BOOT_ENABLED, "Set REAL_BOOT_SMOKE=1 to run; spawns one daemon + two real Android builds.");
  test.setTimeout(45 * 60_000);

  test.beforeEach(() => {
    if (!existsSync(PROJECT_ROOT)) throw new Error(`requires the project at ${PROJECT_ROOT}`);
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const adbOut = execSync("adb devices 2>&1", { encoding: "utf8" });
    for (const serial of [ANDROID_A, ANDROID_B]) {
      if (!adbOut.includes(`${serial}\tdevice`)) {
        throw new Error(`requires Android target "${serial}" online. adb devices:\n${adbOut}`);
      }
    }
  });

  test("two Android tabs each build, attach Hermes, and capture network with no cross-talk", async () => {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: PROJECT_ROOT }).toString().trim();
    const profileDir = join(PROJECT_ROOT, ".rn-dev", "profiles");
    mkdirSync(profileDir, { recursive: true });

    // Flip existing defaults off, restore on teardown.
    const flipped: Array<{ path: string; original: string }> = [];
    for (const f of readdirSync(profileDir).filter((x) => x.endsWith(".json"))) {
      const fp = join(profileDir, f);
      const original = readFileSync(fp, "utf8");
      try {
        const p = JSON.parse(original) as { isDefault?: boolean };
        if (p.isDefault === true) { p.isDefault = false; writeFileSync(fp, JSON.stringify(p, null, 2)); flipped.push({ path: fp, original }); }
      } catch { /* skip */ }
    }
    writeFileSync(join(profileDir, `${PROFILE_A}.json`), JSON.stringify(androidProfile(PROFILE_A, true, PORT_A, ANDROID_A, branch), null, 2));
    writeFileSync(join(profileDir, `${PROFILE_B}.json`), JSON.stringify(androidProfile(PROFILE_B, false, PORT_B, ANDROID_B, branch), null, 2));

    // Cold-start tab A's app before Electron auto-attaches + builds it.
    grantAndColdStart(ANDROID_A);

    const userDataDir = join(PROJECT_ROOT, ".rn-dev", "e-android-user-data");
    mkdirSync(userDataDir, { recursive: true });

    let stderrBuf = "";
    const app = await electron.launch({
      args: [join(REPO_ROOT, "electron", "launcher.cjs"), `--user-data-dir=${userDataDir}`],
      cwd: PROJECT_ROOT,
      stderr: "pipe", stdout: "pipe",
      env: { ...process.env, RN_DEV_PROJECT_ROOT: PROJECT_ROOT, RN_DEV_SMOKE: "1" },
      timeout: 30_000,
    });
    app.process().stderr?.on("data", (c: Buffer) => { stderrBuf += c.toString(); process.stderr.write(`[E-STDERR] ${c}`); });
    const page = await app.firstWindow({ timeout: 30_000 });

    const socketPath = join(PROJECT_ROOT, ".rn-dev", "sock");
    const pidPath = join(PROJECT_ROOT, ".rn-dev", "pid");
    let client: IpcClient | undefined;
    let sub: { close: () => void } | undefined;

    try {
      await expect(page.locator(".sidebar")).toBeVisible({ timeout: 60_000 });
      await waitFor(() => Promise.resolve(existsSync(socketPath) && existsSync(pidPath)), 60_000, "daemon socket/pid did not appear");
      const daemonPid = readPidFromLockfile(pidPath)!;
      console.log(`[EA] daemon up pid=${daemonPid}`);

      client = new IpcClient(socketPath);
      const events: IpcMessage[] = [];
      const sidA = await waitForSessionInList(client, PROFILE_A, 60_000);
      console.log(`[EA] tab A session minted sidA=${sidA}, subscribing...`);
      sub = await client.subscribe(
        { type: "command", action: "events/subscribe", id: "ea-sub", payload: { sessionId: sidA } },
        { onEvent: (evt) => { events.push(evt); }, onError: () => { /* teardown */ } },
      );

      // ---- Tab A: build + Hermes + network ----
      console.log("[EA] waiting for tab A builder/done...");
      await waitForEvent(events, (e) => {
        const p = e.payload as { kind?: string; data?: { success?: boolean }; sessionId?: string };
        return p?.kind === "builder/done" && p.data?.success === true && p.sessionId === sidA;
      }, 20 * 60_000);
      console.log("[EA] tab A build OK; waiting for network delta (auto-armed capture)...");
      await waitForEvent(events, (e) => {
        const p = e.payload as { kind?: string; data?: { addedIds?: string[] }; sessionId?: string };
        return p?.kind === "devtools/delta" && p.sessionId === sidA && (p.data?.addedIds?.length ?? 0) > 0;
      }, 5 * 60_000);
      console.log("[EA] ✅ tab A captured network");
      await page.screenshot({ path: join(SCREENSHOT_DIR, "01-tabA-network.png") });

      // Open the React Native DevTools tab for instance A and confirm the
      // renderer's DevTools view reaches `connected` (.devtools-container =
      // the embedded RN DevTools / Fusebox frame; placeholders use
      // .devtools-placeholder). This is the GUI-level proof of "DevTools
      // tab connecting", on top of the daemon-side network capture above.
      await page.locator('button[aria-label="DevTools"]').click();
      await expect(page.locator(".devtools-container")).toBeVisible({ timeout: 90_000 });
      await page.screenshot({ path: join(SCREENSHOT_DIR, "01b-tabA-devtools.png") });
      console.log("[EA] ✅ tab A DevTools tab connected (RN DevTools loaded)");

      // ---- Add tab B (emulator) via the renderer's "+" ----
      grantAndColdStart(ANDROID_B);
      const addBtn = page.locator(".instance-tab-add").first();
      await expect(addBtn).toBeVisible({ timeout: 30_000 });
      await addBtn.click();
      const entryB = page.getByText(new RegExp(PROFILE_B, "i")).first();
      await expect(entryB).toBeVisible({ timeout: 30_000 });
      await entryB.click();
      console.log("[EA] tab B added; waiting for it to reach running...");
      const sidB = await waitForRunningSessionByProfile(client, PROFILE_B, 5 * 60_000);
      expect(sidB).not.toBe(sidA);

      // ---- Tab B: build + Hermes + network ----
      console.log("[EA] waiting for tab B builder/done...");
      await waitForEvent(events, (e) => {
        const p = e.payload as { kind?: string; data?: { success?: boolean }; sessionId?: string };
        return p?.kind === "builder/done" && p.data?.success === true && p.sessionId === sidB;
      }, 20 * 60_000);
      console.log("[EA] tab B build OK; waiting for network delta...");
      await waitForEvent(events, (e) => {
        const p = e.payload as { kind?: string; data?: { addedIds?: string[] }; sessionId?: string };
        return p?.kind === "devtools/delta" && p.sessionId === sidB && (p.data?.addedIds?.length ?? 0) > 0;
      }, 5 * 60_000);
      console.log("[EA] ✅ tab B captured network");
      await page.screenshot({ path: join(SCREENSHOT_DIR, "02-tabB-network.png") });

      // Switch to instance B's tab, open its DevTools, confirm it connects
      // INDEPENDENTLY (its own port/target — proves both tabs' RN DevTools
      // work side by side).
      await page.locator(".instance-tab").nth(1).click();
      await page.locator('button[aria-label="DevTools"]').click();
      await expect(page.locator(".devtools-container")).toBeVisible({ timeout: 90_000 });
      const portLabel = await page.locator(".devtools-toolbar-port").first().textContent();
      console.log(`[EA] tab B DevTools port label: ${portLabel}`);
      await page.screenshot({ path: join(SCREENSHOT_DIR, "02b-tabB-devtools.png") });
      console.log("[EA] ✅ tab B DevTools tab connected (RN DevTools loaded)");

      // ---- Isolation + steady-state assertions ----
      const portAHolder = lsofListenPid(PORT_A);
      const portBHolder = lsofListenPid(PORT_B);
      expect(portAHolder, `PORT_A ${PORT_A} not bound`).not.toBeNull();
      expect(portBHolder, `PORT_B ${PORT_B} not bound`).not.toBeNull();
      console.log(`[EA] both Metros bound A=${portAHolder} B=${portBHolder}`);

      const listResp = await client.send({ type: "command", action: "sessions/list", id: `ea-list-${Date.now()}` });
      const entries = (listResp.payload as { sessions?: Array<{ profileName?: string; status?: string }> }).sessions ?? [];
      const byProfile = new Map(entries.map((e) => [e.profileName, e]));
      expect(byProfile.get(PROFILE_A)?.status).toBe("running");
      expect(byProfile.get(PROFILE_B)?.status).toBe("running");

      // No cross-contamination: every sessionId-tagged event is sidA or sidB.
      const unknown = events.filter((e) => {
        const sid = (e.payload as { sessionId?: string }).sessionId;
        return typeof sid === "string" && sid !== sidA && sid !== sidB;
      });
      expect(
        unknown.map((e) => (e.payload as { sessionId?: string }).sessionId),
        `Cross-contamination: events outside {sidA=${sidA}, sidB=${sidB}}`,
      ).toEqual([]);

      // Each session captured its OWN network deltas (independent capture).
      const deltaA = events.filter((e) => (e.payload as { kind?: string }).kind === "devtools/delta" && (e.payload as { sessionId?: string }).sessionId === sidA);
      const deltaB = events.filter((e) => (e.payload as { kind?: string }).kind === "devtools/delta" && (e.payload as { sessionId?: string }).sessionId === sidB);
      expect(deltaA.length, "tab A produced no devtools/delta").toBeGreaterThan(0);
      expect(deltaB.length, "tab B produced no devtools/delta").toBeGreaterThan(0);

      console.log(`[EA] ✅ TWO Android tabs captured independent network — A(${deltaA.length} deltas) B(${deltaB.length} deltas), Metros ${portAHolder}/${portBHolder}`);

      // Optional: hold the window open so a human can eyeball the live
      // (real-pixel) RN DevTools / Fusebox on each tab — Playwright/CDP
      // screenshots can't capture the Electron <webview> content.
      if (process.env.EA_KEEP_OPEN === "1") {
        // Leave tab B active on the DevTools view for inspection.
        const holdMin = Number(process.env.EA_KEEP_OPEN_MIN ?? 25);
        console.log(`[EA] KEEP_OPEN: GUI is live with 2 tabs — inspect each tab's DevTools → Network. Holding ${holdMin} min.`);
        await page.waitForTimeout(holdMin * 60_000);
      }
    } finally {
      sub?.close();
      await app.close().catch(() => undefined);
      const daemonPid = readPidFromLockfile(pidPath);
      if (daemonPid !== null) await terminateDaemonPid(daemonPid);
      try {
        for (const { path, original } of flipped) writeFileSync(path, original);
        rmSync(join(profileDir, `${PROFILE_A}.json`), { force: true });
        rmSync(join(profileDir, `${PROFILE_B}.json`), { force: true });
        rmSync(socketPath, { force: true });
        rmSync(pidPath, { force: true });
        rmSync(userDataDir, { recursive: true, force: true });
      } catch { /* best-effort */ }
      if (stderrBuf.length > 0 && process.env.EA_DUMP_STDERR === "1") {
        console.log("=== EA stderr tail ===\n" + stderrBuf.slice(-4000));
      }
    }
  });
});

// ---- helpers (copied from multi-session-full-stack.spec.ts to keep this
//      probe self-contained; E7 stays untouched as the passing gate) ----

async function waitForRunningSessionByProfile(client: IpcClient, profileName: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const resp = await client.send({ type: "command", action: "sessions/list", id: `ea-find-running-${Date.now()}` });
    const entries = (resp.payload as { sessions?: Array<{ sessionId?: string; profileName?: string; status?: string }> }).sessions ?? [];
    last = JSON.stringify(entries);
    const match = entries.find((e) => e.profileName === profileName && e.status === "running");
    if (match?.sessionId) return match.sessionId;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForRunningSessionByProfile(${profileName}): timed out after ${timeoutMs}ms. Last: ${last}`);
}

async function waitForSessionInList(client: IpcClient, profileName: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const resp = await client.send({ type: "command", action: "sessions/list", id: `ea-find-${Date.now()}` });
    const entries = (resp.payload as { sessions?: Array<{ sessionId?: string; profileName?: string; status?: string }> }).sessions ?? [];
    last = JSON.stringify(entries);
    const match = entries.find((e) => e.profileName === profileName);
    if (match?.sessionId) return match.sessionId;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForSessionInList(${profileName}): timed out after ${timeoutMs}ms. Last: ${last}`);
}

async function waitForEvent(events: IpcMessage[], pred: (e: IpcMessage) => boolean, timeoutMs: number): Promise<IpcMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(pred);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`waitForEvent: timed out after ${timeoutMs}ms. ${events.length} events; last: ` + JSON.stringify(events.slice(-5).map((e) => e.payload)).slice(0, 1500));
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await pred()) return; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`waitFor: ${message} (timed out after ${timeoutMs}ms)`);
}

function readPidFromLockfile(pidPath: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(pidPath, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch { return null; }
}

function lsofListenPid(port: number): number | null {
  try {
    const out = execSync(`lsof -aP -i :${port} -sTCP:LISTEN -t`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean);
    if (out.length === 0) return null;
    const n = Number(out[0]);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

async function terminateDaemonPid(pid: number): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 50));
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* dead */ }
}
