import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IpcClient, type IpcMessage } from "../../src/core/ipc.js";
import { launchRealE2e, teardownRealE2e, type RealE2eHandle } from "./launch.js";

// Phase D7 — real-boot daemon multi-session probe (merge gate for the
// multi-session arc).
//
// What this proves end-to-end:
//   1. One daemon process hosts two concurrent sessions for the same
//      worktree (acme-mobile-app). lsof on each session's Metro port
//      resolves to the SAME daemon pid — the supervisor's
//      `Map<SessionId, SessionEntry>` (D1) actually multiplexes real
//      services, not just fake-boot stubs.
//   2. Each session's SessionEvent envelopes carry a distinct sessionId
//      — D2's wire contract holds under real Metro.
//   3. `session/stop` against one session leaves the other alive — the
//      supervisor's `stopEntry` release walk (D4) doesn't tear down
//      siblings.
//   4. No daemon process leaks after harness teardown — closes the
//      parked item from memory/middle_phase_complete.md (the smoke
//      suite leaks daemons; D7 asserts the real-e2e exit path doesn't).
//
// Skipped unless `REAL_BOOT_SMOKE=1`. Like every other real-boot probe
// in this directory, the spec writes profiles into the user's
// acme-mobile-app tree and spawns real Metro on real ports.
//
// PARKED for a follow-up commit (not gated here): exercising D4's
// release walk under a real third-party module subprocess. No bundled
// built-in currently exercises the per-worktree refcount path
// (memory/code_fact_module_host_per_session.md), so the integration
// already lives at the vitest layer
// (`src/daemon/__tests__/supervisor-module-cleanup-real-subprocess.test.ts`).
// Promoting it to real-boot needs a curated 3p module on disk; tracked
// separately rather than inflating this test.

const REAL_BOOT_ENABLED = process.env.REAL_BOOT_SMOKE === "1";

const PROJECT_ROOT =
  process.env.RN_DEV_REAL_BOOT_TARGET ??
  "/Users/martincouso/Documents/GitHub/acme-mobile-app";

const PACKAGE_MANAGER = (process.env.RN_DEV_REAL_BOOT_PACKAGE_MANAGER ??
  "pnpm") as "npm" | "pnpm" | "yarn" | "bun";

// Ports chosen well outside the React Native default (8081-8089) so a
// developer's actively-running Metro for acme doesn't collide.
const PORT_A = 8090;
const PORT_B = 8091;
const PROFILE_B_NAME = "d7-session-b";

test.describe("Real-boot multi-session daemon (D7)", () => {
  test.skip(
    !REAL_BOOT_ENABLED,
    `Set REAL_BOOT_SMOKE=1 to run; spawns one daemon + two real Metro instances against ${PROJECT_ROOT}.`,
  );

  // Two real Metros + preflight + (worst case) pod install + watchman
  // sweep can together exceed the smoke budget. Match
  // acme-long-session.spec.ts's 180s and add a bit of headroom for
  // the second-session attach.
  test.setTimeout(300_000);

  let handle: RealE2eHandle | null = null;

  test.beforeEach(() => {
    if (!existsSync(PROJECT_ROOT)) {
      throw new Error(
        `D7 requires the project at ${PROJECT_ROOT}. ` +
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

  test("one daemon hosts two concurrent real-Metro sessions for the same worktree", async () => {
    handle = await launchRealE2e({
      realProjectRoot: PROJECT_ROOT,
      realProjectPackageManager: PACKAGE_MANAGER,
      metroPort: PORT_A,
      extraProfiles: [{ name: PROFILE_B_NAME, metroPort: PORT_B }],
    });

    // Renderer up → daemon spawned → session 1 (default profile, PORT_A)
    // attached. We use the sidebar as the canonical "Electron mounted +
    // boot in progress" signal; the per-session "running" assertion
    // comes from the daemon's own sessions/list below, not the UI.
    await expect(handle.page.locator(".sidebar")).toBeVisible({
      timeout: 60_000,
    });

    const socketPath = join(PROJECT_ROOT, ".rn-dev", "sock");
    const pidPath = join(PROJECT_ROOT, ".rn-dev", "pid");
    expect(existsSync(socketPath), "daemon socket should exist after Electron mount").toBe(true);
    expect(existsSync(pidPath), "daemon pid lockfile should exist after Electron mount").toBe(true);

    const daemonPid = readPidFromLockfile(pidPath);
    expect(typeof daemonPid).toBe("number");

    const client = new IpcClient(socketPath);

    // Poll sessions/list until session 1 (Electron's default profile)
    // shows status "running". Real Metro can take 10-30s on a cold
    // boot; the watchdog inside the daemon gives us up to
    // sessionReadyIdleTimeoutMs of progress, so a 120s poll budget is
    // generous.
    const sidA = await waitForRunningSessionByProfile(client, "default", 120_000);

    // Subscribe BEFORE starting session B so the "running" envelope is
    // captured live (events/subscribe gives a fresh stream — no replay
    // of past events). The supervisor's fan-out is global, so this
    // subscriber will also receive any session A events that fire
    // after subscribe.
    const eventsFromB: IpcMessage[] = [];
    const allEvents: IpcMessage[] = [];

    const profileB = buildProfile(PROFILE_B_NAME, PORT_B);
    const subB = await client.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "d7-sub-B",
        payload: { profile: profileB },
      },
      {
        onEvent: (evt) => {
          allEvents.push(evt);
          const p = evt.payload as { sessionId?: string };
          if (p?.sessionId && p.sessionId !== sidA) eventsFromB.push(evt);
        },
      },
    );

    try {
      const sidB = (subB.initial.payload as { sessionId?: string }).sessionId;
      expect(typeof sidB).toBe("string");
      expect(sidB).not.toBe(sidA);

      // Wait for session B's Metro to reach `metro/status: running`.
      await waitForEvent(
        eventsFromB,
        (evt) => {
          const p = evt.payload as {
            kind?: string;
            sessionId?: string;
            data?: { status?: string };
          };
          return (
            p?.kind === "metro/status" &&
            p.sessionId === sidB &&
            p.data?.status === "running"
          );
        },
        120_000,
      );

      // D7 claim 1 — ONE daemon hosts BOTH. Two Metro processes are
      // children of the same daemon pid recorded in `.rn-dev/pid`.
      const holderA = lsofListenPid(PORT_A);
      const holderB = lsofListenPid(PORT_B);
      expect(holderA, `Nothing listening on ${PORT_A} after session A reached running`).not.toBeNull();
      expect(holderB, `Nothing listening on ${PORT_B} after session B reached running`).not.toBeNull();
      // The Metro process is the daemon's child, not the daemon itself
      // (Metro spawns react-native start, which binds the port). What
      // matters is that both Metros trace their ancestry to the same
      // daemon pid via ppid. Walk up one or two levels — react-native
      // CLI launches metro through a sub-bun, so the parent-of-Metro
      // might be the daemon directly OR the daemon's child shell.
      assertSharesAncestor(holderA!, daemonPid!);
      assertSharesAncestor(holderB!, daemonPid!);

      // D7 claim 2 — sessions/list reports both with distinct ids +
      // profile names.
      const listResp = await client.send({
        type: "command",
        action: "sessions/list",
        id: "d7-list-1",
      });
      const listPayload = listResp.payload as {
        sessions?: Array<{ sessionId?: string; profileName?: string; status?: string }>;
      };
      const entries = listPayload.sessions ?? [];
      expect(entries.length).toBeGreaterThanOrEqual(2);
      const ids = entries.map((e) => e.sessionId).sort();
      expect(ids).toEqual([sidA, sidB].sort());
      const profilesByName = new Map(entries.map((e) => [e.profileName, e]));
      expect(profilesByName.get("default")?.status).toBe("running");
      expect(profilesByName.get(PROFILE_B_NAME)?.status).toBe("running");

      // D7 claim 3 — stop session B, session A survives. The
      // supervisor's `stopEntry` release walk (D4) runs against B
      // only; A's services remain bound.
      const stopResp = await client.send({
        type: "command",
        action: "session/stop",
        id: "d7-stop-B",
        payload: { sessionId: sidB },
      });
      // `session/stop` returns `{ ok: true }` on success.
      expect((stopResp.payload as { ok?: boolean })?.ok).toBe(true);

      // Poll until B drops out of sessions/list; A should still be
      // there + running.
      await waitFor(
        async () => {
          const resp = await client.send({
            type: "command",
            action: "sessions/list",
            id: `d7-list-after-stop-${Date.now()}`,
          });
          const p = resp.payload as { sessions?: Array<{ sessionId?: string; status?: string }> };
          const remaining = p.sessions ?? [];
          const stillHasB = remaining.some((e) => e.sessionId === sidB);
          const aStillRunning = remaining.some(
            (e) => e.sessionId === sidA && e.status === "running",
          );
          return !stillHasB && aStillRunning;
        },
        30_000,
        "session/stop did not retire session B while leaving session A running",
      );

      // PORT_A should still be bound (session A's Metro alive);
      // PORT_B should be free (session B's Metro reaped).
      expect(
        lsofListenPid(PORT_A),
        `session A's Metro on ${PORT_A} died after stopping session B — release walk leaked siblings`,
      ).not.toBeNull();
      await waitFor(
        () => Promise.resolve(lsofListenPid(PORT_B) === null),
        15_000,
        `session B's Metro on ${PORT_B} did not release the port after session/stop`,
      );

      // Renderer health — Electron page still alive (didn't crash on
      // the sibling session/stop). Cheap evaluate round-trip.
      const electronAlive = await handle.page.evaluate(() => 1 + 1).catch(() => null);
      expect(electronAlive, "Electron page died during session B teardown").toBe(2);
    } finally {
      subB.close();
    }
  });

  test("teardown leaves zero daemon processes behind", async () => {
    handle = await launchRealE2e({
      realProjectRoot: PROJECT_ROOT,
      realProjectPackageManager: PACKAGE_MANAGER,
      metroPort: PORT_A,
    });
    await expect(handle.page.locator(".sidebar")).toBeVisible({
      timeout: 60_000,
    });

    // Capture the daemon pid we expect to disappear post-teardown.
    const pidPath = join(PROJECT_ROOT, ".rn-dev", "pid");
    const daemonPid = readPidFromLockfile(pidPath);
    expect(typeof daemonPid).toBe("number");

    await teardownRealE2e(handle);
    handle = null;

    // Give the OS a brief moment to reap. SIGKILL inside teardown's
    // `terminateDaemonPid` should land near-instantly, but pid-table
    // settling is not free.
    await waitFor(
      () => Promise.resolve(!processIsAlive(daemonPid!)),
      5_000,
      `daemon pid ${daemonPid} still alive after teardownRealE2e`,
    );

    // No daemon processes pointing at this project root remain.
    const remaining = pgrepDaemonsForRoot(PROJECT_ROOT);
    expect(
      remaining,
      `Daemon process leaks after teardown: pids=${remaining.join(",")}. ` +
        `Pre-existing class of bug per memory/middle_phase_complete.md — the smoke suite ` +
        `is known to leak; D7 asserts the real-e2e harness does not.`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProfile(name: string, metroPort: number) {
  const branch = execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: PROJECT_ROOT,
  })
    .toString()
    .trim();
  return {
    name,
    isDefault: false,
    worktree: null as string | null,
    branch,
    platform: "ios" as const,
    mode: "quick" as const,
    metroPort,
    devices: {},
    buildVariant: "debug" as const,
    preflight: { checks: [] as string[], frequency: "once" as const },
    onSave: [],
    env: {},
    projectRoot: PROJECT_ROOT,
    packageManager: PACKAGE_MANAGER,
  };
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
      id: `d7-poll-${Date.now()}`,
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
      `Last sessions/list snapshot: ${lastSnapshot}`,
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
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `waitForEvent: timed out after ${timeoutMs}ms. ` +
      `Captured ${events.length} events; last few payloads: ` +
      JSON.stringify(events.slice(-3).map((e) => e.payload)),
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the pid of the process LISTENing on `port`, or null. Uses
 * `lsof -a` per memory/lsof_gotchas.md — without `-a` macOS ORs the
 * selectors and the result is meaningless.
 */
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
    // lsof exits non-zero when no match — equivalent to "nothing
    // listening." Same handling as the daemon's own port probing.
    return null;
  }
}

/**
 * Assert that `pid` traces its ancestry to `ancestor`. The real-boot
 * Metro process is a grandchild of the daemon (daemon → react-native
 * CLI → metro), so a strict `ppid == ancestor` check is too narrow.
 * Walk up to 4 levels.
 */
function assertSharesAncestor(pid: number, ancestor: number): void {
  let current: number | null = pid;
  for (let depth = 0; depth < 4 && current !== null && current !== 1; depth++) {
    if (current === ancestor) return;
    current = ppidOf(current);
  }
  throw new Error(
    `assertSharesAncestor: pid ${pid} does not descend from daemon pid ${ancestor} ` +
      `within 4 process-tree levels. Two Metros bound to the daemon's ports ` +
      `should both be its children.`,
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

/**
 * Return every daemon process whose argv references `projectRoot`. The
 * daemon's argv is `bun src/index.tsx daemon <projectRoot>` (or the
 * compiled equivalent), so a project-root substring match is precise
 * enough to avoid false positives from unrelated `daemon` strings.
 */
function pgrepDaemonsForRoot(projectRoot: string): number[] {
  try {
    const out = execSync(
      `pgrep -af "src/index.tsx daemon" || true`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!out) return [];
    return out
      .split("\n")
      .filter((line) => line.includes(projectRoot))
      .map((line) => Number(line.split(/\s+/)[0]))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}
