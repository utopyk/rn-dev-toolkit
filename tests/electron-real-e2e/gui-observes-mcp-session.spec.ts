import { test, expect, _electron as electron } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IpcClient } from "../../src/core/ipc.js";
import { connectToDaemonSession, type DaemonSession } from "../../src/app/client/session.js";
import { triggerBuildsIfNeeded } from "../../src/app/auto-build.js";

// GUI-observes-MCP — the agent→GUI observability gate.
//
// An EXTERNAL client (standing in for an LLM driving rn-dev over MCP)
// cold-spawns the daemon, boots + builds a session against the
// workspace-1 Android emulator, and captures network. Then a human opens
// the Electron GUI — which has NO default profile of its own, so it
// boots no session — and the SessionsWatcher auto-surfaces the agent's
// session as a read-only 🤖 tab. We assert the human can:
//   1. see the 🤖 badged observe tab appear on its own,
//   2. see the read-only banner + the "observing" log line,
//   3. open the agent session's RN DevTools (Fusebox) read-only (chip
//      shown, no Reconnect button),
//   4. NOT break the agent's capture by opening Fusebox (the shared
//      per-session proxy survives — status still has proxy + targets),
//   5. close the observe tab WITHOUT killing the agent's session
//      (sessions/list still lists it running — the core correctness
//      property: observing is read-only and non-counting).
//
// Counterpart to multi-session-android-capture.spec.ts (which proves the
// GUI's OWN tabs capture). Skipped unless REAL_BOOT_SMOKE=1.
// Boot the emulator first:
//   ~/Library/Android/sdk/emulator/emulator -avd workspace-1 -no-snapshot-load &

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DAEMON_ENTRY = join(REPO_ROOT, "src", "index.tsx");
const REAL_BOOT_ENABLED = process.env.REAL_BOOT_SMOKE === "1";

const PROJECT_ROOT =
  process.env.RN_DEV_REAL_BOOT_TARGET ?? "/Users/martincouso/Documents/GitHub/acme-mobile-app";
const PACKAGE_MANAGER = (process.env.RN_DEV_REAL_BOOT_PACKAGE_MANAGER ?? "pnpm") as
  | "npm" | "pnpm" | "yarn" | "bun";
const EMULATOR = process.env.RN_DEV_REAL_BOOT_ANDROID_B ?? "emulator-5556";
const APP_ID = process.env.RN_DEV_REAL_BOOT_APP_ID ?? "com.acme.beta";
const CONFIGURATION = process.env.RN_DEV_REAL_BOOT_CONFIGURATION ?? "betaDebug";
const APP_ID_SUFFIX = process.env.RN_DEV_REAL_BOOT_APP_ID_SUFFIX ?? "beta";

const AGENT_PORT = 8092;
const AGENT_PROFILE = "gui-observes-agent";
const SCREENSHOT_DIR = "/tmp/gui-observes-screens";

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

test.describe("Real-boot — the GUI observes an agent/MCP session read-only", () => {
  test.skip(!REAL_BOOT_ENABLED, "Set REAL_BOOT_SMOKE=1 to run; spawns one daemon + one real Android build.");
  test.setTimeout(45 * 60_000);

  test.beforeEach(() => {
    if (!existsSync(PROJECT_ROOT)) throw new Error(`requires the project at ${PROJECT_ROOT}`);
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const adbOut = execSync("adb devices 2>&1", { encoding: "utf8" });
    if (!adbOut.includes(`${EMULATOR}\tdevice`)) {
      throw new Error(`requires the workspace-1 emulator "${EMULATOR}" online. adb devices:\n${adbOut}`);
    }
  });

  test("an agent session auto-appears as a read-only 🤖 tab; closing it does not kill the agent", async () => {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: PROJECT_ROOT }).toString().trim();
    const profileDir = join(PROJECT_ROOT, ".rn-dev", "profiles");
    mkdirSync(profileDir, { recursive: true });

    // Flip existing defaults off (restore on teardown) + write the agent
    // profile as NON-default so the GUI boots no session of its own — it
    // can only ever show the agent's session via the watcher.
    const flipped: Array<{ path: string; original: string }> = [];
    for (const f of readdirSync(profileDir).filter((x) => x.endsWith(".json"))) {
      const fp = join(profileDir, f);
      const original = readFileSync(fp, "utf8");
      try {
        const p = JSON.parse(original) as { isDefault?: boolean };
        if (p.isDefault === true) { p.isDefault = false; writeFileSync(fp, JSON.stringify(p, null, 2)); flipped.push({ path: fp, original }); }
      } catch { /* skip */ }
    }
    writeFileSync(
      join(profileDir, `${AGENT_PROFILE}.json`),
      JSON.stringify(androidProfile(AGENT_PROFILE, false, AGENT_PORT, EMULATOR, branch), null, 2),
    );

    const socketPath = join(PROJECT_ROOT, ".rn-dev", "sock");
    const pidPath = join(PROJECT_ROOT, ".rn-dev", "pid");
    const userDataDir = join(PROJECT_ROOT, ".rn-dev", "gui-observes-user-data");
    mkdirSync(userDataDir, { recursive: true });

    let agent: DaemonSession | undefined;
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    let client: IpcClient | undefined;
    const agentDeltas: number[] = [];
    let agentDevtoolsDisconnected = false;

    try {
      // ---- The "agent": cold-spawn the daemon + boot + build a session ----
      grantAndColdStart(EMULATOR);
      console.log("[GO] agent connecting (cold-spawns daemon, boots Metro)...");
      agent = await connectToDaemonSession(
        PROJECT_ROOT,
        androidProfile(AGENT_PROFILE, false, AGENT_PORT, EMULATOR, branch) as never,
        { daemonEntry: DAEMON_ENTRY },
      );
      const agentSid = agent.sessionId;
      console.log(`[GO] agent session running sid=${agentSid}; triggering build...`);
      agent.devtools.on("delta", (d: { addedIds?: string[] }) => {
        agentDeltas.push(d.addedIds?.length ?? 0);
      });
      agent.devtools.on("disconnected", () => { agentDevtoolsDisconnected = true; });

      // Build + install + launch the app on the emulator (same call the
      // Electron GUI makes for its own tabs). This makes the agent session
      // a fully-live, capturing session for the GUI to observe.
      triggerBuildsIfNeeded(agent, androidProfile(AGENT_PROFILE, false, AGENT_PORT, EMULATOR, branch) as never, PROJECT_ROOT);

      console.log("[GO] waiting for agent build done...");
      await waitForAdapterEvent(agent.builder, "done", (e: { success?: boolean }) => e.success === true, 20 * 60_000);
      console.log("[GO] agent build OK; waiting for agent network capture (delta)...");
      await waitFor(() => Promise.resolve(agentDeltas.length > 0), 5 * 60_000, "agent captured no network delta");
      const deltasBeforeGui = agentDeltas.length;
      console.log(`[GO] ✅ agent fully live + capturing (${deltasBeforeGui} deltas). Now opening the GUI...`);

      // ---- The human: open the Electron GUI (no default profile) ----
      let stderrBuf = "";
      app = await electron.launch({
        args: [join(REPO_ROOT, "electron", "launcher.cjs"), `--user-data-dir=${userDataDir}`],
        cwd: PROJECT_ROOT,
        stderr: "pipe", stdout: "pipe",
        env: { ...process.env, RN_DEV_PROJECT_ROOT: PROJECT_ROOT, RN_DEV_SMOKE: "1" },
        timeout: 30_000,
      });
      app.process().stderr?.on("data", (c: Buffer) => { stderrBuf += c.toString(); });
      const page = await app.firstWindow({ timeout: 30_000 });
      await expect(page.locator(".sidebar")).toBeVisible({ timeout: 60_000 });

      // 1. The agent session auto-appears as a read-only 🤖 tab.
      const observeTab = page.locator(".instance-tab.observed");
      await expect(observeTab).toBeVisible({ timeout: 60_000 });
      expect((await observeTab.textContent()) ?? "").toContain("🤖");
      console.log("[GO] ✅ agent session auto-surfaced as a 🤖 observe tab");
      await observeTab.click();

      // 2. Read-only banner + the "observing" service-log line.
      await expect(page.locator(".observe-banner")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/Observing agent session/i).first()).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: join(SCREENSHOT_DIR, "01-observe-tab-banner.png") });

      // 3. RN DevTools (Fusebox) loads read-only: container shows, the
      //    read-only chip is present, and there is NO Reconnect button.
      await page.locator('button[aria-label="DevTools"]').click();
      await expect(page.locator(".devtools-container")).toBeVisible({ timeout: 90_000 });
      await expect(page.locator(".devtools-toolbar-readonly")).toBeVisible({ timeout: 10_000 });
      expect(await page.getByRole("button", { name: /reconnect/i }).count()).toBe(0);
      await page.screenshot({ path: join(SCREENSHOT_DIR, "02-observe-devtools-readonly.png") });
      console.log("[GO] ✅ RN DevTools loaded read-only (chip shown, no Reconnect)");

      client = new IpcClient(socketPath);

      // 4. Opening the GUI's Fusebox did NOT break the agent's capture:
      //    the shared per-session proxy still has a port + targets, and the
      //    agent's devtools stream never disconnected.
      const agentStatus = await agent.devtools.status();
      expect(agentDevtoolsDisconnected, "agent devtools stream disconnected after GUI opened Fusebox").toBe(false);
      expect(agentStatus.proxyPort, "agent CDP proxy went away after GUI Fusebox connect").not.toBeNull();
      expect(agentStatus.targets.length, "agent lost its CDP target after GUI Fusebox connect").toBeGreaterThan(0);
      console.log(`[GO] ✅ agent capture survived GUI Fusebox connect (proxy ${agentStatus.proxyPort}, ${agentStatus.targets.length} targets)`);

      // 5. Close the observe tab → the agent's session must KEEP RUNNING.
      await observeTab.locator(".instance-tab-close").click();
      // Modal copy proves the read-only close affordance. Scope to the
      // modal: the tab's close button also has a "Stop observing…"
      // aria-label, so an unscoped role query is ambiguous (strict mode).
      const confirmModal = page.locator(".prompt-modal");
      await expect(confirmModal.getByRole("button", { name: /stop observing/i })).toBeVisible({ timeout: 10_000 });
      await confirmModal.getByRole("button", { name: /stop observing/i }).click();
      await expect(page.locator(".instance-tab.observed")).toHaveCount(0, { timeout: 15_000 });

      // Give the daemon a beat to process our observer detach, then assert
      // the agent's session is STILL there + running (we only detached a
      // read-only observer; we did not session/stop it).
      await page.waitForTimeout(2_000);
      const listResp = await client.send({ type: "command", action: "sessions/list", id: `go-list-${Date.now()}` });
      const entries = (listResp.payload as { sessions?: Array<{ sessionId?: string; status?: string }> }).sessions ?? [];
      const stillThere = entries.find((e) => e.sessionId === agentSid);
      expect(stillThere, `agent session ${agentSid} was killed by closing the observe tab`).toBeTruthy();
      expect(stillThere?.status).toBe("running");
      console.log("[GO] ✅ closing the observe tab left the agent session running — read-only confirmed");

      if (stderrBuf.length > 0 && process.env.GO_DUMP_STDERR === "1") {
        console.log("=== GO electron stderr tail ===\n" + stderrBuf.slice(-3000));
      }
    } finally {
      await app?.close().catch(() => undefined);
      // Stop the agent's session (kill-for-everyone) then clean up.
      await agent?.stop().catch(() => undefined);
      const daemonPid = readPidFromLockfile(pidPath);
      if (daemonPid !== null) await terminateDaemonPid(daemonPid);
      try {
        for (const { path, original } of flipped) writeFileSync(path, original);
        rmSync(join(profileDir, `${AGENT_PROFILE}.json`), { force: true });
        rmSync(socketPath, { force: true });
        rmSync(pidPath, { force: true });
        rmSync(userDataDir, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
  });
});

// ---- helpers ----

async function waitForAdapterEvent(
  emitter: { on: (ev: string, fn: (payload: never) => void) => void; off?: (ev: string, fn: (payload: never) => void) => void },
  event: string,
  pred: (payload: never) => boolean,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolveP, reject) => {
    const timer = setTimeout(() => {
      emitter.off?.(event, onEvt);
      reject(new Error(`waitForAdapterEvent(${event}): timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onEvt = (payload: never): void => {
      if (!pred(payload)) return;
      clearTimeout(timer);
      emitter.off?.(event, onEvt);
      resolveP();
    };
    emitter.on(event, onEvt);
  });
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

async function terminateDaemonPid(pid: number): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 50));
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* dead */ }
}
