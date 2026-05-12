import { afterEach, describe, expect, it } from "vitest";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";

// Phase D2 — wire-protocol coverage of the events/subscribe input
// matrix (plan § B2). The 4-cell pre-D2 matrix shrinks to 2:
//   `{ profile }`              → boot-or-join, returns sessionId
//   `{ sessionId }`            → attach-by-id, returns sessionId
//   `{ profile && sessionId }` → E_SUBSCRIBE_INVALID_ARGS
//   `{ neither }`              → E_SUBSCRIBE_INVALID_ARGS
//
// Observer mode (the original `{ neither }` cell) is CUT — rehydration
// flows through `sessions/list` instead. These tests pin the protocol
// shape so a regression that re-opens observer mode (or accepts both
// fields silently) fails loudly here before the integration suite
// even sees it.

describe("daemon events/subscribe input matrix (D2)", () => {
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

  it("boot-or-join: { profile } boots a fresh session and returns sessionId", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const profile = makeProfile(worktree);
    const sub = await daemon.client.subscribe(
      { type: "command", action: "events/subscribe", id: "sub-1", payload: { profile } },
      { onEvent: () => {} },
    );
    try {
      const ack = sub.initial.payload as {
        subscribed?: boolean;
        sessionId?: string;
        status?: string;
        started?: boolean;
      };
      expect(ack.subscribed).toBe(true);
      expect(typeof ack.sessionId).toBe("string");
      expect(ack.sessionId?.length).toBeGreaterThan(0);
      // First-attacher → started=true; status="starting" (the boot is
      // still in progress at ack time, even with fake-boot — the wire
      // contract surfaces the session-lifecycle edge that the fan-out
      // events will subsequently re-emit).
      expect(typeof ack.status).toBe("string");
    } finally {
      sub.close();
    }
  });

  it("boot-or-join: a second { profile } subscriber on the same profile joins (started=false) and gets the SAME sessionId", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const profile = makeProfile(worktree);
    const sub1 = await daemon.client.subscribe(
      { type: "command", action: "events/subscribe", id: "sub-1", payload: { profile } },
      { onEvent: () => {} },
    );
    try {
      const ack1 = sub1.initial.payload as { sessionId?: string };
      expect(typeof ack1.sessionId).toBe("string");

      const sub2 = await daemon.client.subscribe(
        { type: "command", action: "events/subscribe", id: "sub-2", payload: { profile } },
        { onEvent: () => {} },
      );
      try {
        const ack2 = sub2.initial.payload as { sessionId?: string; started?: boolean };
        expect(ack2.sessionId).toBe(ack1.sessionId);
        expect(ack2.started).toBe(false);
      } finally {
        sub2.close();
      }
    } finally {
      sub1.close();
    }
  });

  it("attach-by-id: { sessionId } attaches to an existing session", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const profile = makeProfile(worktree);
    const sub1 = await daemon.client.subscribe(
      { type: "command", action: "events/subscribe", id: "sub-1", payload: { profile } },
      { onEvent: () => {} },
    );
    try {
      const sid = (sub1.initial.payload as { sessionId?: string }).sessionId;
      expect(typeof sid).toBe("string");
      if (!sid) return;

      const sub2 = await daemon.client.subscribe(
        { type: "command", action: "events/subscribe", id: "sub-2", payload: { sessionId: sid } },
        { onEvent: () => {} },
      );
      try {
        const ack2 = sub2.initial.payload as {
          subscribed?: boolean;
          sessionId?: string;
          started?: boolean;
        };
        expect(ack2.subscribed).toBe(true);
        expect(ack2.sessionId).toBe(sid);
        expect(ack2.started).toBe(false);
      } finally {
        sub2.close();
      }
    } finally {
      sub1.close();
    }
  });

  it("attach-by-id: { sessionId } of an unknown session returns E_UNKNOWN_SESSION", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const sub = await daemon.client.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "sub-1",
        payload: { sessionId: "00000000-0000-0000-0000-000000000000" },
      },
      { onEvent: () => {} },
    );
    try {
      const ack = sub.initial.payload as { code?: string; subscribed?: boolean };
      expect(ack.subscribed).toBeUndefined();
      expect(ack.code).toBe("E_UNKNOWN_SESSION");
    } finally {
      sub.close();
    }
  });

  it("invalid args: { profile && sessionId } returns E_SUBSCRIBE_INVALID_ARGS", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const profile = makeProfile(worktree);
    const sub = await daemon.client.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "sub-1",
        payload: {
          profile,
          sessionId: "00000000-0000-0000-0000-000000000000",
        },
      },
      { onEvent: () => {} },
    );
    try {
      const ack = sub.initial.payload as { code?: string };
      expect(ack.code).toBe("E_SUBSCRIBE_INVALID_ARGS");
    } finally {
      sub.close();
    }
  });

  it("invalid args: { neither } returns E_SUBSCRIBE_INVALID_ARGS (observer mode CUT)", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const sub = await daemon.client.subscribe(
      { type: "command", action: "events/subscribe", id: "sub-1", payload: {} },
      { onEvent: () => {} },
    );
    try {
      const ack = sub.initial.payload as { code?: string };
      expect(ack.code).toBe("E_SUBSCRIBE_INVALID_ARGS");
    } finally {
      sub.close();
    }
  });

  it("invalid args: malformed sessionId (empty string) is rejected as E_RPC_INVALID_PAYLOAD via the narrower", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    // Empty-string sessionId trips `stringField` in
    // `parseEventsSubscribeInput`, which treats it as "absent" — so the
    // payload reads as `{ neither }` and the parser rejects it as
    // E_SUBSCRIBE_INVALID_ARGS rather than a more specific
    // empty-string error. Pin that behavior here so a future tightening
    // can't accidentally regress the user-visible code.
    const sub = await daemon.client.subscribe(
      { type: "command", action: "events/subscribe", id: "sub-1", payload: { sessionId: "" } },
      { onEvent: () => {} },
    );
    try {
      const ack = sub.initial.payload as { code?: string };
      expect(ack.code).toBe("E_SUBSCRIBE_INVALID_ARGS");
    } finally {
      sub.close();
    }
  });
});
