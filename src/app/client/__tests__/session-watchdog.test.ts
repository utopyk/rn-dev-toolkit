import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IpcServer } from "../../../core/ipc.js";
import type { IpcMessageEvent } from "../../../core/ipc.js";
import { connectToDaemonSession } from "../session.js";
import type { Profile } from "../../../core/types.js";

// Idle-watchdog tests for the boot-progress timeout strategy.
//
// Reported bug: a `clean`-mode 2nd-tab attach against acme surfaced
// `Failed to attach daemon session: connectToDaemonSession: session
// did not reach "running" within 30000ms`. The 30s wall-clock timeout
// was too short for legitimate clean boots (`pnpm install` + `pod
// install` + watchman wipe routinely run 1-3 min). But raising the
// fixed timeout to 10min would just push the kill point — slow
// machines or heavy builds would still hit it.
//
// The fix is structural: replace the wall-clock timeout with an idle
// watchdog. Every incoming session event resets the watchdog. Only
// genuine silence (no events at all for the idle window) trips the
// failure. These tests pin that behaviour:
//
//   1. Slow boot that emits one event every interval < idle-window
//      → succeeds, no false timeout, even after a wall-clock duration
//      that would have killed the legacy timeout.
//   2. Boot that goes silent before reaching `running` → fails at the
//      idle window, with a message that says "stalled / went silent",
//      not "did not reach running".
//   3. Initial silence (no events at all post-subscribe) → fails at
//      `sessionReadyTimeoutMs` (now reframed as the seed-silence
//      budget), so a wedged daemon still fast-fails instead of
//      hanging forever.

const FAKE_WORKTREE_KEY = "stub-watchdog-worktree";

function makeProfile(projectRoot: string): Profile {
  return {
    name: "test",
    isDefault: true,
    worktree: null,
    branch: "main",
    platform: "ios",
    mode: "clean",
    metroPort: 8099,
    devices: {},
    buildVariant: "debug",
    preflight: { checks: [], frequency: "once" },
    onSave: [],
    env: {},
    projectRoot,
  };
}

interface ServerHandle {
  server: IpcServer;
  sockDir: string;
  prevSock: string | undefined;
  cleanup: () => Promise<void>;
}

async function startServer(handler: (evt: IpcMessageEvent) => void): Promise<ServerHandle> {
  const sockDir = mkdtempSync(join(tmpdir(), "rn-dev-watchdog-test-"));
  const sockPath = join(sockDir, "sock");
  const server = new IpcServer(sockPath);
  server.on("message", handler);
  await server.start();
  const prevSock = process.env.RN_DEV_DAEMON_SOCK;
  process.env.RN_DEV_DAEMON_SOCK = sockPath;
  return {
    server,
    sockDir,
    prevSock,
    async cleanup() {
      if (prevSock === undefined) delete process.env.RN_DEV_DAEMON_SOCK;
      else process.env.RN_DEV_DAEMON_SOCK = prevSock;
      await server.stop();
      try {
        rmSync(sockDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

describe("connectToDaemonSession — idle-watchdog timeout strategy", () => {
  let handle: ServerHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.cleanup();
      handle = null;
    }
  });

  it("succeeds when the daemon emits progress events at intervals shorter than the idle window (slow boot, no false kill)", async () => {
    handle = await startServer((evt) => {
      const { message, reply } = evt;
      if (message.action === "events/subscribe") {
        // Subscribe ack — session is starting.
        reply({
          type: "response",
          action: "events/subscribe",
          id: message.id,
          payload: { subscribed: true, status: "starting", started: true, attached: 1 },
        });
        // Emit lifecycle/log progress events at 80ms intervals while
        // the boot conceptually does its long work. Idle window in
        // this test is 200ms — so 80ms cadence keeps the watchdog
        // happy. After 5 progress events (~400ms — well past the
        // legacy 100ms wall-clock budget would have killed it), emit
        // session/status: running.
        let i = 0;
        const tick = (): void => {
          if (i < 5) {
            reply({
              type: "event",
              action: "events/subscribe",
              id: message.id,
              payload: {
                kind: "lifecycle/log",
                worktreeKey: FAKE_WORKTREE_KEY,
                data: { message: `progress step ${i + 1}` },
              },
            });
            i++;
            setTimeout(tick, 80);
          } else {
            reply({
              type: "event",
              action: "events/subscribe",
              id: message.id,
              payload: {
                kind: "session/status",
                worktreeKey: FAKE_WORKTREE_KEY,
                data: { status: "running" },
              },
            });
          }
        };
        setTimeout(tick, 80);
        return;
      }
      if (message.action === "session/status") {
        reply({
          type: "response",
          action: "session/status",
          id: message.id,
          payload: { status: "running", worktreeKey: FAKE_WORKTREE_KEY },
        });
      }
    });

    const t0 = Date.now();
    const session = await connectToDaemonSession("/fake/root", makeProfile("/fake/root"), {
      // Absurdly tight legacy timeout — pre-fix this would have killed
      // the boot at 100ms. The watchdog renames it to "initial
      // silence budget", so the 80ms first-event arrival saves us
      // and the idle window takes over.
      sessionReadyTimeoutMs: 100,
      sessionReadyIdleTimeoutMs: 200,
    });
    const elapsed = Date.now() - t0;
    session.disconnect();

    // The boot took ~400ms+ wall-clock; a fixed 100ms timeout would
    // have killed it. The watchdog let it through because progress
    // events arrived faster than the 200ms idle window.
    expect(elapsed).toBeGreaterThanOrEqual(350);
  }, 10_000);

  it("fails with a 'stalled / went silent' message (NOT 'did not reach running') when the daemon goes silent before running", async () => {
    handle = await startServer((evt) => {
      const { message, reply } = evt;
      if (message.action === "events/subscribe") {
        reply({
          type: "response",
          action: "events/subscribe",
          id: message.id,
          payload: { subscribed: true, status: "starting", started: true, attached: 1 },
        });
        // Emit a couple of progress events, then go silent forever
        // — simulates a daemon that gets partway through boot then
        // wedges (e.g. a hung pod-install, a hung Watchman, etc.)
        setTimeout(() => {
          reply({
            type: "event",
            action: "events/subscribe",
            id: message.id,
            payload: {
              kind: "lifecycle/log",
              worktreeKey: FAKE_WORKTREE_KEY,
              data: { message: "preflight ok" },
            },
          });
        }, 30);
        setTimeout(() => {
          reply({
            type: "event",
            action: "events/subscribe",
            id: message.id,
            payload: {
              kind: "lifecycle/log",
              worktreeKey: FAKE_WORKTREE_KEY,
              data: { message: "watchman wipe started" },
            },
          });
        }, 80);
        // No further events — the watchdog should fire at idle window.
      }
    });

    const t0 = Date.now();
    let caught: Error | null = null;
    try {
      await connectToDaemonSession("/fake/root", makeProfile("/fake/root"), {
        sessionReadyTimeoutMs: 1_000,
        sessionReadyIdleTimeoutMs: 250,
      });
    } catch (e) {
      caught = e as Error;
    }
    const elapsed = Date.now() - t0;
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/stalled|went silent/i);
    expect(caught!.message).not.toMatch(/did not reach "running"/);
    // Should have fired around 80ms + 250ms ≈ 330ms, well before the
    // 1s seed budget.
    expect(elapsed).toBeLessThan(900);
    expect(elapsed).toBeGreaterThanOrEqual(250);
  }, 10_000);

  it("fast-fails on a daemon that emits no events at all (initial-silence seed budget)", async () => {
    handle = await startServer((evt) => {
      const { message, reply } = evt;
      if (message.action === "events/subscribe") {
        reply({
          type: "response",
          action: "events/subscribe",
          id: message.id,
          payload: { subscribed: true, status: "starting", started: true, attached: 1 },
        });
        // Never emit anything else — daemon is wedged from the start.
      }
    });

    const t0 = Date.now();
    let caught: Error | null = null;
    try {
      await connectToDaemonSession("/fake/root", makeProfile("/fake/root"), {
        sessionReadyTimeoutMs: 200, // seed budget
        sessionReadyIdleTimeoutMs: 5_000, // idle window — much larger; should NOT be the trigger
      });
    } catch (e) {
      caught = e as Error;
    }
    const elapsed = Date.now() - t0;
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/no events|wedged|appears/i);
    expect(elapsed).toBeLessThan(800);
    expect(elapsed).toBeGreaterThanOrEqual(150);
  }, 10_000);
});
