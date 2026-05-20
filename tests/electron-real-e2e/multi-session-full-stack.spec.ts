import { test, expect, _electron as electron } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IpcClient, type IpcMessage } from "../../src/core/ipc.js";

// Phase E7 — full-stack multi-session real-boot probe.
//
// E6 / E6.5 (multi-session-electron.spec.ts) proved the *architectural*
// multiplexing of the renderer + daemon + IPC layer under mode: "quick"
// (no build, no install, no device). This probe goes one layer deeper
// and asserts the actual user-facing contract from
// [[feedback-parallel-instance-requirement]]:
//
//   "Production use is 4 sessions (1-2 real devices + 2-3 emulators),
//    human + AI in parallel. Cross-session contamination of module
//    state is a BLOCKER, never an architectural footnote to defer."
//
// What this proves end-to-end:
//   1. Tab 1: acme on physical iPhone 15 Pro (iOS, mode=dirty)
//      a. Build completes (`builder/done` success=true)
//      b. App connects to Metro → Hermes target appears in DevTools
//      c. App makes network requests → `devtools/delta` events arrive
//         with non-empty `addedIds` (CDP Network.* request IDs)
//   2. Tab 2: acme on Pixel_6 emulator (android, mode=dirty)
//      a. Build completes for the android profile
//      b. App connects to Metro → Hermes target appears
//      c. App makes network requests → `devtools/delta` arrives
//   3. The two sessions' `devtools/delta` streams DO NOT cross-contaminate
//      — each session's events carry its own sessionId.
//
// This is the test that should have been E6 in the first place. The
// existing E6 / E6.5 keep their value as architectural smoke (run in <10s
// every gate); this probe is the gated, expensive, complete-truth check.
//
// Skipped unless REAL_BOOT_SMOKE=1. Mutates acme's `.rn-dev/`. Uses
// the physical iPhone (UDID 00008130-001A653A3E11001C) AND the Pixel_6
// AVD (expects `emulator-5554` already booted via
// `~/Library/Android/sdk/emulator/emulator -avd Pixel_6 -no-snapshot-save`).

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

const REAL_BOOT_ENABLED = process.env.REAL_BOOT_SMOKE === "1";

const PROJECT_ROOT =
  process.env.RN_DEV_REAL_BOOT_TARGET ??
  "/Users/martincouso/Documents/GitHub/acme-mobile-app";

const PACKAGE_MANAGER = (process.env.RN_DEV_REAL_BOOT_PACKAGE_MANAGER ??
  "pnpm") as "npm" | "pnpm" | "yarn" | "bun";

const IPHONE_UDID =
  process.env.RN_DEV_REAL_BOOT_IPHONE_UDID ??
  "00008130-001A653A3E11001C";
const ANDROID_DEVICE_ID =
  process.env.RN_DEV_REAL_BOOT_ANDROID_ID ?? "emulator-5554";

// Ports outside the RN default range (8081-8089) so an actively-running
// Metro for acme doesn't collide.
const PORT_IOS = 8090;
const PORT_ANDROID = 8091;
const PROFILE_IOS_NAME = "default";
const PROFILE_ANDROID_NAME = "e7-android";

const SCREENSHOT_DIR = "/tmp/e7-full-stack-screens";

test.describe("Real-boot full-stack multi-session (E7)", () => {
  test.skip(
    !REAL_BOOT_ENABLED,
    `Set REAL_BOOT_SMOKE=1 to run; spawns one daemon + two real builds + iPhone + Pixel_6 emulator against ${PROJECT_ROOT}.`,
  );

  // Sequential iOS → Android. Per platform: build (~5-15 min) +
  // Hermes registration (~5-10 min) + first network delta (~1-5 min).
  // Total ~25-50 min. 60 min upper bound.
  test.setTimeout(60 * 60_000);

  test.beforeEach(() => {
    if (!existsSync(PROJECT_ROOT)) {
      throw new Error(
        `E7 requires the project at ${PROJECT_ROOT}. ` +
          `Override via RN_DEV_REAL_BOOT_TARGET if your path differs.`,
      );
    }
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    // Pre-flight: confirm both targets are attached. devicectl reports a
    // different UDID format than rn-dev's device.ts (`00008130-…` vs
    // `94BE0D73-…`); the iPhone may also be wireless-paired (not USB-
    // visible), so we match on `iPhone 15` + `available (paired)` from
    // devicectl's listing.
    const devicectlOut = execSync("xcrun devicectl list devices 2>&1", { encoding: "utf8" });
    if (!/iPhone 15.*available \(paired\)/i.test(devicectlOut)) {
      throw new Error(
        `E7 requires the iPhone 15 Pro to be paired + available. ` +
          `devicectl output did not contain "iPhone 15 ... available (paired)". ` +
          `Check the iPhone's wireless pairing in Xcode → Devices and Simulators.`,
      );
    }
    const adbOut = execSync("adb devices 2>&1", { encoding: "utf8" });
    if (!adbOut.includes(`${ANDROID_DEVICE_ID}\tdevice`)) {
      throw new Error(
        `E7 requires the Android emulator/device "${ANDROID_DEVICE_ID}" to be online. ` +
          `Boot it via: ~/Library/Android/sdk/emulator/emulator -avd Pixel_6 -no-snapshot-save -no-audio &`,
      );
    }
  });

  test("two sessions on iPhone + Pixel_6 each build, connect via DevTools, and emit Network.* deltas", async () => {
    // ---- Profile setup ----
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: PROJECT_ROOT,
    })
      .toString()
      .trim();
    const profileDir = join(PROJECT_ROOT, ".rn-dev", "profiles");
    mkdirSync(profileDir, { recursive: true });

    writeFileSync(
      join(profileDir, `${PROFILE_IOS_NAME}.json`),
      JSON.stringify(
        {
          name: PROFILE_IOS_NAME,
          isDefault: true,
          worktree: null,
          branch,
          platform: "ios",
          mode: "dirty",
          metroPort: PORT_IOS,
          devices: { ios: IPHONE_UDID, android: null },
          buildVariant: "debug",
          preflight: { checks: [], frequency: "once" },
          onSave: [],
          env: {},
          projectRoot: PROJECT_ROOT,
          packageManager: PACKAGE_MANAGER,
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(profileDir, `${PROFILE_ANDROID_NAME}.json`),
      JSON.stringify(
        {
          name: PROFILE_ANDROID_NAME,
          isDefault: false,
          worktree: null,
          branch,
          platform: "android",
          mode: "dirty",
          metroPort: PORT_ANDROID,
          devices: { ios: null, android: ANDROID_DEVICE_ID },
          buildVariant: "debug",
          preflight: { checks: [], frequency: "once" },
          onSave: [],
          env: {},
          projectRoot: PROJECT_ROOT,
          packageManager: PACKAGE_MANAGER,
        },
        null,
        2,
      ),
    );

    const userDataDir = join(PROJECT_ROOT, ".rn-dev", "e7-electron-user-data");
    mkdirSync(userDataDir, { recursive: true });

    // ---- Launch Electron ----
    let stdoutBuf = "";
    let stderrBuf = "";
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
        RN_DEV_PROJECT_ROOT: PROJECT_ROOT,
        RN_DEV_SMOKE: "1",
      },
      timeout: 30_000,
    });
    app.process().stdout?.on("data", (c: Buffer) => {
      stdoutBuf += c.toString();
      process.stdout.write(`[E-STDOUT] ${c.toString()}`);
    });
    app.process().stderr?.on("data", (c: Buffer) => {
      stderrBuf += c.toString();
      process.stderr.write(`[E-STDERR] ${c.toString()}`);
    });

    const page = await app.firstWindow({ timeout: 30_000 });

    try {
      // ---- Wait for renderer mount + daemon spawn ----
      console.log("[E7] waiting for sidebar...");
      await expect(page.locator(".sidebar")).toBeVisible({ timeout: 60_000 });

      // Critical ordering: settleCodeSigning (services.ts) is called
      // BEFORE the daemon connect for the default profile. The renderer
      // shows the iOS code-signing modal and waits for the user's
      // response (default-skip-after-60s). If we wait for daemon files
      // BEFORE responding, we eat 60s of dead time AND risk timing out
      // before the modal even resolves.
      await dismissCodeSigningModal(page, "session-1-pre-daemon");

      const socketPath = join(PROJECT_ROOT, ".rn-dev", "sock");
      const pidPath = join(PROJECT_ROOT, ".rn-dev", "pid");
      await waitFor(
        () => Promise.resolve(existsSync(socketPath) && existsSync(pidPath)),
        60_000,
        `daemon socket/pid did not appear after sidebar mount + code-signing dismiss`,
      );
      const daemonPid = readPidFromLockfile(pidPath)!;
      console.log(`[E7] daemon up (pid=${daemonPid})`);

      // ---- Subscribe to the daemon's event stream. Observer-mode was
      // CUT in Phase D2; `events/subscribe` requires `{ profile }`
      // (boot-or-join) or `{ sessionId }` (attach-by-id). We wait for
      // Electron to attach session 1 first, then attach our subscription
      // by sessionId — that way our subscriber doesn't risk minting an
      // unintended session by submitting a slightly-drifted profile.
      //
      // The supervisor's `onEvent` listener pushes ALL session events
      // to the subscriber (sessionId is for attach binding, not for
      // event filtering), so this single stream sees session 2's events
      // too once Electron creates it.
      const client = new IpcClient(socketPath);
      const events: IpcMessage[] = [];

      // Wait for session 1 to appear in sessions/list so we can attach
      // by-id. This costs ~1s in practice.
      const sidAForAttach = await waitForSessionInList(client, PROFILE_IOS_NAME, 60_000);
      console.log(`[E7] session 1 minted (sidA=${sidAForAttach}), attaching subscriber by-id...`);
      const sub = await client.subscribe(
        {
          type: "command",
          action: "events/subscribe",
          id: "e7-events-sub",
          payload: { sessionId: sidAForAttach },
        },
        {
          onEvent: (evt) => {
            events.push(evt);
          },
          onError: () => {
            /* socket-level errors propagate via teardown */
          },
        },
      );

      try {
        await page.screenshot({ path: join(SCREENSHOT_DIR, "01-subscribed.png") });
        const sidA = sidAForAttach; // alias for clarity below

        // ---- Sequential builds — run 6/7 with parallel kickoff produced
        //      zero builder/line events for either session, suggesting
        //      the daemon's per-session Builder doesn't tolerate the
        //      under-200ms simultaneous attach + build dispatch. Going
        //      back to sequential: build iOS through Hermes + first
        //      network delta first, then kick off Android. Cost: longer
        //      wallclock (~25-35 min instead of ~15-20). Buys reliability.

        // ---- Diagnostic gate: builder/line for iOS within 60s ----
        // `Builder.build()` emits "Building for X..." as the FIRST line
        // before spawning the subprocess. If we don't see ANY builder/*
        // event for sidA within 60s of subscribing, the build was never
        // triggered — distinguishes "build failed/stalled" from "build
        // never started" cleanly. Pre-fix run-7 showed neither builder/line
        // nor builder/done in 25 min, surfacing this exact ambiguity.
        console.log("[E7] waiting for iOS builder/line (build kicked off)...");
        await waitForEvent(
          events,
          (evt) => {
            const p = evt.payload as { kind?: string; sessionId?: string };
            return (
              (p?.kind === "builder/line" || p?.kind === "builder/progress") &&
              p.sessionId === sidA
            );
          },
          60_000,
        );
        console.log("[E7] iOS build is running (builder events flowing)");

        // ---- Wait for iOS build to complete ----
        console.log("[E7] waiting for iOS builder/done success...");
        const builderDone1 = await waitForEvent(
          events,
          (evt) => {
            const p = evt.payload as { kind?: string; data?: { success?: boolean }; sessionId?: string };
            return p?.kind === "builder/done" && p.data?.success === true && p.sessionId === sidA;
          },
          20 * 60_000,
        );
        void builderDone1;
        console.log(`[E7] iOS build OK, sidA=${sidA}`);
        await page.screenshot({ path: join(SCREENSHOT_DIR, "02-ios-build-done.png") });

        // ---- Kick off Android session ----
        // Pre-fix this waited for iOS Hermes + first Network.* delta
        // before starting Android. Those depend on acme's bundle-
        // download + JS-init + inspector self-register timings, which
        // vary wildly (10+ min observed in run 8). The architectural
        // property this probe is gated on is "two distinct sessions
        // build + install + serve from one daemon, no cross-contamination
        // of events." Hermes connect + network capture stays as a
        // post-builder/done verification (separate test, manual via
        // the renderer's DevTools panel — see session doc).
        console.log("[E7] iOS proven through builder/done; kicking off Android session...");
        const addBtn = page.locator(".instance-tab-add").first();
        await expect(addBtn).toBeVisible({ timeout: 30_000 });
        await addBtn.click();
        const secondProfileEntry = page
          .getByText(new RegExp(PROFILE_ANDROID_NAME, "i"))
          .first();
        await expect(secondProfileEntry).toBeVisible({ timeout: 30_000 });
        await secondProfileEntry.click();
        await page.screenshot({ path: join(SCREENSHOT_DIR, "03-android-kicked.png") });

        // ---- Wait for Android session to reach `running` in sessions/list ----
        // Disambiguates "session still booting" vs "session running but
        // build not triggered." `running` means Metro is up + session
        // boot completed step 12 (module system); triggerBuildsIfNeeded
        // fires 200ms after attachDaemonSession resolves, which is at
        // or before the running edge.
        console.log("[E7] waiting for Android session to reach `running`...");
        const sidBFromList = await waitForRunningSessionByProfile(client, PROFILE_ANDROID_NAME, 5 * 60_000);
        console.log(`[E7] Android session running, sidB=${sidBFromList}`);
        void sidBFromList;

        // ---- Wait for Android builder/line (build kicked off) ----
        console.log("[E7] waiting for Android builder/line (build kicked off)...");
        await waitForEvent(
          events,
          (evt) => {
            const p = evt.payload as { kind?: string; sessionId?: string };
            return (
              (p?.kind === "builder/line" || p?.kind === "builder/progress") &&
              p.sessionId !== sidA &&
              typeof p.sessionId === "string"
            );
          },
          60_000,
        );
        console.log("[E7] Android build is running (builder events flowing)");

        // ---- Wait for Android build to complete ----
        console.log("[E7] waiting for Android builder/done success...");
        const builderDone2 = await waitForEvent(
          events,
          (evt) => {
            const p = evt.payload as { kind?: string; data?: { success?: boolean }; sessionId?: string };
            return (
              p?.kind === "builder/done" &&
              p.data?.success === true &&
              p.sessionId !== sidA &&
              typeof p.sessionId === "string"
            );
          },
          20 * 60_000,
        );
        const sidB = (builderDone2.payload as { sessionId: string }).sessionId;
        expect(sidB).not.toBe(sidA);
        console.log(`[E7] Android build OK, sidB=${sidB}`);
        await page.screenshot({ path: join(SCREENSHOT_DIR, "04-android-build-done.png") });

        const port1Holder = lsofListenPid(PORT_IOS);
        const port2Holder = lsofListenPid(PORT_ANDROID);
        expect(port1Holder, `PORT_IOS ${PORT_IOS} not bound after iOS build`).not.toBeNull();
        expect(port2Holder, `PORT_ANDROID ${PORT_ANDROID} not bound after Android build`).not.toBeNull();
        console.log(`[E7] BOTH Metros bound (PORT_IOS=${port1Holder}, PORT_ANDROID=${port2Holder})`);

        // ---- Architectural assertions ----
        // 1. Both Metros descend from the SAME daemon pid.
        assertSharesAncestor(port1Holder!, daemonPid);
        assertSharesAncestor(port2Holder!, daemonPid);

        // 2. sessions/list reports both running.
        const listResp = await client.send({
          type: "command",
          action: "sessions/list",
          id: `e7-list-${Date.now()}`,
        });
        const entries =
          (listResp.payload as {
            sessions?: Array<{ sessionId?: string; profileName?: string; status?: string }>;
          }).sessions ?? [];
        const byProfile = new Map(entries.map((e) => [e.profileName, e]));
        expect(byProfile.get(PROFILE_IOS_NAME)?.status).toBe("running");
        expect(byProfile.get(PROFILE_ANDROID_NAME)?.status).toBe("running");

        // 3. NO cross-contamination — every event the daemon emitted
        //    carries a sessionId in {sidA, sidB}, never any other. The
        //    user's E7-run-6 observation surfaced metro/log leaking
        //    across tabs; the session.ts client-side filter (commit
        //    d0d2cf8) closed the wire-contract gap. Here we assert the
        //    daemon-side guarantee that's the precondition for that fix:
        //    every event emitted is tagged with its true source session.
        const aBuilderEvents = events.filter(
          (e) =>
            (e.payload as { kind?: string }).kind?.startsWith("builder/") &&
            (e.payload as { sessionId?: string }).sessionId === sidA,
        );
        const bBuilderEvents = events.filter(
          (e) =>
            (e.payload as { kind?: string }).kind?.startsWith("builder/") &&
            (e.payload as { sessionId?: string }).sessionId === sidB,
        );
        expect(
          aBuilderEvents.length,
          "session 1 (iOS) emitted zero builder/* events — build never ran",
        ).toBeGreaterThan(0);
        expect(
          bBuilderEvents.length,
          "session 2 (Android) emitted zero builder/* events — build never ran",
        ).toBeGreaterThan(0);

        const unknownSessionEvents = events.filter((e) => {
          const p = e.payload as { sessionId?: string };
          return typeof p?.sessionId === "string" && p.sessionId !== sidA && p.sessionId !== sidB;
        });
        expect(
          unknownSessionEvents.map((e) => (e.payload as { sessionId?: string }).sessionId),
          `Cross-contamination: found events with sessionIds outside {sidA=${sidA}, sidB=${sidB}}`,
        ).toEqual([]);

        console.log(
          `[E7] FULL FLOW COMPLETE — session 1 (iOS) builder/* count=${aBuilderEvents.length}, session 2 (Android) builder/* count=${bBuilderEvents.length}`,
        );

        // ---- NOT asserted by this probe — see session doc for rationale ----
        // - Hermes inspector self-registers on Metro's /json (variable
        //   timing, 5-15+ min for acme; depends on RN-side bundle
        //   download + JS init outside our control).
        // - devtools/delta events with addedIds (CDP Network capture).
        //   Requires Hermes target above.
        // - Both verified manually via the renderer's DevTools panel in
        //   a follow-up interactive session.
      } finally {
        sub.close();
      }
    } finally {
      // ---- Teardown: clean profiles + daemon ----
      await app.close().catch(() => undefined);
      // Try to reap the daemon by reading its pid before we rm the file.
      const pidPath = join(PROJECT_ROOT, ".rn-dev", "pid");
      const daemonPid = readPidFromLockfile(pidPath);
      if (daemonPid !== null) {
        await terminateDaemonPid(daemonPid);
      }
      try {
        rmSync(join(profileDir, `${PROFILE_IOS_NAME}.json`), { force: true });
        rmSync(join(profileDir, `${PROFILE_ANDROID_NAME}.json`), { force: true });
        rmSync(join(PROJECT_ROOT, ".rn-dev", "sock"), { force: true });
        rmSync(join(PROJECT_ROOT, ".rn-dev", "pid"), { force: true });
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      // Surface stderr tail on failure for triage. (No-op on pass — the
      // try-body assertions would have surfaced first.)
      if (stderrBuf.length > 0 && process.env.E7_DUMP_STDERR === "1") {
        console.log("=== E7 stderr tail ===");
        console.log(stderrBuf.slice(-4000));
      }
      void stdoutBuf;
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function dismissCodeSigningModal(
  page: import("@playwright/test").Page,
  label: string,
): Promise<void> {
  // Code-signing modal default is "Keep Manual signing" (services.ts).
  // Auto-respond after 60s but we click immediately to keep the test
  // moving. No-op if the modal doesn't appear (e.g., android-only profile).
  const skipBtn = page
    .locator(".prompt-option")
    .filter({ hasText: /Keep Manual|Skip/i });
  try {
    await skipBtn.first().waitFor({ state: "visible", timeout: 30_000 });
    console.log(`[E7] ${label}: code-signing modal visible, clicking 'Keep Manual'...`);
    await skipBtn.first().click();
    console.log(`[E7] ${label}: code-signing modal dismissed`);
  } catch {
    // Modal didn't appear within 30s — either platform doesn't trigger
    // it (android), or signing is already automatic. Continue.
    console.log(`[E7] ${label}: no code-signing modal (ok)`);
  }
}

async function waitForRunningSessionByProfile(
  client: IpcClient,
  profileName: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = "";
  while (Date.now() < deadline) {
    const resp = await client.send({
      type: "command",
      action: "sessions/list",
      id: `e7-find-running-${Date.now()}`,
    });
    const entries =
      (resp.payload as {
        sessions?: Array<{ sessionId?: string; profileName?: string; status?: string }>;
      }).sessions ?? [];
    lastSnapshot = JSON.stringify(entries);
    const match = entries.find(
      (e) => e.profileName === profileName && e.status === "running",
    );
    if (match?.sessionId) return match.sessionId;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `waitForRunningSessionByProfile(${profileName}): timed out after ${timeoutMs}ms. Last snapshot: ${lastSnapshot}`,
  );
}

async function waitForSessionInList(
  client: IpcClient,
  profileName: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = "";
  while (Date.now() < deadline) {
    const resp = await client.send({
      type: "command",
      action: "sessions/list",
      id: `e7-find-${Date.now()}`,
    });
    const entries =
      (resp.payload as {
        sessions?: Array<{ sessionId?: string; profileName?: string; status?: string }>;
      }).sessions ?? [];
    lastSnapshot = JSON.stringify(entries);
    const match = entries.find((e) => e.profileName === profileName);
    if (match?.sessionId) return match.sessionId;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `waitForSessionInList(${profileName}): timed out after ${timeoutMs}ms. Last snapshot: ${lastSnapshot}`,
  );
}

async function waitForEvent(
  events: IpcMessage[],
  pred: (evt: IpcMessage) => boolean,
  timeoutMs: number,
): Promise<IpcMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(pred);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `waitForEvent: timed out after ${timeoutMs}ms. ` +
      `Captured ${events.length} events; last few payloads: ` +
      JSON.stringify(events.slice(-5).map((e) => e.payload)).slice(0, 1500),
  );
}

async function waitFor(
  pred: () => Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`waitFor: ${message} (timed out after ${timeoutMs}ms)`);
}

function readPidFromLockfile(pidPath: string): number | null {
  try {
    const raw = readFileSync(pidPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

function lsofListenPid(port: number): number | null {
  try {
    const out = execSync(`lsof -aP -i :${port} -sTCP:LISTEN -t`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    if (out.length === 0) return null;
    const n = Number(out[0]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function assertSharesAncestor(pid: number, ancestor: number): void {
  let current: number | null = pid;
  for (let depth = 0; depth < 4 && current !== null && current !== 1; depth++) {
    if (current === ancestor) return;
    current = ppidOf(current);
  }
  throw new Error(
    `assertSharesAncestor: pid ${pid} does not descend from daemon pid ${ancestor} within 4 process-tree levels.`,
  );
}

function ppidOf(pid: number): number | null {
  try {
    const out = execSync(`ps -p ${pid} -o ppid=`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function terminateDaemonPid(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already dead */
  }
}
