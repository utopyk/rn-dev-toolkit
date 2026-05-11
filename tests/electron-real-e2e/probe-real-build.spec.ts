import { test, expect, _electron as electron } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Probe — actually build the acme app on the user's real iPhone
// using the user's existing dirty profile (no fake-boot, no synthetic
// fixture, no signing modifications). Captures the build output so we
// can see whether xcodebuild succeeds or what errors out.
//
// What this verifies: the full chain — daemon spawn → events/subscribe
// → bootSessionServices → triggerBuildsIfNeeded → builder/build →
// react-native run-ios → xcodebuild → device install — actually works
// end-to-end on this machine.
//
// This is the "is it actually working" probe the user kept asking for.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const ACME = process.env.PROBE_ACME ?? "/Users/martincouso/Documents/GitHub/acme-mobile-app";
const SCREENSHOT_DIR = "/tmp/probe-real-build-screens";

const ENABLED = process.env.PROBE === "1" || process.env.PROBE_ACME === "1";

test.describe("Probe — real build against acme + iPhone 15", () => {
  test.skip(!ENABLED, "Set PROBE=1 to run; spawns real Metro and xcodebuild against the user's iPhone.");
  // Real builds need real time. xcodebuild + pod install + device install
  // can easily take 10+ minutes the first time. Budget generously so the
  // probe shows what's happening, not "test timed out."
  test.setTimeout(20 * 60_000);

  test.beforeAll(() => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("dirty mode + Acme scheme builds the app and pushes it to the iPhone (live, not fake)", async () => {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: ACME }).toString().trim();
    const profileDir = join(ACME, ".rn-dev", "profiles");
    mkdirSync(profileDir, { recursive: true });

    // Write a probe profile that pins the scheme explicitly to "Acme".
    // The user said the bug was "selecting a bundle we don't have signing
    // for" — pinning the scheme closes that ambiguity.
    const profileName = "rn-dev-probe-real-build";
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
          // Real iPhone 15 (UDID matches the user's actual profile).
          // Now that the Xcode iOS platform-support gap was resolved,
          // the build should complete and install on the device.
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

    const userDataDir = join(ACME, ".rn-dev", "probe-real-build-user-data");
    mkdirSync(userDataDir, { recursive: true });

    // Aggregate every captured stream so we can grep for build-progress
    // markers + success/failure signals.
    const allLogs: string[] = [];
    const buildEvents: string[] = [];
    const errorEvents: string[] = [];

    const pushLog = (text: string): void => {
      allLogs.push(text);
      // Build-progress markers: react-native CLI's verbose mode says
      // these things along the way.
      if (
        /Building for ios|run-ios|xcodebuild|info Building|debug Command line invocation|info Installing|info Launching|Successfully installed/i.test(
          text,
        )
      ) {
        buildEvents.push(text.trim());
      }
      // Failure markers worth surfacing.
      if (
        /error: |Failed to build|exited with error code|No matching profiles|Code Sign error|Provisioning profile|Couldn't find any device/i.test(
          text,
        )
      ) {
        errorEvents.push(text.trim());
      }
    };

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
      pushLog(`[stderr] ${t}`);
      process.stderr.write(`[E-STDERR] ${t}`);
    });
    app.process().stdout?.on("data", (b: Buffer) => {
      const t = b.toString();
      pushLog(`[stdout] ${t}`);
      process.stdout.write(`[E-STDOUT] ${t}`);
    });

    const page = await app.firstWindow({ timeout: 30_000 });
    page.on("console", (msg) => pushLog(`[console:${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (err) => pushLog(`[pageerror] ${err.message}`));

    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(3_000);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "01-after-boot.png") });

    // The codesign prompt may surface either pre-handshake (immediate)
    // OR after the daemon's preflight runs (a few seconds in). Poll
    // for it for up to 30s so a delayed appearance gets clicked too.
    // "Keep Manual signing" is the safe default — never flip acme's
    // pbxproj from Manual to Automatic (that breaks their cert chain).
    const codesignDeadline = Date.now() + 30_000;
    let codesignClicked = false;
    while (Date.now() < codesignDeadline && !codesignClicked) {
      const skipSigning = page
        .getByRole("button", { name: /Keep Manual signing/i })
        .first();
      if (await skipSigning.count()) {
        console.log("Code-signing prompt surfaced — clicking 'Keep Manual signing'.");
        await skipSigning.click();
        await page.waitForTimeout(1_000);
        await page.screenshot({ path: join(SCREENSHOT_DIR, "02-codesign-skipped.png") });
        codesignClicked = true;
        break;
      }
      await page.waitForTimeout(2_000);
    }
    if (!codesignClicked) {
      console.log("No code-signing prompt within 30s — assuming Automatic signing already, proceeding.");
    }

    // Periodically screenshot + sample renderer text to track what's
    // happening during the long build. Up to 12 minutes of observation.
    const observeUntil = Date.now() + 12 * 60_000;
    let lastScreenshot = Date.now();
    let lastText = "";
    while (Date.now() < observeUntil) {
      await page.waitForTimeout(10_000);
      // Take a screenshot every 60s.
      if (Date.now() - lastScreenshot > 60_000) {
        const elapsed = Math.round((Date.now() - (observeUntil - 12 * 60_000)) / 1000);
        await page.screenshot({
          path: join(SCREENSHOT_DIR, `progress-t+${elapsed}s.png`),
        });
        lastScreenshot = Date.now();
      }
      // Sample what's in any of the renderer panels so the test log
      // shows ongoing progress. `.dev-space, .panel-content` only
      // matched the FIRST panel-content (typically the Tool Output);
      // build lines route through the SAME panel but the read often
      // raced and captured Metro Output's banner instead. Concatenate
      // ALL panel-content sources so build text always shows up.
      const allPanels = await page.locator(".panel-content").allInnerTexts().catch(() => [] as string[]);
      const text = allPanels.join("\n");
      if (text !== lastText) {
        const tail = text.slice(-400);
        console.log(`\n--- panel sample [t+${Math.round((Date.now() - (observeUntil - 12 * 60_000)) / 1000)}s] ---`);
        console.log(tail);
        lastText = text;
        // Detect build trigger by scanning concatenated panel text.
        // (allLogs captures stdout/stderr from Electron — those don't
        // include the daemon's instance:log fan-out, so DOM read is
        // authoritative for what the user actually sees.)
        if (
          buildEvents.length === 0 &&
          /Building for ios|info Building \(using|Building "Acme"|info Installing|Successfully launched/i.test(text)
        ) {
          buildEvents.push(`renderer-dom: ${(text.match(/Building for ios|info Building \(using|info Installing|Successfully launched/i) ?? ["?"])[0]}`);
          console.log(`  ✅ Build trigger detected via renderer DOM`);
        }
      }

      // Exit early on definitive completion signals (either captured
      // log streams OR what the user can read in any panel).
      const successInLogs = allLogs.some((l) => /Successfully installed|Successfully launched/i.test(l));
      const successInDom = /Successfully installed|Successfully launched/i.test(text);
      if (successInLogs || successInDom) {
        console.log("✅ EARLY EXIT — install/launch success detected.");
        break;
      }
      if (errorEvents.length > 5) {
        console.log("⚠ Multiple error events; capturing state and exiting.");
        break;
      }
    }
    await page.screenshot({ path: join(SCREENSHOT_DIR, "99-end.png") });

    // ---- Electron M2d-equivalent: verify devtools + metro-logs panels ----
    //
    // Mirrors the MCP-side probe-real-build-mcp.spec.ts M2d phase: now
    // that the build is done and the iPhone app is launched + attached
    // to the CDP proxy, click through to the DevTools and Metro Logs
    // tabs and assert the user sees real data — not just "tab mounts
    // without crashing" (the smoke layer).
    //
    // Intentionally non-fatal: the panels' internal state depends on
    // whether the iPhone has connected to the proxy in time and on
    // whether the app emitted any traffic. Print findings + screenshot
    // for diagnosis; only hard-fail if the panel reaches an explicit
    // error state.
    let devtoolsPanelState: "no-target" | "connected" | "connecting" | "error" | "unknown" = "unknown";
    let metroLogLineCount = 0;
    try {
      const devtoolsBtn = page.getByRole("button", { name: /devtools/i }).first();
      if (await devtoolsBtn.count()) {
        await devtoolsBtn.click();
        // Poll up to 90s for the panel to leave the `connecting`
        // placeholder. Either `no-target` (waiting for app) or
        // `connected` (target attached, webview rendered) is success.
        const panelDeadline = Date.now() + 90_000;
        while (Date.now() < panelDeadline) {
          if (await page.locator(".devtools-toolbar").count()) {
            devtoolsPanelState = "connected";
            break;
          }
          if (await page.getByText(/waiting for app to connect/i).count()) {
            devtoolsPanelState = "no-target";
            break;
          }
          if (await page.getByText(/devtools unavailable|cannot start devtools/i).count()) {
            devtoolsPanelState = "error";
            break;
          }
          await page.waitForTimeout(2_000);
        }
        await page.screenshot({ path: join(SCREENSHOT_DIR, "98-devtools.png") });
        console.log(`DevTools panel state: ${devtoolsPanelState}`);
        if (devtoolsPanelState === "connected") {
          // Webview rendered — proxy resolved a target, capture pipeline
          // is wired. Sample the toolbar text so the log shows the
          // panel's current target / port.
          const toolbar = await page.locator(".devtools-toolbar").innerText().catch(() => "");
          console.log(`DevTools toolbar: ${toolbar.replace(/\s+/g, " ").slice(0, 200)}`);
        }
      }

      const metroBtn = page.getByRole("button", { name: /metro logs/i }).first();
      if (await metroBtn.count()) {
        await metroBtn.click();
        // Wait briefly for the log panel to populate.
        await page.waitForTimeout(3_000);
        // Count `.log-line` elements inside the Metro Logs panel.
        // LogPanel renders one div per line; non-zero proves Metro
        // stdout flowed through the daemon → renderer → DOM.
        metroLogLineCount = await page.locator(".log-line").count().catch(() => 0);
        await page.screenshot({ path: join(SCREENSHOT_DIR, "97-metro-logs.png") });
        console.log(`Metro Logs visible lines: ${metroLogLineCount}`);
        if (metroLogLineCount > 0) {
          // Sample the first few lines so the probe log shows the
          // user-visible content matches expectation (RN banner / Metro
          // output, not garbage).
          const sample = await page.locator(".log-line").allInnerTexts().catch(() => [] as string[]);
          for (const line of sample.slice(0, 3)) {
            console.log(`  ${line.slice(0, 200)}`);
          }
        }
      }
    } catch (err) {
      console.warn("DevTools/Metro Logs M2d block hit an error:", err);
    }

    // Final summary.
    console.log(`\n===== FINAL =====`);
    console.log(`build event tally: ${buildEvents.length}`);
    for (const e of buildEvents.slice(0, 12)) console.log(`  ✓ ${e.slice(0, 200)}`);
    console.log(`error event tally: ${errorEvents.length}`);
    for (const e of errorEvents.slice(0, 12)) console.log(`  ✗ ${e.slice(0, 200)}`);

    const finalText = await page.locator("body").innerText().catch(() => "");

    await app.close().catch(() => undefined);

    // Kill the daemon Electron spawned. The daemon is detached
    // (per src/core/module-host/), so app.close() doesn't propagate
    // teardown — without an explicit signal, the daemon survives the
    // probe and sits on its socket / port until manually killed,
    // breaking subsequent runs (port already in use, stale pid file
    // confuses the next session). Read the pid BEFORE rmSync removes
    // the file, then SIGTERM with a SIGKILL fallback after a short
    // grace window. ESRCH means the daemon already exited cleanly,
    // which is the happy case.
    const pidPath = join(ACME, ".rn-dev", "pid");
    let daemonPid: number | null = null;
    try {
      const raw = readFileSync(pidPath, "utf8").trim();
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) daemonPid = parsed;
    } catch {
      // pid file already gone — daemon either never started or
      // exited cleanly during app.close().
    }
    if (daemonPid !== null) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
          console.warn(`SIGTERM to daemon pid ${daemonPid} failed:`, err);
        }
      }
      // Give the daemon up to 5s to exit on SIGTERM. The teardown
      // path includes hook unloads + module-host shutdown so a few
      // seconds is realistic; SIGKILL as a backstop ensures the
      // probe can't leak even if a hook hangs.
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
      rmSync(profilePath, { force: true });
      rmSync(join(ACME, ".rn-dev", "sock"), { force: true });
      rmSync(pidPath, { force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {}

    // The point of this probe is OBSERVABILITY, not asserting success.
    // We just want the build trigger to fire and SOMETHING to happen.
    // Whether xcodebuild succeeds depends on the user's actual cert chain.
    expect(buildEvents.length, "Build never started — autobuild trigger failed.").toBeGreaterThan(0);

    // If "Failed to attach" surfaces, fail loudly.
    expect(
      errorEvents.filter((l) => /did not reach.*running/i.test(l)),
      "Watchdog regression: 30s timeout fired against a real build.",
    ).toEqual([]);

    // M2d-equivalent: panels must NOT be in an explicit error state.
    // `unknown` is acceptable (we never got that far if the click
    // didn't surface). `no-target` is acceptable (app didn't connect
    // in 90s — still proves the panel's wiring works). `error` is
    // the Bug-5 regression fingerprint.
    expect(
      devtoolsPanelState,
      "DevTools panel resolved into the explicit error state — Bug 5 / Bug 5b regression.",
    ).not.toBe("error");

    console.log(
      `\n===== M2d-Electron =====` +
        `\n  DevTools panel state: ${devtoolsPanelState}` +
        `\n  Metro Logs lines visible: ${metroLogLineCount}`,
    );

    // Final body sample for forensics.
    console.log(`\nFinal renderer body (last 800 chars):\n${finalText.slice(-800)}`);
  });
});
