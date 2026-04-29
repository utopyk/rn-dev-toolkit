import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Real-boot smoke — the merge gate the Phase 13.6 PR-C synthetic grid was
// missing. Every other test in the suite forces RN_DEV_DAEMON_BOOT_MODE=fake
// so the supervisor returns a stub `SessionServices` without spawning Metro.
// That proves the wire shape works but never proves a real boot reaches
// `session/status: running` through the multiplexed events/subscribe channel.
//
// Bug 1 (handoff: docs/plans/2026-04-26-handoff-phase-13-6-pr-c-and-test-gap.md)
// is the regression this guards: `npm run dev:gui` against movie-nights-club
// times out after 30s with "connectToDaemonSession: session did not reach
// 'running' within 30000ms". Reviewer subagents (Kieran TS + Architecture +
// Security + Simplicity) didn't catch it because they read code, not behavior.
//
// Skipped unless `REAL_BOOT_SMOKE=1` — the spec spawns a real daemon, real
// Metro, and writes a profile into the developer's actual movie-nights-club
// project. Run locally before any PR that touches the daemon boot path or the
// wire protocol; do NOT enable on CI without first arranging an isolated RN
// fixture with node_modules pre-populated.

const REAL_BOOT_ENABLED = process.env.REAL_BOOT_SMOKE === "1";

// Path is the same hardcoded fallback electron/main.ts:92 uses. The smoke
// targets it directly so nothing about the dev:gui run differs from Martin's
// observed reproducer.
const PROJECT_ROOT = "/Users/martincouso/Documents/Projects/movie-nights-club";

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
        // movie-nights-club has multiple lockfiles; without this pin the smoke
        // hangs on a "Multiple package managers detected" modal that needs
        // user input, BEFORE connectElectronToDaemon ever runs.
        packageManager: "npm",
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
    "Set REAL_BOOT_SMOKE=1 to run; spawns real Metro against movie-nights-club.",
  );

  // Real-boot is slow — bump the per-test timeout above the suite default.
  test.setTimeout(180_000);

  let handle: ElectronHandle | null = null;
  let smokeProfilePath: string | null = null;

  test.beforeEach(() => {
    if (!existsSync(PROJECT_ROOT)) {
      throw new Error(
        `Real-boot smoke requires the movie-nights-club project at ${PROJECT_ROOT}. ` +
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
});
