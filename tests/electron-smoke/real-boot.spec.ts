import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Real-boot smoke — the merge gate the Phase 13.6 PR-C synthetic grid was
// missing. Every other test in the suite forces RN_DEV_DAEMON_BOOT_MODE=fake
// so the supervisor returns a stub `SessionServices` without spawning Metro.
// That proves the wire shape works but never proves a real boot reaches
// `session/status: running` through the multiplexed events/subscribe channel.
//
// Bug 1 (handoff: docs/plans/2026-04-26-handoff-phase-13-6-pr-c-and-test-gap.md)
// is the regression this guards: `npm run dev:gui` against acme-mobile-app
// times out after 30s with "connectToDaemonSession: session did not reach
// 'running' within 30000ms". Reviewer subagents (Kieran TS + Architecture +
// Security + Simplicity) didn't catch it because they read code, not behavior.
//
// Skipped unless `REAL_BOOT_SMOKE=1` — the spec spawns a real daemon, real
// Metro, and writes a profile into the developer's actual acme-mobile-app
// project. Run locally before any PR that touches the daemon boot path or the
// wire protocol; do NOT enable on CI without first arranging an isolated RN
// fixture with node_modules pre-populated.

const REAL_BOOT_ENABLED = process.env.REAL_BOOT_SMOKE === "1";

// Path is the same hardcoded fallback electron/main.ts:92 uses. The smoke
// targets it directly so nothing about the dev:gui run differs from Martin's
// observed reproducer.
//
// Override via `RN_DEV_REAL_BOOT_TARGET` so different machines can point
// at their own RN fixture without editing this file. The default is the
// historical acme-mobile-app path; if the override is unset and that
// path doesn't exist, the test surfaces a clear E_NO_REAL_BOOT_TARGET
// error in `beforeEach` rather than a confusing missing-package one.
const PROJECT_ROOT =
  process.env.RN_DEV_REAL_BOOT_TARGET ??
  "/Users/martincouso/Documents/GitHub/acme-mobile-app";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SMOKE_PROFILE_NAME = "rn-dev-real-boot-smoke";

interface ElectronHandle {
  app: ElectronApplication;
  page: Page;
}

function readBranch(cwd: string): string {
  // Mirror what `getCurrentBranch` does in the host (electron/ipc/services.ts:309)
  // — `git rev-parse --abbrev-ref HEAD`. The smoke profile must match this
  // exactly, otherwise `findDefault(null, branch)` returns null and main.ts
  // falls back to the wizard, bypassing the path the regression sits on.
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function writeSmokeProfile(branch: string): string {
  const profilesDir = join(PROJECT_ROOT, ".rn-dev", "profiles");
  mkdirSync(profilesDir, { recursive: true });
  const profilePath = join(profilesDir, `${SMOKE_PROFILE_NAME}.json`);
  writeFileSync(
    profilePath,
    JSON.stringify(
      {
        name: SMOKE_PROFILE_NAME,
        // isDefault=true so startRealServices's findDefault(null, branch)
        // picks this profile up immediately. Pre-existing profiles in the
        // dir have isDefault=false so we shouldn't conflict; if a future
        // profile flips isDefault=true the test will surface that as a
        // duplicate — that's a real signal worth investigating.
        isDefault: true,
        // worktree: null — startRealServices passes null as the first arg
        // to findDefault, so the matched profile must mirror that.
        worktree: null,
        branch,
        platform: "ios",
        // quick mode skips clean + code-sign + build. The supervisor still
        // boots Metro/devtools/builder/watcher; this smoke specifically
        // exercises the `running` edge from that path through the
        // multiplexed channel — not the long-pole build pipeline.
        mode: "quick",
        // Pin the package manager so settlePackageManager (electron/ipc/services.ts:50)
        // short-circuits instead of firing the interactive `instance:prompt`.
        // The target may be a multi-lockfile project (acme-mobile-app has
        // npm + bun lockfiles; acme-mobile-app uses pnpm); without this
        // pin the smoke hangs on a "Multiple package managers detected"
        // modal that needs user input BEFORE connectElectronToDaemon ever
        // runs. Override via `RN_DEV_REAL_BOOT_PACKAGE_MANAGER` for the
        // current target.
        packageManager:
          (process.env.RN_DEV_REAL_BOOT_PACKAGE_MANAGER as
            | "npm"
            | "pnpm"
            | "yarn"
            | "bun"
            | undefined) ?? "npm",
        // 8099 deliberately differs from the default 8081 so a Metro
        // already running for normal dev:gui doesn't conflict with the
        // smoke's daemon-spawned Metro.
        metroPort: 8099,
        devices: {},
        buildVariant: "debug",
        // Empty preflight checks list: preflight gates boot otherwise, and
        // the bug under test sits downstream of preflight in the wire path.
        // Keep the smoke focused.
        preflight: { checks: [], frequency: "once" },
        onSave: [],
        env: {},
        projectRoot: PROJECT_ROOT,
      },
      null,
      2,
    ),
  );
  return profilePath;
}

function cleanupSmokeProfile(): void {
  const profilePath = join(
    PROJECT_ROOT,
    ".rn-dev",
    "profiles",
    `${SMOKE_PROFILE_NAME}.json`,
  );
  if (existsSync(profilePath)) {
    rmSync(profilePath, { force: true });
  }
}

async function launchElectronRealBoot(): Promise<ElectronHandle> {
  // Each test gets its own Electron user-data-dir so localStorage doesn't
  // bleed between runs (mirrors smoke.spec.ts:117-119).
  const userDataDir = join(PROJECT_ROOT, ".rn-dev", "smoke-electron-user-data");
  mkdirSync(userDataDir, { recursive: true });

  const app = await electron.launch({
    args: [
      join(REPO_ROOT, "electron", "launcher.cjs"),
      `--user-data-dir=${userDataDir}`,
    ],
    cwd: PROJECT_ROOT,
    stderr: "pipe",
    stdout: "pipe",
    env: {
      ...process.env,
      // CRITICAL — the difference from smoke.spec.ts. No fake boot. The
      // daemon spawns the actual bootSessionServices path: real Metro,
      // real devtools, real builder, real watcher.
      RN_DEV_PROJECT_ROOT: PROJECT_ROOT,
      RN_DEV_SMOKE: "1",
    },
    // Generous timeout — real-boot reaching the `running` edge can take
    // longer than the synthetic suite's 30s budget.
    timeout: 90_000,
  });

  app.process().stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[electron-stderr] ${chunk.toString()}`);
  });
  app.process().stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[electron-stdout] ${chunk.toString()}`);
  });

  const page = await app.firstWindow({ timeout: 30_000 });
  return { app, page };
}

async function teardownElectron(handle: ElectronHandle): Promise<void> {
  // Try to stop the daemon session via IPC before closing. session/stop is
  // kill-for-everyone, so this leaves the daemon tearing down Metro/builder/
  // watcher rather than leaving orphan subprocesses behind.
  try {
    await handle.page.evaluate(async () => {
      const w = window as unknown as {
        rndev: { invoke: (ch: string, ...args: unknown[]) => Promise<unknown> };
      };
      // Best-effort — handler may not exist or session may already be down.
      await w.rndev.invoke("session:stop").catch(() => undefined);
    });
  } catch {
    /* renderer may already be torn down */
  }
  await handle.app.close().catch(() => undefined);
}

test.describe("Electron real-boot smoke", () => {
  test.skip(
    !REAL_BOOT_ENABLED,
    "Set REAL_BOOT_SMOKE=1 to run; spawns real Metro against acme-mobile-app.",
  );

  // Real-boot is slow — bump the per-test timeout above the suite default.
  test.setTimeout(180_000);

  let handle: ElectronHandle | null = null;
  let smokeProfilePath: string | null = null;

  test.beforeEach(() => {
    if (!existsSync(PROJECT_ROOT)) {
      throw new Error(
        `Real-boot smoke requires the acme-mobile-app project at ${PROJECT_ROOT}. ` +
          `Either clone it there or override the smoke target.`,
      );
    }
    const branch = readBranch(PROJECT_ROOT);
    smokeProfilePath = writeSmokeProfile(branch);
  });

  test.afterEach(async () => {
    if (handle) {
      await teardownElectron(handle);
      handle = null;
    }
    if (smokeProfilePath) {
      cleanupSmokeProfile();
      smokeProfilePath = null;
    }
  });

  test("daemon session reaches 'running' through the multiplexed channel within 90s", async () => {
    handle = await launchElectronRealBoot();
    const errors: string[] = [];
    handle.page.on("pageerror", (err) => {
      errors.push(err.message);
    });
    handle.page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    // The hard regression guard. If session.ts:268's setTimeout fires, the
    // renderer surfaces this string verbatim through ipc/services.ts's
    // failure path (or as a thrown error in `instances:create`). Either way
    // its presence in the DOM is the precise signature of Bug 1.
    const regressionLocator = handle.page.getByText(
      /did not reach "running" within \d+ms/i,
    );

    // Settings tab fires `modules:config-get` against the live daemon's
    // modules-IPC dispatcher; its theme combobox renders only after the
    // dispatcher publishes a successful client (i.e. `setModulesClient`
    // landed, i.e. `connectToDaemonSession` resolved, i.e. running edge
    // arrived). It's the simplest renderer assertion that load-bears on
    // the wire path.
    await handle.page.getByRole("button", { name: /settings/i }).click();
    await expect(
      handle.page.getByRole("combobox", { name: /theme/i }),
      "Settings theme combobox should render once the daemon session reaches running",
    ).toBeVisible({ timeout: 90_000 });

    // Bug 1's exact symptom — fail loud if it ever surfaces, even if the
    // form somehow renders alongside it (e.g. transient race we want to
    // know about).
    await expect(
      regressionLocator,
      "Phase 13.6 PR-C regression: connectToDaemonSession timed out — session/status:running did not propagate through the multiplexed channel",
    ).toHaveCount(0);

    // Bug 2 net — the stale `E_CONFIG_SERVICES_PENDING` abort reason from a
    // pre-attach launch should be cleared by the successful setModulesClient.
    await expect(
      handle.page.getByText(/no default profile is configured/i),
      "Settings should not surface the pre-attach abort reason once the session is running",
    ).toHaveCount(0);

    expect(errors, `renderer console errors:\n${errors.join("\n")}`).toEqual([]);

    // The Settings tab firing `modules:config-get` against the live daemon
    // (which the theme combobox above gates on) ALREADY proves bidirectional
    // RPC works through the multiplexed channel — modules:config-get is one
    // of the gate-default-on RPCs. A separate metro:status assertion would
    // be redundant AND outside the renderer's preload allowlist.
  });

  test("DevTools panel renders against the daemon's DevToolsClient (not in-process)", async () => {
    // Bug 5 surface — `electron/ipc/devtools.ts` was still constructing an
    // in-process `DevToolsManager` against `inst.metro` (which is null after
    // Phase 13.4.1) instead of consuming the daemon-published DevToolsClient
    // adapter on `serviceBus.devtools`. With Bug 5 fixed: opening the DevTools
    // tab succeeds in resolving `devtools-network:proxy-port` (it round-trips
    // through `client.status()`) and the panel resolves out of `connecting`
    // into either `no-target` (no RN app attached — expected during the
    // smoke) or `connected` (an emulator happens to be live).
    //
    // The exact regression: before the fix, `proxy-port` returned null
    // because `inst.metro` was null, and the renderer surfaced
    // "Cannot start DevTools proxy for Metro on port 8099" — that string in
    // the DOM is the precise Bug-5 fingerprint.
    handle = await launchElectronRealBoot();
    const errors: string[] = [];
    handle.page.on("pageerror", (err) => {
      errors.push(err.message);
    });
    handle.page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await handle.page.getByRole("button", { name: /settings/i }).click();
    await expect(
      handle.page.getByRole("combobox", { name: /theme/i }),
      "wait for the daemon session to reach running before exercising DevTools",
    ).toBeVisible({ timeout: 90_000 });

    await handle.page.getByRole("button", { name: /^devtools$/i }).click();

    // Resolve out of the `connecting` placeholder. Either of the two
    // success states (`no-target` placeholder when no RN app is attached,
    // or the rendered toolbar+webview when one happens to be live) proves
    // proxy-port + status both round-tripped through the adapter.
    const noTargetPlaceholder = handle.page.getByText(
      /waiting for app to connect/i,
    );
    const connectedToolbar = handle.page.getByText(/react native devtools/i);
    await expect(
      noTargetPlaceholder.or(connectedToolbar),
      "DevTools panel should resolve to no-target or connected once the adapter answers proxy-port",
    ).toBeVisible({ timeout: 30_000 });

    // Bug 5's exact fingerprint — the in-process error path returned null
    // for `proxy-port` because `inst.metro` was null, and the renderer
    // rendered this string verbatim.
    await expect(
      handle.page.getByText(/cannot start devtools proxy for metro/i),
      "Bug 5 regression: DevTools handler fell back to the in-process null check",
    ).toHaveCount(0);

    // Exercise the restart RPC explicitly — clicking "Retry target
    // discovery" routes through `devtools-network:restart` →
    // `DevToolsClient.restart()` → daemon's `devtools/restart` action.
    // The first iteration of Bug 5 verification missed this surface
    // because the smoke only proved initial connect; the running daemon
    // didn't know the new RPC (forgotten DAEMON_VERSION bump) and the
    // renderer surfaced "Cannot restart DevTools proxy for Metro on
    // port N". This assertion is now the load-bearing check that the
    // restart wire-path actually round-trips against a live daemon.
    if (await noTargetPlaceholder.isVisible()) {
      await handle.page.getByRole("button", { name: /retry target discovery/i }).click();
      // Resolution: same two terminal states as initial connect — failure
      // is the "Cannot restart" string the renderer rendered when the RPC
      // returned null.
      await expect(
        noTargetPlaceholder.or(connectedToolbar),
        "DevTools panel should resolve out of restart-connecting back to no-target or connected",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        handle.page.getByText(/cannot restart devtools proxy/i),
        "Bug 5 follow-up regression: devtools/restart RPC missing on running daemon — bump DAEMON_VERSION",
      ).toHaveCount(0);
    }

    expect(errors, `renderer console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("closing a tab in ultra-clean mode also stops Metro (user-reported regression)", async () => {
    // User-reported (2026-05-06, second pass): "killing the tab still
    // does nothing in the ultra clean profile". The first kill-tab fix
    // was tested only against quick mode — ultra-clean has different
    // boot timing (full clean takes minutes; Metro spawn happens AFTER
    // clean completes), and may surface a different failure mode.
    //
    // To run this test in a reasonable wall-clock window we override
    // the smoke profile's mode to ultra-clean with a NO-OP clean
    // (preflight already empty; nothing in node_modules to actually
    // clean since we're targeting a fixture). The daemon's CleanManager
    // skips steps that find nothing — so against the smoke fixture this
    // is fast.
    const branch = readBranch(PROJECT_ROOT);
    const profilesDir = join(PROJECT_ROOT, ".rn-dev", "profiles");
    const profilePath = join(profilesDir, `${SMOKE_PROFILE_NAME}.json`);
    writeFileSync(
      profilePath,
      JSON.stringify(
        {
          name: SMOKE_PROFILE_NAME,
          isDefault: true,
          worktree: null,
          branch,
          platform: "ios",
          mode: "ultra-clean",
          packageManager:
            (process.env.RN_DEV_REAL_BOOT_PACKAGE_MANAGER as
              | "npm"
              | "pnpm"
              | "yarn"
              | "bun"
              | undefined) ?? "npm",
          metroPort: 8099,
          devices: {},
          buildVariant: "debug",
          preflight: { checks: [], frequency: "once" },
          onSave: [],
          env: {},
          projectRoot: PROJECT_ROOT,
        },
        null,
        2,
      ),
    );

    // Same flip-existing-defaults dance.
    const flippedProfiles: Array<{ path: string; original: string }> = [];
    try {
      const entries = readdirSync(profilesDir).filter(
        (f) => f.endsWith(".json") && !f.startsWith(SMOKE_PROFILE_NAME),
      );
      for (const file of entries) {
        const fp = join(profilesDir, file);
        const original = readFileSync(fp, "utf8");
        try {
          const parsed = JSON.parse(original) as { isDefault?: boolean };
          if (parsed.isDefault === true) {
            parsed.isDefault = false;
            writeFileSync(fp, JSON.stringify(parsed, null, 2));
            flippedProfiles.push({ path: fp, original });
          }
        } catch {}
      }
    } catch {}

    const ultraCleanRestoreFlipped = () => {
      for (const { path, original } of flippedProfiles) {
        try {
          writeFileSync(path, original);
        } catch {}
      }
    };

    handle = await launchElectronRealBoot();
    const errors: string[] = [];
    handle.page.on("pageerror", (err) => errors.push(err.message));
    handle.page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    // The user's actual scenario: ultra-clean's clean step takes
    // minutes, so the user clicks close DURING the boot, while the
    // session is still in "starting". Don't wait for "running" — that
    // never happens for big projects in test-time. Just wait for the
    // instance tab to surface (created on session attach) then drive
    // the close click.
    const tab = handle.page.locator(".instance-tab").first();
    await expect(
      tab,
      "Instance tab should appear after the daemon attaches the ultra-clean session",
    ).toBeVisible({ timeout: 60_000 });

    await tab.locator(".instance-tab-close").click();
    const modal = handle.page.locator(".prompt-modal");
    await expect(
      modal,
      "Close-confirmation modal should surface even during ultra-clean's clean phase",
    ).toBeVisible({ timeout: 5_000 });
    await modal.getByRole("button", { name: /close tab/i }).click();

    // The tab MUST disappear from the renderer immediately. Pre-fix
    // (synchronous session/stop), this would block while the daemon
    // awaited the in-flight boot — for ultra-clean that's 5-10 min.
    // Now the IPC handler fires session/stop and immediately deletes
    // local state, so the renderer drops the tab within milliseconds.
    await expect(
      tab,
      "Tab must be removed from the strip even while the daemon is still in clean phase. " +
        "If this hangs, the IPC handler is awaiting session/stop synchronously.",
    ).not.toBeVisible({ timeout: 5_000 });

    expect(errors, `renderer console errors:\n${errors.join("\n")}`).toEqual([]);
    ultraCleanRestoreFlipped();
  });

  test("closing a tab actually kills the daemon's Metro process (not just bookkeeping)", async () => {
    // Flip pre-existing isDefault profiles so the daemon picks our
    // smoke profile (port 8099) instead of the user's real default
    // (which lives at e.g. port 8081). Without this the precondition
    // below fails because the daemon attached to the wrong profile
    // and Metro is bound to a port we don't know to check.
    const profilesDir = join(PROJECT_ROOT, ".rn-dev", "profiles");
    const flippedProfiles: Array<{ path: string; original: string }> = [];
    try {
      const entries = readdirSync(profilesDir).filter(
        (f) => f.endsWith(".json") && !f.startsWith(SMOKE_PROFILE_NAME),
      );
      for (const file of entries) {
        const fp = join(profilesDir, file);
        const original = readFileSync(fp, "utf8");
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
      // No profiles dir contents — fine.
    }
    // Restore on test exit so subsequent runs / dev-mode don't see a
    // mutated environment.
    test.info().annotations.push({ type: "smoke-cleanup", description: "restore flipped profiles" });
    const restoreFlipped = () => {
      for (const { path, original } of flippedProfiles) {
        try {
          writeFileSync(path, original);
        } catch {
          // best-effort
        }
      }
    };

    // User-reported (2026-05-06): "I tried killing a tab, all it does is
    // change an icon to red." Pre-fix the close path only deleted the
    // tab from Electron's instance Map; Metro kept running in the
    // background. The fake-boot smoke missed this because there's no
    // real Metro process to leak.
    //
    // This test boots a REAL daemon → real Metro on port 8099 → clicks
    // the close button (×, then ✓) → asserts no process is bound to
    // port 8099 within 10s. lsof -i is the trustworthy oracle: if the
    // daemon's session/stop tore down Metro, the port is free; if not,
    // Metro is still listening and the assertion fails.
    handle = await launchElectronRealBoot();
    const errors: string[] = [];
    handle.page.on("pageerror", (err) => errors.push(err.message));
    handle.page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    // Wait until the session is running (same gate as Bug 1's test).
    await handle.page.getByRole("button", { name: /settings/i }).click();
    await expect(
      handle.page.getByRole("combobox", { name: /theme/i }),
      "Wait for the daemon session to reach running before exercising kill-tab",
    ).toBeVisible({ timeout: 90_000 });

    // Sanity: Metro is actually bound to its port. Pre-condition for
    // the assertion below — if Metro never came up, the kill-tab test
    // would pass for the wrong reason. lsof -P -i :PORT lists processes
    // bound to that port; macOS lsof gotcha (`-a` to AND filters) is
    // not in play here because we use a single -i predicate.
    function isPortBound(port: number): boolean {
      try {
        const out = execFileSync("lsof", ["-P", "-i", `:${port}`, "-t"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return out.length > 0;
      } catch {
        // lsof exits non-zero when nothing matches — that's the "port
        // free" branch and we want false here.
        return false;
      }
    }
    function pidOnPort(port: number): string | null {
      try {
        const out = execFileSync("lsof", ["-P", "-i", `:${port}`, "-t"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return out.length > 0 ? out : null;
      } catch {
        return null;
      }
    }
    // Metro spawn is async — bootSessionServices kicks the spawn but
    // Metro takes 10-30s to actually bind the port. Poll for up to
    // 60s so we don't false-positive on a still-warming-up Metro.
    const bindStart = Date.now();
    const bindDeadline = bindStart + 60_000;
    let bound = false;
    while (Date.now() < bindDeadline) {
      if (isPortBound(8099)) {
        bound = true;
        break;
      }
      await handle.page.waitForTimeout(1_000);
    }
    const bindElapsed = Date.now() - bindStart;
    const metroPidPreClose = pidOnPort(8099);
    test.info().attach("metro-pre-close", {
      body: `Metro bound after ${bindElapsed}ms; PIDs on :8099 = ${metroPidPreClose ?? "(none)"}`,
      contentType: "text/plain",
    });
    expect(
      bound,
      "Pre-condition: Metro must be bound to port 8099 within 60s of the session reaching running. " +
        "If this fails, the daemon's bootSessionServices did not spawn Metro, OR it spawned but failed silently. " +
        "Run `lsof -P -i :8099` outside the test to see what's there.",
    ).toBe(true);
    expect(
      metroPidPreClose,
      "Should have at least one Metro PID bound to port 8099 before close.",
    ).not.toBeNull();

    // Click the tab's close button → confirmation modal → Confirm.
    const tab = handle.page.locator(".instance-tab").first();
    await expect(tab).toBeVisible({ timeout: 10_000 });
    await tab.locator(".instance-tab-close").click();
    const modal = handle.page.locator(".prompt-modal");
    await expect(
      modal,
      "Close-confirmation modal should surface after clicking ×",
    ).toBeVisible({ timeout: 2_000 });
    await modal.getByRole("button", { name: /close tab/i }).click();

    // The tab should disappear from the renderer.
    await expect(tab, "Tab should be removed from the strip").not.toBeVisible({ timeout: 5_000 });

    // The actual user-facing contract: poll for Metro's port to free
    // up. Daemon's session/stop tears down the supervisor (which calls
    // metroManager.stop), then SIGKILLs Metro's process group. 10s of
    // grace is generous; pre-fix this would never come true.
    const portFreeDeadline = Date.now() + 10_000;
    let portFree = false;
    while (Date.now() < portFreeDeadline) {
      if (!isPortBound(8099)) {
        portFree = true;
        break;
      }
      await handle.page.waitForTimeout(500);
    }
    const metroPidPostClose = pidOnPort(8099);
    test.info().attach("metro-post-close", {
      body: `Post-close PIDs on :8099 = ${metroPidPostClose ?? "(none)"}; port free: ${portFree}`,
      contentType: "text/plain",
    });
    expect(
      portFree,
      `Closing the tab should stop Metro and free its port within 10s. ` +
        `Pre-close PIDs: ${metroPidPreClose}. Post-close PIDs: ${metroPidPostClose}. ` +
        `If port stayed bound, the daemon's session/stop did not tear down Metro.`,
    ).toBe(true);

    expect(errors, `renderer console errors:\n${errors.join("\n")}`).toEqual([]);

    restoreFlipped();
  });
});
