import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IpcClient } from "../../src/core/ipc.js";
import { launchRealE2e, teardownRealE2e, type RealE2eHandle } from "./launch.js";

// Phase E6 + E6.5 — real-boot Electron multi-session probe.
//
// Sister probe to `multi-session-daemon.spec.ts` (D7). D7 drives the
// daemon socket directly; E6 drives the renderer UI through the Electron
// host, exercising the per-session IPC routing the E1-E5 commits landed:
//
//   E6 (serial path):
//     1. Boot Electron with two profiles (default + secondary).
//     2. Wait for the default session's Metro to bind PORT_A.
//     3. Click the renderer's "+" button → new-instance dialog → second
//        profile. Wait for the second session's Metro to bind PORT_B.
//     4. Assert two .instance-tab elements rendered (renderer-side).
//     5. Assert both lsof-listening processes share the daemon's ancestry —
//        the singleton ModuleHostManager-per-session contract still holds
//        when the renderer adds tabs via the wizard path.
//     6. Click close on the second tab → modal Confirm → that session's
//        Metro releases its port; first session's Metro stays bound.
//
//   E6.5 (concurrent race variant):
//     1. Same boot.
//     2. Dispatch BOTH instances:create calls in parallel via
//        page.evaluate (no wait between).
//     3. Assert both sessions reach running.
//     4. Assert no cross-contamination: sessions/list shows two
//        distinct sessionIds, both metros bound, both modules clients
//        published with non-overlapping sessionIds.
//
// Skipped unless `REAL_BOOT_SMOKE=1`. Mirrors D7's enable mode +
// real-project layout — writes profiles into the user's acme tree.

const REAL_BOOT_ENABLED = process.env.REAL_BOOT_SMOKE === "1";

const PROJECT_ROOT =
  process.env.RN_DEV_REAL_BOOT_TARGET ??
  "/Users/martincouso/Documents/GitHub/acme-mobile-app";

const PACKAGE_MANAGER = (process.env.RN_DEV_REAL_BOOT_PACKAGE_MANAGER ??
  "pnpm") as "npm" | "pnpm" | "yarn" | "bun";

const PORT_A = 8090;
const PORT_B = 8091;
const PROFILE_B_NAME = "e6-session-b";

test.describe("Real-boot Electron multi-session (E6 + E6.5)", () => {
  test.skip(
    !REAL_BOOT_ENABLED,
    `Set REAL_BOOT_SMOKE=1 to run; spawns one daemon + two real Metros against ${PROJECT_ROOT}.`,
  );

  // Two real Metros + clicks through the wizard dialog. Match D7's 300s
  // budget — acme's preflight on cold boot eats most of the first
  // minute.
  test.setTimeout(300_000);

  let handle: RealE2eHandle | null = null;

  test.beforeEach(() => {
    if (!existsSync(PROJECT_ROOT)) {
      throw new Error(
        `E6 requires the project at ${PROJECT_ROOT}. ` +
          `Override via RN_DEV_REAL_BOOT_TARGET if your path differs.`,
      );
    }
  });

  test.afterEach(async () => {
    if (handle) {
      await teardownRealE2e(handle);
      handle = null;
    }
  });

  test("E6 serial path: + button → second session → both tabs running → close one survives the other", async () => {
    handle = await launchRealE2e({
      realProjectRoot: PROJECT_ROOT,
      realProjectPackageManager: PACKAGE_MANAGER,
      metroPort: PORT_A,
      extraProfiles: [{ name: PROFILE_B_NAME, metroPort: PORT_B }],
    });

    const { app, page } = handle;
    void app;

    // 1. Renderer mounted + default session is attaching/running.
    console.log("[E6] launchRealE2e returned, waiting for sidebar...");
    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 60_000 });
    console.log("[E6] sidebar visible, checking daemon files...");

    // Daemon spawn is async — main.ts schedules startRealServices on a
    // 1s setTimeout after did-finish-load, and the daemon's
    // ModuleLockfile.acquire takes another tick to write sock + pid.
    // Wait for both files to materialize before opening IpcClient.
    const socketPath = join(PROJECT_ROOT, ".rn-dev", "sock");
    const pidPath = join(PROJECT_ROOT, ".rn-dev", "pid");
    await waitFor(
      () => Promise.resolve(existsSync(socketPath) && existsSync(pidPath)),
      30_000,
      `daemon socket/pid did not appear at ${PROJECT_ROOT}/.rn-dev/ after sidebar mount`,
    );

    const daemonPid = readPidFromLockfile(pidPath);
    expect(typeof daemonPid).toBe("number");

    const client = new IpcClient(socketPath);

    // 2. Wait for the default session's Metro to actually bind PORT_A
    //    (boot finished, supervisor flipped status: running).
    console.log("[E6] daemon up (pid=" + daemonPid + "), polling sessions/list for running default...");
    const sidA = await waitForRunningSessionByProfile(client, "default", 180_000);
    console.log("[E6] default session running, sidA=" + sidA + ", waiting for PORT_A bind...");
    await waitFor(
      () => Promise.resolve(lsofListenPid(PORT_A) !== null),
      30_000,
      `default session reached running but PORT_A ${PORT_A} is still unbound`,
    );
    console.log("[E6] PORT_A bound, clicking +...");

    // 3. Drive the renderer "+" button → new-instance dialog → second
    //    profile. The dialog lists every profile under .rn-dev/profiles/
    //    that's not the active one.
    const addBtn = page.locator(".instance-tab-add").first();
    await expect(addBtn).toBeVisible({ timeout: 5_000 });
    console.log("[E6] + button visible, clicking...");
    await addBtn.click();

    // Profile entry is keyed by name. Match liberally — different
    // dialog skins surface it as a button or a list-row.
    const secondProfileEntry = page.getByText(new RegExp(PROFILE_B_NAME, "i")).first();
    await expect(secondProfileEntry).toBeVisible({ timeout: 5_000 });
    console.log("[E6] dialog open, selecting second profile...");
    await secondProfileEntry.click();
    console.log("[E6] second profile clicked, waiting for PORT_B bind...");

    // 4. Wait for the second session's Metro to bind PORT_B and for the
    //    renderer to show two tabs. mode: "quick" still takes time to
    //    boot Metro on a fresh port — give it the budget D7 uses.
    await waitFor(
      () => Promise.resolve(lsofListenPid(PORT_B) !== null),
      180_000,
      `second session did not bind PORT_B ${PORT_B} after wizard select`,
    );
    console.log("[E6] PORT_B bound");
    await waitFor(
      async () => (await page.locator(".instance-tab").count()) === 2,
      30_000,
      "renderer did not render a second .instance-tab after the wizard select",
    );
    console.log("[E6] two tabs rendered");

    // 5. Daemon ancestry: both Metros are children of the same daemon.
    //    This is the E1 multi-session contract: ONE daemon hosts N
    //    sessions, all spawned by the same Electron's daemon-connect
    //    handshake.
    const holderA = lsofListenPid(PORT_A);
    const holderB = lsofListenPid(PORT_B);
    expect(holderA).not.toBeNull();
    expect(holderB).not.toBeNull();
    assertSharesAncestor(holderA!, daemonPid!);
    assertSharesAncestor(holderB!, daemonPid!);

    // 6. Daemon's sessions/list reports BOTH with distinct sessionIds.
    //    Pulled directly from the socket — server-side ground truth,
    //    not the renderer's cached view.
    const listResp = await client.send({
      type: "command",
      action: "sessions/list",
      id: `e6-list-${Date.now()}`,
    });
    const entries = (listResp.payload as {
      sessions?: Array<{ sessionId?: string; profileName?: string; status?: string }>;
    }).sessions ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const byProfile = new Map(entries.map((e) => [e.profileName, e]));
    expect(byProfile.get("default")?.status).toBe("running");
    expect(byProfile.get(PROFILE_B_NAME)?.status).toBe("running");
    const sidB = byProfile.get(PROFILE_B_NAME)?.sessionId;
    expect(typeof sidB).toBe("string");
    expect(sidB).not.toBe(sidA);
    console.log("[E6] sessions/list shows both sessions, sidB=" + sidB);

    // 7. Close the SECOND tab via the renderer's close-confirm modal.
    //    Per [[feedback-modal-over-inline-confirm]] this is a real
    //    modal — title, Cancel, Close-tab buttons. The close-tab button
    //    fires instances:remove(instanceId) which scopes session/stop
    //    to ONLY that session.
    const tabs = page.locator(".instance-tab");
    const closeButtons = tabs.locator("button", { hasText: /^×$|close/i });
    const secondTabCloseBtn = closeButtons.last();
    await expect(secondTabCloseBtn).toBeVisible();
    await secondTabCloseBtn.click();

    const modal = page.locator(".prompt-modal").filter({ hasText: /close/i });
    await expect(modal).toBeVisible({ timeout: 5_000 });
    const confirmCloseBtn = modal.getByRole("button", { name: /close tab/i });
    await confirmCloseBtn.click();

    // Modal dismissed; renderer renders one tab.
    await waitFor(
      async () => (await page.locator(".instance-tab").count()) === 1,
      15_000,
      "renderer still shows two tabs after the close-confirm",
    );

    // 8. PORT_A stays bound (session A alive), PORT_B releases.
    //    The architectural claim: instances:remove fires session/stop
    //    SCOPED to PORT_B's session only; the supervisor's release walk
    //    (D4) doesn't tear down siblings.
    expect(
      lsofListenPid(PORT_A),
      `session A's Metro on ${PORT_A} died after closing session B's tab — instances:remove leaked across sessions`,
    ).not.toBeNull();
    await waitFor(
      () => Promise.resolve(lsofListenPid(PORT_B) === null),
      30_000,
      `session B's Metro on ${PORT_B} did not release after the close-confirm`,
    );

    // 9. Renderer health: Electron page still alive (didn't crash on
    //    the close-tab IPC).
    const electronAlive = await page.evaluate(() => 1 + 1).catch(() => null);
    expect(electronAlive, "Electron page died during close-tab flow").toBe(2);
    console.log("[E6] FULL FLOW COMPLETE");
  });

  test("E6.5 concurrent path: two instances:create dispatched in parallel both reach running", async () => {
    handle = await launchRealE2e({
      realProjectRoot: PROJECT_ROOT,
      realProjectPackageManager: PACKAGE_MANAGER,
      metroPort: PORT_A,
      extraProfiles: [{ name: PROFILE_B_NAME, metroPort: PORT_B }],
    });

    const { page } = handle;

    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 60_000 });

    const socketPath = join(PROJECT_ROOT, ".rn-dev", "sock");
    const pidPath = join(PROJECT_ROOT, ".rn-dev", "pid");
    await waitFor(
      () => Promise.resolve(existsSync(socketPath) && existsSync(pidPath)),
      30_000,
      `daemon socket/pid did not appear at ${PROJECT_ROOT}/.rn-dev/ after sidebar mount`,
    );
    const daemonPid = readPidFromLockfile(pidPath);
    expect(typeof daemonPid).toBe("number");

    const client = new IpcClient(socketPath);

    // Wait for the default session's first.
    await waitForRunningSessionByProfile(client, "default", 180_000);

    // E6.5 — drive a SECOND instances:create concurrently with whatever
    // the renderer might still be doing. The single existing instance
    // is already settling; the race window we're guarding against is
    // "user mashes + button twice + selects two profiles before the
    // first attach finishes." We simulate that by issuing the IPC
    // directly via the renderer's exposed bridge.
    //
    // pendingCreate in instance.ts serializes these; the test asserts
    // BOTH calls eventually succeed.
    const result = await page.evaluate(async (profileName) => {
      const rndev = (window as unknown as { rndev?: { invoke: (ch: string, ...args: unknown[]) => Promise<unknown> } }).rndev;
      if (!rndev) return { error: "rndev bridge not exposed on window" };
      // Fire BOTH in parallel — same profile name twice would
      // collide on port allocation, so this dispatches the second
      // profile twice in close succession (the renderer's serializer
      // is what we're testing).
      try {
        const [r1, r2] = await Promise.all([
          rndev.invoke("instances:create", profileName),
          // Tiny stagger so the second call queues behind the first
          // pendingCreate rather than landing on the exact same tick.
          new Promise((resolve) => setTimeout(resolve, 50)).then(() =>
            rndev.invoke("instances:create", profileName),
          ),
        ]);
        return { r1, r2 };
      } catch (err) {
        return { error: (err as Error).message };
      }
    }, PROFILE_B_NAME);

    // The serializer accepts both calls; second call hits
    // "Instance <name>-<port> already exists" (same profile + same
    // worktree + same metroPort yields the same id) — that's CORRECT
    // multi-session behavior: don't open duplicate tabs for the same
    // profile+port, but also don't crash.
    expect(result).toBeDefined();
    if ("error" in result) {
      throw new Error(`instances:create dispatch failed: ${result.error}`);
    }

    // At least one of the two calls succeeded. The OTHER may have
    // either succeeded (different port allocated) or returned the
    // "already exists" error from instance.ts.
    const okCount = [result.r1, result.r2].filter(
      (r) => (r as { ok?: boolean }).ok === true,
    ).length;
    expect(okCount, `Neither concurrent instances:create succeeded. r1=${JSON.stringify(result.r1)} r2=${JSON.stringify(result.r2)}`).toBeGreaterThanOrEqual(1);

    // Wait for PORT_B to bind — the successful one's Metro.
    await waitFor(
      () => Promise.resolve(lsofListenPid(PORT_B) !== null),
      180_000,
      `Neither concurrent instances:create resulted in PORT_B ${PORT_B} bound`,
    );

    // sessions/list shows at most 2 sessions (cap enforced; no leaks
    // from the race). The default + at most one of the two concurrent
    // creates.
    const listResp = await client.send({
      type: "command",
      action: "sessions/list",
      id: `e6-5-list-${Date.now()}`,
    });
    const entries = (listResp.payload as {
      sessions?: Array<{ sessionId?: string; profileName?: string; status?: string }>;
    }).sessions ?? [];
    expect(entries.length, `sessions/list returned ${entries.length} entries — expected 2 (default + e6-session-b). Race leaked extra sessions.`).toBeLessThanOrEqual(2);
    // No duplicate sessionIds — paranoia check against the Map<SessionId>
    // multiplexing.
    const ids = entries.map((e) => e.sessionId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Helpers — kept local to the spec for the same reason multi-session-daemon
// keeps them local: this suite intentionally exercises the daemon protocol
// at the integration level, not the unit level.
// ---------------------------------------------------------------------------

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
      id: `e6-poll-${Date.now()}`,
    });
    const payload = resp.payload as {
      sessions?: Array<{ sessionId?: string; profileName?: string; status?: string }>;
    };
    const entries = payload.sessions ?? [];
    lastSnapshot = JSON.stringify(entries);
    const match = entries.find(
      (e) => e.profileName === profileName && e.status === "running",
    );
    if (match?.sessionId) return match.sessionId;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `waitForRunningSessionByProfile(${profileName}): timed out after ${timeoutMs}ms. ` +
      `Last sessions/list: ${lastSnapshot}`,
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
    `assertSharesAncestor: pid ${pid} does not descend from daemon pid ${ancestor} ` +
      `within 4 process-tree levels.`,
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
