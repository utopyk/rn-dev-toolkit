import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";

// Phase D2 — wire-protocol coverage of `sessions/list` (plan § B2).
// The RPC closes the spec-flow gaps from D0.5 deepening: renderer
// rehydration after a daemon restart, MCP cold-start, and
// `E_UNKNOWN_SESSION` recovery (the client retries with the right
// sessionId from this snapshot).
//
// Sync read, no events, no subscription. Empty array when no sessions
// are active; one entry per active session otherwise; entries reflect
// the per-session `(sessionId, profileName, worktreeKey, status,
// services)` shape the supervisor exposes via `listSessions()`.

describe("daemon sessions/list (D2)", () => {
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

  it("returns an empty array when no sessions are active", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const resp = await daemon.client.send({
      type: "command",
      action: "sessions/list",
      id: "list-1",
    });
    const payload = resp.payload as { sessions?: unknown[] };
    expect(Array.isArray(payload.sessions)).toBe(true);
    expect(payload.sessions).toHaveLength(0);
  });

  it("returns one entry per active session with profile + worktreeKey + status", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const profile = makeProfile(worktree, "alpha", 8081);
    const sub = await daemon.client.subscribe(
      { type: "command", action: "events/subscribe", id: "sub-1", payload: { profile } },
      { onEvent: () => {} },
    );
    try {
      const ackSid = (sub.initial.payload as { sessionId?: string }).sessionId;
      expect(typeof ackSid).toBe("string");

      const resp = await daemon.client.send({
        type: "command",
        action: "sessions/list",
        id: "list-1",
      });
      const payload = resp.payload as {
        sessions?: Array<{
          sessionId?: string;
          profileName?: string;
          worktreeKey?: string;
          status?: string;
        }>;
      };
      expect(payload.sessions).toHaveLength(1);
      const entry = payload.sessions?.[0];
      expect(entry?.sessionId).toBe(ackSid);
      expect(entry?.profileName).toBe("alpha");
      expect(typeof entry?.worktreeKey).toBe("string");
      // status may be "starting" or "running" depending on whether
      // bootAsync has emitted "running" yet — both are valid snapshots
      // of an active session.
      expect(["starting", "running"]).toContain(entry?.status);
    } finally {
      sub.close();
    }
  });

  it("returns multiple entries when multiple sessions are active (different ports)", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const subA = await daemon.client.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "sub-A",
        payload: { profile: makeProfile(worktree, "alpha", 8081) },
      },
      { onEvent: () => {} },
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
        { onEvent: () => {} },
      );
      try {
        const sidB = (subB.initial.payload as { sessionId?: string }).sessionId;
        expect(sidA).not.toBe(sidB);

        const resp = await daemon.client.send({
          type: "command",
          action: "sessions/list",
          id: "list-1",
        });
        const payload = resp.payload as {
          sessions?: Array<{ sessionId?: string; profileName?: string }>;
        };
        expect(payload.sessions).toHaveLength(2);
        const names = (payload.sessions ?? []).map((e) => e.profileName).sort();
        expect(names).toEqual(["alpha", "beta"]);
        const ids = (payload.sessions ?? []).map((e) => e.sessionId).sort();
        expect(ids).toEqual([sidA, sidB].sort());
      } finally {
        subB.close();
      }
    } finally {
      subA.close();
    }
  });

  it("exposes currentBranch + headSha for a git-tracked worktree", async () => {
    // Regression: bug 2026-08-20 — two agents bundling out of the same
    // "root" session across a `git checkout` swap. `sessions/list` had
    // no branch signal, so neither client could see the tree had drifted.
    // Now every entry carries the daemon's live branch + short SHA.
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const runGit = (cmd: string) =>
      execSync(cmd, { cwd: worktree, stdio: "pipe" });
    runGit("git init -q -b feat/session-list-branch");
    runGit("git config user.email test@rn-dev.local");
    runGit("git config user.name rn-dev-test");
    writeFileSync(join(worktree, "seed.txt"), "seed\n");
    runGit("git add seed.txt");
    runGit('git commit -q -m "seed"');
    const expectedSha = execSync("git rev-parse --short HEAD", {
      cwd: worktree,
    })
      .toString()
      .trim();

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);
    const sub = await daemon.client.subscribe(
      {
        type: "command",
        action: "events/subscribe",
        id: "sub-branch",
        payload: { profile: makeProfile(worktree, "alpha", 8081) },
      },
      { onEvent: () => {} },
    );
    try {
      const resp = await daemon.client.send({
        type: "command",
        action: "sessions/list",
        id: "list-branch",
      });
      const payload = resp.payload as {
        sessions?: Array<{ currentBranch?: string | null; headSha?: string | null }>;
      };
      expect(payload.sessions).toHaveLength(1);
      expect(payload.sessions?.[0]?.currentBranch).toBe(
        "feat/session-list-branch",
      );
      expect(payload.sessions?.[0]?.headSha).toBe(expectedSha);
    } finally {
      sub.close();
    }
  });

  it("returns null branch/sha on a non-git worktree (no crash)", async () => {
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
        id: "sub-nogit",
        payload: { profile: makeProfile(worktree, "alpha", 8081) },
      },
      { onEvent: () => {} },
    );
    try {
      const resp = await daemon.client.send({
        type: "command",
        action: "sessions/list",
        id: "list-nogit",
      });
      const payload = resp.payload as {
        sessions?: Array<{ currentBranch?: string | null; headSha?: string | null }>;
      };
      expect(payload.sessions?.[0]?.currentBranch).toBeNull();
      expect(payload.sessions?.[0]?.headSha).toBeNull();
    } finally {
      sub.close();
    }
  });
});
