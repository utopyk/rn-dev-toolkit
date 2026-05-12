import { afterEach, describe, expect, it } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";
import type { IpcMessage } from "../../core/ipc.js";

// Phase D2 — wire-protocol coverage of `SessionEvent.sessionId` (DR-5).
// Every variant of the fanned-out event envelope carries both
// `worktreeKey` (legacy service-keying dimension) and `sessionId` (D1
// identity dimension). The supervisor's `wireServiceEvents` stamps
// `sessionId` per session at boot time; the dispatcher's
// `events/subscribe` fan-out forwards the envelope verbatim. The
// client-side `parseSessionEventEnvelope` requires both fields and
// drops malformed envelopes.
//
// These tests pin the wire shape: a regression that drops sessionId
// from any variant fails loudly here before the renderer's
// per-session routing has a chance to silently drop events.

describe("daemon session-event envelope sessionId (D2)", () => {
  const cleanups: Array<() => void> = [];
  const liveHandles: TestDaemonHandle[] = [];

  afterEach(async () => {
    for (const h of liveHandles.splice(0)) await h.stop();
    for (const c of cleanups.splice(0)) c();
  });

  function makeProfile(worktree: string, name = "test", metroPort = 8081) {
    return {
      name,
      isDefault: true,
      worktree: null as string | null,
      branch: "main",
      platform: "ios",
      mode: "quick",
      metroPort,
      devices: {},
      buildVariant: "debug",
      preflight: { checks: [], frequency: "once" },
      onSave: [],
      env: {},
      projectRoot: worktree,
    };
  }

  it("every fanned event from a single session carries the matching sessionId", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const profile = makeProfile(worktree);
    const events: IpcMessage[] = [];
    const sub = await daemon.client.subscribe(
      { type: "command", action: "events/subscribe", id: "sub-1", payload: { profile } },
      { onEvent: (evt) => events.push(evt) },
    );
    try {
      const sid = (sub.initial.payload as { sessionId?: string }).sessionId;
      expect(typeof sid).toBe("string");

      // Wait for at least one metro/status event to flow — fake boot
      // emits "starting" + "running" within ~50ms.
      await waitForEvent(events, (evt) => {
        const p = evt.payload as { kind?: string };
        return p?.kind === "metro/status";
      }, 3_000);

      // Every fanned event must carry a sessionId, and every one must
      // match the subscribe-ack sid (we booted a single session here).
      expect(events.length).toBeGreaterThan(0);
      for (const evt of events) {
        const p = evt.payload as { kind?: string; sessionId?: string; worktreeKey?: string };
        expect(typeof p.sessionId).toBe("string");
        expect(p.sessionId).toBe(sid);
        expect(typeof p.worktreeKey).toBe("string");
      }
    } finally {
      sub.close();
    }
  });

  it("events from concurrent sessions are sessionId-tagged so the client can route on sessionId", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    // Two distinct subscribers, two distinct profiles → two distinct
    // sessions. The wire contract D2 pins: every fanned event carries
    // a non-empty sessionId equal to one of the two session ids.
    // Subscriber-side routing is the client's job (the supervisor
    // fan-out is intentionally global so a single renderer with N tabs
    // can keep one subscribe socket and demux on sessionId).
    const eventsA: IpcMessage[] = [];
    const eventsB: IpcMessage[] = [];
    const subA = await daemon.client.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "sub-A",
        payload: { profile: makeProfile(worktree, "alpha", 8081) },
      },
      { onEvent: (evt) => eventsA.push(evt) },
    );
    try {
      const sidA = (subA.initial.payload as { sessionId?: string }).sessionId;
      const subB = await daemon.client.subscribe(
        {
          type: "command",
          action: "events/subscribe",
          id: "sub-B",
          payload: { profile: makeProfile(worktree, "beta", 8082) },
        },
        { onEvent: (evt) => eventsB.push(evt) },
      );
      try {
        const sidB = (subB.initial.payload as { sessionId?: string }).sessionId;
        expect(sidA).not.toBe(sidB);

        // Wait until both sessions' metro events have flowed (proves
        // both bootAsync paths reached wireServiceEvents).
        await waitForEvent(eventsA, (evt) => {
          const p = evt.payload as { kind?: string; sessionId?: string };
          return p?.kind === "metro/status" && p.sessionId === sidB;
        }, 3_000);
        await waitForEvent(eventsB, (evt) => {
          const p = evt.payload as { kind?: string; sessionId?: string };
          return p?.kind === "metro/status" && p.sessionId === sidA;
        }, 3_000);

        // Every event captured by either subscriber must carry a
        // sessionId in `{sidA, sidB}`. This is the load-bearing wire
        // contract — D2's client-side `parseSessionEventEnvelope`
        // refuses envelopes without one.
        const allEvents = [...eventsA, ...eventsB];
        expect(allEvents.length).toBeGreaterThan(0);
        for (const evt of allEvents) {
          const p = evt.payload as { sessionId?: string };
          expect(typeof p.sessionId).toBe("string");
          expect([sidA, sidB]).toContain(p.sessionId);
        }
      } finally {
        subB.close();
      }
    } finally {
      subA.close();
    }
  });
});

async function waitForEvent(
  events: IpcMessage[],
  pred: (evt: IpcMessage) => boolean,
  timeoutMs: number,
): Promise<IpcMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(pred);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `waitForEvent: timed out after ${timeoutMs}ms. Events seen: ${JSON.stringify(
      events.map((e) => e.payload),
    )}`,
  );
}
