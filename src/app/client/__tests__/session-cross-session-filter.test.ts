import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IpcServer } from "../../../core/ipc.js";
import type { IpcMessageEvent } from "../../../core/ipc.js";
import { connectToDaemonSession } from "../session.js";
import type { Profile } from "../../../core/types.js";

// Phase E wire-contract follow-on — client-side multi-session dispatch.
//
// The daemon's `supervisor.onEvent(push)` is GLOBAL — it fans out every
// session's events to every subscriber. With two Electron tabs open
// (one per session), each tab's `events/subscribe` socket receives
// events for BOTH sessions. Without a sessionId filter in
// `onIncomingEvent`, session A's metro/log events would be dispatched
// to session B's MetroClient (and vice versa), so:
//   - session B's tab would show iOS metro logs that came from session A
//   - session A's tab would show Android metro logs that came from session B
//
// This was a real user-observed bug during the E7 real-boot probe
// against acme: reloading the iOS app surfaced its metro/log lines
// on the Pixel tab. Same wire-contract pattern as Phase M's `48fde5b`
// (daemon-side modules listener filter) but on the CLIENT dispatch path.
//
// The fix: `session.ts:onIncomingEvent` drops events whose `evt.sessionId`
// doesn't match the subscriber's bound sessionId. These tests pin the
// behaviour.

const FAKE_WORKTREE_KEY = "stub-worktree-key";
const THIS_SESSION_ID = "00000000-0000-0000-0000-00000000aaaa";
const OTHER_SESSION_ID = "00000000-0000-0000-0000-00000000bbbb";

function makeProfile(projectRoot: string): Profile {
  return {
    name: "test",
    isDefault: true,
    worktree: null,
    branch: "main",
    platform: "ios",
    mode: "quick",
    metroPort: 8081,
    devices: {},
    buildVariant: "debug",
    preflight: { checks: [], frequency: "once" },
    onSave: [],
    env: {},
    projectRoot,
  };
}

describe("connectToDaemonSession — cross-session event filter", () => {
  let sockDir: string;
  let sockPath: string;
  let server: IpcServer;
  let prevSock: string | undefined;
  let pushEvent: ((kind: string, sessionId: string, data: unknown) => void) | null;

  beforeEach(async () => {
    pushEvent = null;
    sockDir = mkdtempSync(join(tmpdir(), "rn-dev-cross-session-test-"));
    sockPath = join(sockDir, "sock");
    server = new IpcServer(sockPath);

    server.on("message", (evt: IpcMessageEvent) => {
      const { message, reply } = evt;
      if (message.action !== "events/subscribe") return;

      // Subscribe ack — mint THIS_SESSION_ID as the bound session.
      reply({
        type: "response",
        action: "events/subscribe",
        id: message.id,
        payload: {
          subscribed: true,
          status: "starting",
          started: true,
          attached: 1,
          sessionId: THIS_SESSION_ID,
        },
      });

      // Push the running edge so connectToDaemonSession resolves.
      setImmediate(() => {
        reply({
          type: "event",
          action: "events/subscribe",
          id: message.id,
          payload: {
            kind: "session/status",
            worktreeKey: FAKE_WORKTREE_KEY,
            sessionId: THIS_SESSION_ID,
            data: { status: "running" },
          },
        });
      });

      // Expose a push helper to the test bodies.
      pushEvent = (kind, sessionId, data) => {
        reply({
          type: "event",
          action: "events/subscribe",
          id: message.id,
          payload: {
            kind,
            worktreeKey: FAKE_WORKTREE_KEY,
            sessionId,
            data,
          },
        });
      };
    });

    await server.start();
    prevSock = process.env.RN_DEV_DAEMON_SOCK;
    process.env.RN_DEV_DAEMON_SOCK = sockPath;
  });

  afterEach(async () => {
    if (prevSock === undefined) {
      delete process.env.RN_DEV_DAEMON_SOCK;
    } else {
      process.env.RN_DEV_DAEMON_SOCK = prevSock;
    }
    await server.stop();
    try {
      rmSync(sockDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("metro/log events for THIS session reach the MetroClient", async () => {
    const session = await connectToDaemonSession("/fake/root", makeProfile("/fake/root"), {
      sessionReadyTimeoutMs: 5_000,
    });
    try {
      const received: string[] = [];
      session.metro.on("log", (p: { line: string }) => received.push(p.line));

      // Push an event tagged with THIS session's id.
      expect(pushEvent).not.toBeNull();
      pushEvent!("metro/log", THIS_SESSION_ID, { line: "hello-from-this-session" });

      // Wait for the event to propagate through the IPC layer.
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toEqual(["hello-from-this-session"]);
    } finally {
      session.disconnect();
    }
  }, 10_000);

  it("metro/log events for OTHER session DO NOT reach this MetroClient", async () => {
    const session = await connectToDaemonSession("/fake/root", makeProfile("/fake/root"), {
      sessionReadyTimeoutMs: 5_000,
    });
    try {
      const received: string[] = [];
      session.metro.on("log", (p: { line: string }) => received.push(p.line));

      // Push events tagged with a DIFFERENT session's id — these must
      // be dropped by the filter in onIncomingEvent.
      expect(pushEvent).not.toBeNull();
      pushEvent!("metro/log", OTHER_SESSION_ID, { line: "from-foreign-session-1" });
      pushEvent!("metro/log", OTHER_SESSION_ID, { line: "from-foreign-session-2" });
      pushEvent!("metro/log", OTHER_SESSION_ID, { line: "from-foreign-session-3" });

      await new Promise((r) => setTimeout(r, 50));
      expect(received).toEqual([]);
    } finally {
      session.disconnect();
    }
  }, 10_000);

  it("mixed events: only THIS session's events reach the MetroClient", async () => {
    // The real-boot bug surfaces in this exact pattern — the daemon
    // pushes events from session A and session B over the same global
    // fan-out, and each subscriber must filter strictly.
    const session = await connectToDaemonSession("/fake/root", makeProfile("/fake/root"), {
      sessionReadyTimeoutMs: 5_000,
    });
    try {
      const received: string[] = [];
      session.metro.on("log", (p: { line: string }) => received.push(p.line));

      expect(pushEvent).not.toBeNull();
      pushEvent!("metro/log", OTHER_SESSION_ID, { line: "drop-me-1" });
      pushEvent!("metro/log", THIS_SESSION_ID, { line: "keep-me-1" });
      pushEvent!("metro/log", OTHER_SESSION_ID, { line: "drop-me-2" });
      pushEvent!("metro/log", THIS_SESSION_ID, { line: "keep-me-2" });
      pushEvent!("metro/log", OTHER_SESSION_ID, { line: "drop-me-3" });

      await new Promise((r) => setTimeout(r, 50));
      expect(received).toEqual(["keep-me-1", "keep-me-2"]);
    } finally {
      session.disconnect();
    }
  }, 10_000);

  it("builder/done events for OTHER session DO NOT reach this BuilderClient", async () => {
    // Builder events were the second failure mode the user would have
    // hit on a longer real-boot run — acme's builder is per-session,
    // so a cross-leaked builder/done would mark the wrong tab as
    // "build complete" and trip every renderer state machine downstream.
    const session = await connectToDaemonSession("/fake/root", makeProfile("/fake/root"), {
      sessionReadyTimeoutMs: 5_000,
    });
    try {
      const received: Array<{ success: boolean }> = [];
      session.builder.on("done", (p) => received.push({ success: p.success }));

      expect(pushEvent).not.toBeNull();
      pushEvent!("builder/done", OTHER_SESSION_ID, {
        source: "xcodebuild",
        success: true,
        errors: [],
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(received).toEqual([]);
    } finally {
      session.disconnect();
    }
  }, 10_000);
});
