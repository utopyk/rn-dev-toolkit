import { test, expect, _electron as electron } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Probe — reproduce the user-reported bug:
//   "Starting a new tab with a different mode like clean throws
//    'Failed to attach daemon session: connectToDaemonSession:
//    session did not reach "running" within 30000ms'"
//
// With the new progress-based watchdog (commit 2ddf0e0) in place, this
// should NOT surface — the daemon's clean boot will keep emitting
// progress events long past the legacy 30s wall-clock timeout, and
// the watchdog only fires on genuine silence.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const ACME = process.env.PROBE_ACME ?? "/Users/martincouso/Documents/GitHub/acme-mobile-app";
const SCREENSHOT_DIR = "/tmp/probe-second-tab-screens";

const ENABLED = process.env.PROBE === "1" || process.env.PROBE_ACME === "1";

test.describe("Probe — 2nd-tab clean-mode attach", () => {
  test.skip(!ENABLED, "Set PROBE=1 to run; writes profiles into the acme tree.");
  test.setTimeout(360_000);

  test.beforeAll(() => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("opening a 2nd tab with a different-mode profile does NOT fail with 'session did not reach running'", async () => {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: ACME }).toString().trim();
    const profileDir = join(ACME, ".rn-dev", "profiles");
    mkdirSync(profileDir, { recursive: true });

    // Profile 1: dirty mode, will be the default that boots first.
    const profile1 = "rn-dev-probe-tab1-dirty";
    writeFileSync(
      join(profileDir, `${profile1}.json`),
      JSON.stringify(
        {
          name: profile1,
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

    // Profile 2: clean mode, the one the user reported failing on the 2nd tab.
    const profile2 = "rn-dev-probe-tab2-clean";
    writeFileSync(
      join(profileDir, `${profile2}.json`),
      JSON.stringify(
        {
          name: profile2,
          isDefault: false,
          worktree: null,
          branch,
          platform: "ios",
          mode: "clean",
          metroPort: 8100,
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

    const userDataDir = join(ACME, ".rn-dev", "probe-second-tab-user-data");
    mkdirSync(userDataDir, { recursive: true });

    const allLogs: string[] = [];
    const errorLogs: string[] = [];
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
      if (/Failed to attach|did not reach.*running|session boot stalled|appears wedged/i.test(t)) errorLogs.push(t);
      process.stderr.write(`[E-STDERR] ${t}`);
    });
    app.process().stdout?.on("data", (b: Buffer) => {
      const t = b.toString();
      allLogs.push(`[stdout] ${t}`);
      if (/Failed to attach|did not reach.*running|session boot stalled|appears wedged/i.test(t)) errorLogs.push(t);
      process.stdout.write(`[E-STDOUT] ${t}`);
    });

    const page = await app.firstWindow({ timeout: 30_000 });
    page.on("console", (msg) => {
      const t = msg.text();
      allLogs.push(`[console:${msg.type()}] ${t}`);
      if (/Failed to attach|did not reach.*running|session boot stalled|appears wedged/i.test(t)) errorLogs.push(t);
    });
    page.on("pageerror", (err) => {
      allLogs.push(`[pageerror] ${err.message}`);
      errorLogs.push(err.message);
    });

    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(3_000);

    // Dismiss the codesign modal IF it appears — let the user's
    // existing setup stay (don't auto-flip to Automatic).
    const skipSigning = page.getByRole("button", { name: /Skip.*I have the certificates/i }).first();
    if (await skipSigning.count()) {
      await skipSigning.click();
      await page.waitForTimeout(1_000);
    }
    await page.screenshot({ path: join(SCREENSHOT_DIR, "01-after-tab1-boot.png") });

    // Wait for tab 1 to be running before opening the 2nd tab.
    // "Running" indicator appears in the status bar.
    await page.waitForTimeout(8_000);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "02-tab1-running.png") });

    // Click the "+" button to open the new-instance dialog.
    const addBtn = page.locator(".instance-tab-add").first();
    if (!(await addBtn.count())) {
      throw new Error("Could not find the add-instance (+) button — tab strip may not have rendered.");
    }
    await addBtn.click();
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "03-add-dialog-open.png") });

    // The new-instance dialog lets the user pick from existing
    // profiles. Look for the clean-profile entry by its name.
    const cleanProfileBtn = page
      .getByText(new RegExp(profile2, "i"))
      .first();
    if (!(await cleanProfileBtn.count())) {
      // Some dialogs surface profiles in a different way. Take a
      // screenshot so we can see the actual UI before failing.
      await page.screenshot({ path: join(SCREENSHOT_DIR, "03b-no-profile-found.png") });
      throw new Error(
        `Could not find profile "${profile2}" in the new-instance dialog. ` +
          `See ${SCREENSHOT_DIR}/03b-no-profile-found.png.`,
      );
    }
    await cleanProfileBtn.click();
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "04-clean-profile-selected.png") });

    // Some dialogs have a final "Open" / "Create" button to confirm.
    const confirmBtn = page
      .getByRole("button", { name: /open|create|attach|start/i })
      .first();
    if (await confirmBtn.count()) {
      await confirmBtn.click();
      await page.waitForTimeout(1_500);
    }
    await page.screenshot({ path: join(SCREENSHOT_DIR, "05-after-confirm.png") });

    // Now wait — the clean-mode boot should make progress for several
    // minutes (pnpm install + pod install + watchman wipe). With the
    // watchdog fix, the renderer should stay healthy. Without it,
    // pre-fix, "Failed to attach... did not reach running within 30000ms"
    // would surface within ~30s.
    const observationDeadline = Date.now() + 90_000; // observe for 90s
    while (Date.now() < observationDeadline) {
      await page.waitForTimeout(5_000);
      // Take a screenshot every 30s for a record of progress.
      const elapsed = Math.round((Date.now() - (observationDeadline - 90_000)) / 1000);
      if (elapsed % 30 === 0) {
        await page.screenshot({
          path: join(SCREENSHOT_DIR, `06-progress-t+${elapsed}s.png`),
        });
      }
      // Fast-fail if a regression surfaces the legacy error.
      if (errorLogs.some((l) => /did not reach.*running.*30000ms/i.test(l))) {
        await page.screenshot({ path: join(SCREENSHOT_DIR, "06-regression.png") });
        break;
      }
    }
    await page.screenshot({ path: join(SCREENSHOT_DIR, "07-end.png") });

    const finalText = await page.locator("body").innerText().catch(() => "");
    const tabs = await page.locator(".instance-tab").count();
    console.log(`\n=== After 90s observation ===`);
    console.log(`Tabs visible: ${tabs}`);
    console.log(`Error log entries: ${errorLogs.length}`);
    for (const e of errorLogs.slice(0, 5)) console.log(`  ! ${e.slice(0, 200)}`);

    await app.close().catch(() => undefined);

    // Cleanup ONLY what we wrote.
    try {
      rmSync(join(profileDir, `${profile1}.json`), { force: true });
      rmSync(join(profileDir, `${profile2}.json`), { force: true });
      rmSync(join(ACME, ".rn-dev", "sock"), { force: true });
      rmSync(join(ACME, ".rn-dev", "pid"), { force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {}

    // ASSERTIONS — fail the test if the user-reported regression occurs.
    expect(
      errorLogs.filter((l) => /did not reach.*running.*30000ms/i.test(l)),
      `User-reported regression surfaced: 'Failed to attach daemon session: session did not reach "running" within 30000ms'. ` +
        `errorLogs: ${errorLogs.join("\n").slice(0, 1500)}. ` +
        `Final body: ${finalText.slice(0, 800)}.`,
    ).toEqual([]);

    // We don't assert success of the clean attach — clean mode against
    // acme legitimately takes minutes and may need user signing
    // confirmation. The point of this probe is the BUG: the 30s
    // wall-clock kill. Anything else (long progress, an error from
    // build itself, etc.) is acceptable for this assertion.
  });
});
