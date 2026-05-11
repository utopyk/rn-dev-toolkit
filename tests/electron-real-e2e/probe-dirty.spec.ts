import { test, expect, _electron as electron } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Probe spec — drives the REAL acme project with a `dirty`-mode profile,
// asserts the user-reported bugs:
//   1. dirty mode actually triggers a build
//   2. close-tab actually closes (vs. user report "still doesn't work")
//   3. (in a follow-up) starting a 2nd tab with `clean` doesn't time out
// Captures screenshots so verification is visual + textual.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const ACME = process.env.PROBE_ACME ?? "/Users/martincouso/Documents/GitHub/acme-mobile-app";
const SCREENSHOT_DIR = "/tmp/probe-screens";
const PROFILE_NAME = "rn-dev-probe-dirty";

const ENABLED = process.env.PROBE_ACME === "1" || process.env.PROBE === "1";

test.describe("Probe — real acme user bugs", () => {
  test.skip(!ENABLED, "Set PROBE=1 to run; writes a profile into the acme tree.");
  test.setTimeout(180_000);

  test.beforeAll(() => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("dirty mode triggers a build + close-tab actually closes (with screenshots)", async () => {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: ACME }).toString().trim();
    const profileDir = join(ACME, ".rn-dev", "profiles");
    mkdirSync(profileDir, { recursive: true });
    const profilePath = join(profileDir, `${PROFILE_NAME}.json`);
    writeFileSync(
      profilePath,
      JSON.stringify(
        {
          name: PROFILE_NAME,
          isDefault: true,
          worktree: null,
          branch,
          platform: "ios",
          mode: "dirty",
          metroPort: 8099,
          devices: { ios: "00008130-001A653A3E11001C", android: null },
          buildVariant: "debug",
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

    const userDataDir = join(ACME, ".rn-dev", "probe-electron-user-data");
    mkdirSync(userDataDir, { recursive: true });

    const buildEvents: string[] = [];
    const allLogs: string[] = [];

    const app = await electron.launch({
      args: [join(REPO_ROOT, "electron", "launcher.cjs"), `--user-data-dir=${userDataDir}`],
      cwd: ACME,
      stderr: "pipe",
      stdout: "pipe",
      env: {
        ...process.env,
        RN_DEV_PROJECT_ROOT: ACME,
        RN_DEV_SMOKE: "1",
      },
      timeout: 30_000,
    });

    app.process().stderr?.on("data", (b: Buffer) => {
      const t = b.toString();
      allLogs.push(`[stderr] ${t}`);
      process.stderr.write(`[ELECTRON-STDERR] ${t}`);
    });
    app.process().stdout?.on("data", (b: Buffer) => {
      const t = b.toString();
      allLogs.push(`[stdout] ${t}`);
      process.stdout.write(`[ELECTRON-STDOUT] ${t}`);
      if (/builder\/build|\[builder\]|\[build\]|run-ios|xcodebuild|pod install|gradle|building|build started/i.test(t)) {
        buildEvents.push(t.trim());
      }
    });

    const page = await app.firstWindow({ timeout: 30_000 });

    page.on("console", (msg) => {
      const t = msg.text();
      allLogs.push(`[console:${msg.type()}] ${t}`);
      if (/builder\/build|building|build started|run-ios/i.test(t)) {
        buildEvents.push(`[console] ${t}`);
      }
    });
    page.on("pageerror", (err) => allLogs.push(`[pageerror] ${err.message}`));

    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(3_000);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "01-after-boot.png") });

    // The dirty-mode flow surfaces an interactive Code Signing Conflict
    // modal before the build can start (Manual signing in acme's
    // Xcode project triggers it). Click through "Switch to Automatic"
    // — the same path a real user would take. If the modal isn't
    // present (e.g. Automatic is already set), the wait silently
    // succeeds and we move on.
    const switchAuto = page.getByRole("button", { name: /switch to automatic/i }).first();
    if (await switchAuto.count()) {
      await page.screenshot({ path: join(SCREENSHOT_DIR, "01b-modal-codesign.png") });
      await switchAuto.click();
      await page.waitForTimeout(2_000);
      await page.screenshot({ path: join(SCREENSHOT_DIR, "01c-modal-dismissed.png") });
    }
    // Same for any package-manager prompt.
    const pmPnpm = page.getByRole("button", { name: /^pnpm$/i }).first();
    if (await pmPnpm.count()) {
      await pmPnpm.click();
      await page.waitForTimeout(1_000);
    }

    // === Test 1: dirty mode should trigger a build within 90s ===
    // Build output lands in the Tool Output panel via instance:log IPC,
    // not in the daemon's stdout, so reading the renderer DOM is the
    // right way to detect "build started". The trigger we want to see
    // is `react-native run-ios` / `xcodebuild` / `Building for ios`.
    const buildRegex = /xcodebuild|run-ios|Building for ios|react-native run-/i;
    const buildDeadline = Date.now() + 90_000;
    let buildSeen = false;
    while (Date.now() < buildDeadline) {
      await page.waitForTimeout(2_000);
      const bodyText = await page.locator(".dev-space, .panel-content, .app-content").first().innerText().catch(() => "");
      if (buildRegex.test(bodyText) || buildEvents.length > 0) {
        buildSeen = true;
        break;
      }
    }
    await page.screenshot({ path: join(SCREENSHOT_DIR, "02-after-build-wait.png") });
    if (buildSeen) {
      const bodyText = await page.locator(".dev-space, .panel-content").first().innerText().catch(() => "");
      const matches = bodyText.match(buildRegex);
      console.log(`  ✅ Build trigger detected via renderer DOM: ${matches?.[0]}`);
      buildEvents.push(`renderer-dom: ${matches?.[0]}`);
    }

    console.log(`\n=== BUILD EVENT TALLY: ${buildEvents.length} ===`);
    for (const e of buildEvents.slice(0, 8)) console.log(`  - ${e.slice(0, 160)}`);

    // === Test 2: close tab ===
    // The close button is opacity:0 unless the tab is hovered or active.
    // The active tab has opacity:1 per CSS, but Playwright's
    // getByRole counts visibility, so ensure we hover the tab first.
    const tab = page.locator(".instance-tab").first();
    const tabsBefore = await page.locator(".instance-tab").count();
    console.log(`\n=== TABS BEFORE CLOSE: ${tabsBefore} ===`);
    await tab.hover().catch(() => undefined);
    await page.waitForTimeout(300);
    const closeBtn = page.locator(".instance-tab .instance-tab-close").first();
    const closeCount = await closeBtn.count();
    console.log(`Close button count (visible after hover): ${closeCount}`);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "03-before-close.png") });
    let tabClosed = false;
    if (closeCount > 0) {
      await closeBtn.click({ force: true });
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(SCREENSHOT_DIR, "04-after-1st-close-click.png") });
      // After 1st click button has .confirming class — second click confirms.
      const armed = page.locator(".instance-tab .instance-tab-close.confirming").first();
      const armedCount = await armed.count();
      console.log(`Confirming-class buttons after 1st click: ${armedCount}`);
      if (armedCount > 0) {
        await armed.click({ force: true });
        await page.waitForTimeout(2000);
        await page.screenshot({ path: join(SCREENSHOT_DIR, "05-after-2nd-close-click.png") });
        const tabsLeft = await page.locator(".instance-tab").count();
        console.log(`.instance-tab count after confirm: ${tabsLeft} (was ${tabsBefore})`);
        tabClosed = tabsLeft < tabsBefore;
      } else {
        await page.screenshot({ path: join(SCREENSHOT_DIR, "04b-no-arm.png") });
      }
    }
    console.log(`Tab closed: ${tabClosed}`);

    await app.close().catch(() => undefined);

    // Cleanup ONLY what we wrote.
    try { rmSync(profilePath, { force: true }); } catch {}
    try { rmSync(join(ACME, ".rn-dev", "sock"), { force: true }); } catch {}
    try { rmSync(join(ACME, ".rn-dev", "pid"), { force: true }); } catch {}
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}

    // ASSERTIONS — these will fail loudly if the bugs are real.
    expect(
      buildEvents.length,
      `dirty mode did NOT trigger a build within 30s. ` +
        `Captured ${buildEvents.length} build-related log lines. ` +
        `See ${SCREENSHOT_DIR}/02-after-build-wait.png. ` +
        `Recent logs: ${allLogs.slice(-30).join("").slice(-2000)}`,
    ).toBeGreaterThan(0);
    expect(
      tabClosed,
      `Close-tab two-click flow failed. ` +
        `closeButtonCount=${closeCount}. ` +
        `See ${SCREENSHOT_DIR}/05-after-2nd-close-click.png.`,
    ).toBe(true);
  });
});
