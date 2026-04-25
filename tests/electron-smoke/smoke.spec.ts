import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Pre-push verification standard for renderer-touching changes:
//   1. Run the vitest jsdom suite (cheap; catches TDZ, render crashes).
//   2. Run this Playwright smoke (boots real Electron + daemon; catches
//      IPC shape mismatches, boot-window races, the live "blank
//      screen" class of regressions).
//
// Coverage today: app boots, mounts the renderer, the Marketplace +
// Settings tabs each render their content (not a "no modules
// registered" / "Failed to load" alarm) within the 30s budget. The
// stuck-on-loading regression Martin reported on PR #20 would fail
// this spec at the Marketplace assertion.
//
// Future iterations: cover Metro Logs, DevTools Network, instance
// creation flow, profile wizard. Each tab gets one assertion that's
// load-bearing for "the panel actually works."

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const FIXTURE_SRC = join(HERE, "fixtures", "smoke-rn");

interface ElectronHandle {
  app: ElectronApplication;
  page: Page;
  tmpdir: string;
}

async function launchElectron(): Promise<ElectronHandle> {
  // Copy the smoke fixture into a fresh tmpdir so the daemon's
  // .rn-dev/sock + audit log + module install dir don't leak between
  // runs. Pre-write a default profile so `startRealServices` finds
  // one + connects to the daemon (instead of stalling on the wizard).
  const tmpRoot = mkdtempSync(join(tmpdir(), "rn-dev-smoke-"));
  cpSync(FIXTURE_SRC, tmpRoot, { recursive: true });
  const profilesDir = join(tmpRoot, ".rn-dev", "profiles");
  mkdirSync(profilesDir, { recursive: true });
  writeFileSync(
    join(profilesDir, "default.json"),
    JSON.stringify(
      {
        name: "default",
        isDefault: true,
        worktree: null,
        branch: "main",
        platform: "ios",
        // `quick` skips clean + code-sign + build; the daemon still
        // boots Metro but the smoke suite explicitly avoids depending
        // on Metro reaching "running" — handler wiring is what we're
        // proving.
        mode: "quick",
        metroPort: 8099,
        devices: {},
        buildVariant: "debug",
        preflight: { checks: [], frequency: "once" },
        onSave: [],
        env: {},
        projectRoot: tmpRoot,
      },
      null,
      2,
    ),
  );

  const app = await electron.launch({
    // Use the same launcher script `npm run dev:electron` uses — it
    // registers tsx for TypeScript support before loading main.ts.
    args: [join(REPO_ROOT, "electron", "launcher.cjs")],
    cwd: tmpRoot,
    // Pipe both Electron main + spawned daemon stderr so failures in
    // CI surface the actual error (handler timeouts, daemon spawn
    // failures, IPC mismatches) instead of leaving the test author
    // grepping log files.
    stderr: "pipe",
    stdout: "pipe",
    env: {
      ...process.env,
      // Force the daemon-boot mode to fake so we don't actually spawn
      // Metro. The Electron-side Marketplace + Settings tabs only need
      // the daemon's modules-IPC dispatcher live; fake-boot wires
      // `registerModulesIpc` (Phase 13.4.1) so all built-in module
      // registrations + modules:list flow through.
      RN_DEV_DAEMON_BOOT_MODE: "fake",
      // Pin projectRoot to the smoke fixture so detectProjectRoot's
      // walk-up doesn't latch onto the host repo or the hardcoded
      // movie-nights-club fallback in main.ts.
      RN_DEV_PROJECT_ROOT: tmpRoot,
      RN_DEV_SMOKE: "1",
    },
    timeout: 30_000,
  });

  // Forward Electron + daemon stderr/stdout to test stdout so a fail
  // case shows the actual error context.
  app.process().stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[electron-stderr] ${chunk.toString()}`);
  });
  app.process().stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[electron-stdout] ${chunk.toString()}`);
  });

  const page = await app.firstWindow({ timeout: 30_000 });
  return { app, page, tmpdir: tmpRoot };
}

async function teardownElectron(handle: ElectronHandle): Promise<void> {
  await handle.app.close().catch(() => {
    // Electron sometimes refuses to close cleanly under test harnesses;
    // tmpdir cleanup is the more important half.
  });
  try {
    rmSync(handle.tmpdir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

test.describe("Electron smoke", () => {
  let handle: ElectronHandle | null = null;

  test.afterEach(async () => {
    if (handle) {
      await teardownElectron(handle);
      handle = null;
    }
  });

  test("renderer mounts without uncaught console errors", async () => {
    handle = await launchElectron();
    const errors: string[] = [];
    handle.page.on("pageerror", (err) => {
      errors.push(err.message);
    });
    handle.page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    // Wait for the renderer's root sentinel (the sidebar mount marker)
    // to appear — confirms React rendered something rather than blank-
    // screened from a TDZ / missing-prop crash.
    await expect(handle.page.locator(".sidebar")).toBeVisible({ timeout: 30_000 });
    // Give the daemon-connect a beat to fire any deferred render that
    // would surface a console error.
    await handle.page.waitForTimeout(2_000);

    expect(errors, `renderer console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("Marketplace tab shows built-in modules", async () => {
    handle = await launchElectron();
    // Click the Marketplace nav item. The sidebar uses lucide-react
    // icons + label text; match by visible label.
    await handle.page.getByRole("button", { name: /marketplace/i }).click();

    // The Marketplace renders a "No modules registered" empty-state row
    // when modules:list returns []. After Phase 13.4.1 the boot-window
    // race made this fire even on a healthy daemon — the "stuck blank"
    // regression Martin reported. Asserting the marketplace table has
    // SOMETHING rendered for built-ins (dev-space / lint-test /
    // settings / marketplace) covers the whole class.
    await expect(handle.page.getByText(/no modules registered/i)).toHaveCount(0, {
      timeout: 15_000,
    });
    // At least one built-in id should appear in the table.
    const marketplaceTable = handle.page.locator("table.marketplace-table, .marketplace-view table");
    await expect(marketplaceTable).toBeVisible({ timeout: 5_000 });
    await expect(marketplaceTable).toContainText(/marketplace|settings|dev-space|lint-test/i);
  });

  test("Settings tab shows the form, not the loading or failed-to-load banners", async () => {
    handle = await launchElectron();
    await handle.page.getByRole("button", { name: /settings/i }).click();

    // After the modules:config-get invoke resolves, the form's
    // schema-driven fields render. The `settings` module declares
    // `theme` + `showExperimentalModules`; assert at least one is
    // visible. While booting the "Loading config…" placeholder is
    // acceptable; "Failed to load" is NOT — that's the regression.
    await expect(
      handle.page.getByRole("combobox", { name: /theme/i }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      handle.page.getByText(/failed to load config/i),
    ).toHaveCount(0);
  });
});
