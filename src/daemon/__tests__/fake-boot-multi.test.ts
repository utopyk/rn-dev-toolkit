import { afterEach, describe, expect, it } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";
import type { IpcMessage } from "../../core/ipc.js";

// Phase D6 — fake-boot harness multi-session.
//
// D6's deliverable per the multi-session plan
// (docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md
// § D6): "two fake-boots concurrently, both reach `metro/status: running`
// with correct sessionId tagging on events."
//
// The bordering tests cover adjacent ground:
//   - `sessions-list.test.ts` proves two concurrent boots appear in
//     `sessions/list` (the supervisor's Map<SessionId, …> Iives).
//   - `session-events-envelope.test.ts` proves every fanned event from
//     a concurrent pair of sessions carries a sessionId in {sidA, sidB}.
//
// What neither pins is the **`status: "running"` payload** under
// concurrency — they wait on `kind === "metro/status"` regardless of
// whether the event is "starting" or "running". The fake-boot timing
// emits both within ~30ms (see `src/daemon/fake-boot.ts:200-205`); a
// regression that wires "starting" but drops "running" passes those
// tests but breaks the renderer's "session ready" gate.
//
// This file pins that contract: two concurrent boots both reach
// `metro/status: running` AND every fanned event is sessionId-tagged.

describe("fake-boot daemon: multi-session concurrent boot (D6)", () => {
  const cleanups: Array<() => void> = [];
  const liveHandles: TestDaemonHandle[] = [];

  afterEach(async () => {
    for (const h of liveHandles.splice(0)) await h.stop();
    for (const c of cleanups.splice(0)) c();
  });

  function makeProfile(worktree: string, name: string, metroPort: number) {
    return {
      name,
      isDefault: true,
      worktree: null as string | null,
      branch: "main",
      platform: "ios" as const,
      mode: "quick" as const,
      metroPort,
      devices: {},
      buildVariant: "debug" as const,
      preflight: { checks: [] as string[], frequency: "once" as const },
      onSave: [],
      env: {},
      projectRoot: worktree,
    };
  }

  it(
    "two concurrent fake-boot sessions both reach metro/status:running with correctly tagged sessionIds",
    async () => {
      const { path: worktree, cleanup } = makeTestWorktree();
      cleanups.push(cleanup);
      const daemon = await spawnTestDaemon(worktree, {
        env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
      });
      liveHandles.push(daemon);

      // The supervisor's fan-out is intentionally global — both
      // subscribers see all sessions' events; routing is client-side
      // (per `session-events-envelope.test.ts` § "events from
      // concurrent sessions are sessionId-tagged so the client can
      // route on sessionId"). So we collect into one shared array and
      // filter on sessionId for per-session assertions.
      const allEvents: IpcMessage[] = [];

      const subA = await daemon.client.subscribe(
        {
          type: "command",
          action: "events/subscribe",
          id: "sub-A",
          payload: { profile: makeProfile(worktree, "alpha", 8081) },
        },
        { onEvent: (evt) => allEvents.push(evt) },
      );
      try {
        const sidA = (subA.initial.payload as { sessionId?: string }).sessionId;
        expect(typeof sidA).toBe("string");

        const subB = await daemon.client.subscribe(
          {
            type: "command",
            action: "events/subscribe",
            id: "sub-B",
            payload: { profile: makeProfile(worktree, "beta", 8082) },
          },
          { onEvent: (evt) => allEvents.push(evt) },
        );
        try {
          const sidB = (subB.initial.payload as { sessionId?: string }).sessionId;
          expect(typeof sidB).toBe("string");
          // The supervisor's Map<SessionId, …> contract — two
          // `session/start` calls with distinct profiles mint distinct
          // sessionIds.
          expect(sidA).not.toBe(sidB);

          // D6 claim 1 + 2 — both reach `metro/status: running`. The
          // fake-boot emits "starting" at +5ms then "running" at +25ms,
          // so a 3s deadline is generous on every machine that runs
          // the rest of the suite.
          await waitForEvent(
            allEvents,
            (evt) => {
              const p = evt.payload as {
                kind?: string;
                sessionId?: string;
                data?: { status?: string };
              };
              return (
                p?.kind === "metro/status" &&
                p.sessionId === sidA &&
                p.data?.status === "running"
              );
            },
            3_000,
          );
          await waitForEvent(
            allEvents,
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
            3_000,
          );

          // D6 claim 3 — every fanned event must carry a sessionId in
          // {sidA, sidB}. Wire-shape regression here breaks the
          // renderer's per-session routing silently (parseSessionEventEnvelope
          // drops envelopes without sessionId, so the renderer would
          // see fewer events than the daemon emits).
          expect(allEvents.length).toBeGreaterThan(0);
          for (const evt of allEvents) {
            const p = evt.payload as { sessionId?: string };
            expect(typeof p.sessionId).toBe("string");
            expect([sidA, sidB]).toContain(p.sessionId);
          }

          // Per-session event slicing — once we've waited for both
          // sessions' `running` event, both arrays are non-empty. This
          // is the invariant the renderer's per-tab UI depends on: a
          // client demuxing on sessionId from a single subscribe
          // socket gets events for every session it cares about.
          const aOnly = allEvents.filter(
            (e) => (e.payload as { sessionId?: string }).sessionId === sidA,
          );
          const bOnly = allEvents.filter(
            (e) => (e.payload as { sessionId?: string }).sessionId === sidB,
          );
          expect(aOnly.length).toBeGreaterThan(0);
          expect(bOnly.length).toBeGreaterThan(0);
        } finally {
          subB.close();
        }
      } finally {
        subA.close();
      }
    },
    15_000,
  );
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
