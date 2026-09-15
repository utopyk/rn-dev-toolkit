import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";
import type { IpcMessage } from "../../core/ipc.js";

// Phase 13.3 — daemon-side client RPCs. The supervisor owns Metro /
// DevTools / Builder / Watcher now, so every user action the TUI used to
// call directly becomes an RPC. These tests exercise each action +
// every new event kind against a real daemon subprocess using the fake
// boot, so the RPC shape is pinned without bringing up real Metro.

describe("daemon client RPCs (integration)", () => {
  const cleanups: Array<() => void> = [];
  const liveHandles: TestDaemonHandle[] = [];

  afterEach(async () => {
    for (const h of liveHandles.splice(0)) {
      await h.stop();
    }
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  async function bootRunningSession(): Promise<{
    daemon: TestDaemonHandle;
    events: IpcMessage[];
    subClose: () => void;
    worktree: string;
  }> {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    // Phase D2 — events/subscribe { profile } boots-and-attaches in one
    // round-trip. Observer-mode subscribes (no profile) are gone; the
    // sub socket now owns the session refcount.
    const profile = {
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
      projectRoot: worktree,
    };
    const events: IpcMessage[] = [];
    const sub = await daemon.client.subscribe(
      { type: "command", action: "events/subscribe", id: "sub", payload: { profile } },
      { onEvent: (evt) => events.push(evt) },
    );
    await waitForEvent(events, (evt) => {
      const p = payload(evt);
      return p?.kind === "metro/status" && p.data?.status === "running";
    }, 3_000);

    return { daemon, events, subClose: sub.close, worktree };
  }

  it("rejects client RPCs when no session is running", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const resp = await daemon.client.send({
      type: "command",
      action: "metro/reload",
      id: "r-no-session",
    });
    expect((resp.payload as { code?: string }).code).toBe(
      "E_SESSION_NOT_RUNNING",
    );
  });

  it("metro/reload, metro/devMenu, metro/getInstance return fake-manager state", async () => {
    const { daemon, subClose } = await bootRunningSession();
    try {
      const reload = await daemon.client.send({
        type: "command",
        action: "metro/reload",
        id: "reload-1",
      });
      expect((reload.payload as { ok: boolean }).ok).toBe(true);

      const devMenu = await daemon.client.send({
        type: "command",
        action: "metro/devMenu",
        id: "devmenu-1",
      });
      expect((devMenu.payload as { ok: boolean }).ok).toBe(true);

      const instance = await daemon.client.send({
        type: "command",
        action: "metro/getInstance",
        id: "inst-1",
      });
      const inst = (instance.payload as { instance: { status: string } | null })
        .instance;
      expect(inst).not.toBeNull();
      expect(inst?.status).toBe("running");

      // Bug 2026-08-20: `metro/status` had no handler at all — the MCP
      // client called it and got `E_UNKNOWN_ACTION`. Pin the wire
      // contract now (status + port + sessionId payload).
      const statusResp = await daemon.client.send({
        type: "command",
        action: "metro/status",
        id: "status-1",
      });
      const statusPayload = statusResp.payload as {
        sessionId: string;
        status: string;
        port: number | null;
      };
      expect(statusPayload.status).toBe("running");
      expect(typeof statusPayload.sessionId).toBe("string");
      expect(typeof statusPayload.port).toBe("number");
    } finally {
      subClose();
    }
  }, 10_000);

  it("devtools RPCs return fake state and devtools/clear emits a status event", async () => {
    const { daemon, events, subClose } = await bootRunningSession();
    try {
      const list = await daemon.client.send({
        type: "command",
        action: "devtools/listNetwork",
        id: "dt-list",
      });
      const listPayload = list.payload as { entries: unknown[] };
      expect(Array.isArray(listPayload.entries)).toBe(true);

      const status = await daemon.client.send({
        type: "command",
        action: "devtools/status",
        id: "dt-status",
      });
      expect((status.payload as { targets: unknown[] }).targets).toEqual([]);

      const clearResp = await daemon.client.send({
        type: "command",
        action: "devtools/clear",
        id: "dt-clear",
      });
      expect((clearResp.payload as { ok: boolean }).ok).toBe(true);

      // Clear triggers a devtools status emit; verify it flows over events/subscribe.
      await waitForEvent(events, (evt) => {
        const p = payload(evt);
        return p?.kind === "devtools/status";
      }, 2_000);

      const selectBad = await daemon.client.send({
        type: "command",
        action: "devtools/selectTarget",
        id: "dt-sel-bad",
        payload: {},
      });
      expect((selectBad.payload as { code?: string }).code).toBe(
        "E_RPC_INVALID_PAYLOAD",
      );

      const selectOk = await daemon.client.send({
        type: "command",
        action: "devtools/selectTarget",
        id: "dt-sel-ok",
        payload: { targetId: "t1" },
      });
      expect((selectOk.payload as { ok: boolean }).ok).toBe(true);

      const restart = await daemon.client.send({
        type: "command",
        action: "devtools/restart",
        id: "dt-restart",
      });
      const restartPayload = restart.payload as {
        proxyPort?: number;
        sessionNonce?: string;
        code?: string;
      };
      expect(restartPayload.code).toBeUndefined();
      expect(typeof restartPayload.proxyPort).toBe("number");
      expect(typeof restartPayload.sessionNonce).toBe("string");
    } finally {
      subClose();
    }
  }, 10_000);

  it("builder/build rejects denylisted env keys (LD_PRELOAD / DYLD_*) and worktree-escape projectRoot", async () => {
    const { daemon, subClose } = await bootRunningSession();
    try {
      const preload = await daemon.client.send({
        type: "command",
        action: "builder/build",
        id: "build-env-bad",
        payload: {
          projectRoot: "/tmp",
          platform: "ios",
          port: 8081,
          variant: "debug",
          env: { DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib" },
        },
      });
      // projectRoot validation runs first; env check comes next if path
      // is in-tree. Accept either rejection code — both prove the
      // denylisted payload cannot land in a spawn() env dict.
      const preloadPayload = preload.payload as { code?: string };
      expect(preloadPayload.code).toMatch(
        /E_BUILD_PROJECTROOT_OUTSIDE_WORKTREE|E_PROFILE_ENV_BANNED/,
      );

      const relative = await daemon.client.send({
        type: "command",
        action: "builder/build",
        id: "build-root-rel",
        payload: {
          projectRoot: "relative/path",
          platform: "ios",
          port: 8081,
          variant: "debug",
        },
      });
      expect((relative.payload as { code?: string }).code).toBe(
        "E_PROFILE_PATH_NOT_ABSOLUTE",
      );
    } finally {
      subClose();
    }
  }, 10_000);

  it("builder/build emits line/progress/done events", async () => {
    const { daemon, events, subClose, worktree } = await bootRunningSession();
    try {
      const buildResp = await daemon.client.send({
        type: "command",
        action: "builder/build",
        id: "build-1",
        payload: {
          projectRoot: worktree,
          platform: "ios",
          port: 8081,
          variant: "debug",
        },
      });
      expect((buildResp.payload as { ok: boolean }).ok).toBe(true);

      await waitForEvent(events, (evt) => payload(evt)?.kind === "builder/line", 2_000);
      await waitForEvent(events, (evt) => payload(evt)?.kind === "builder/progress", 2_000);
      const done = await waitForEvent(
        events,
        (evt) => payload(evt)?.kind === "builder/done",
        2_000,
      );
      const doneData = payload(done)?.data as { success: boolean; platform: string };
      expect(doneData.success).toBe(true);
      expect(doneData.platform).toBe("ios");

      // Missing projectRoot: checkAbsolutePath rejects first with its
      // own error code. Missing platform (when projectRoot is valid)
      // falls through to the E_RPC_INVALID_PAYLOAD branch — cover both.
      const bad = await daemon.client.send({
        type: "command",
        action: "builder/build",
        id: "build-bad-no-root",
        payload: { platform: "ios" },
      });
      expect((bad.payload as { code?: string }).code).toBe(
        "E_PROFILE_PATH_NOT_STRING",
      );

      const badPlatform = await daemon.client.send({
        type: "command",
        action: "builder/build",
        id: "build-bad-platform",
        payload: { projectRoot: worktree, port: 8081, variant: "debug" },
      });
      expect((badPlatform.payload as { code?: string }).code).toBe(
        "E_RPC_INVALID_PAYLOAD",
      );
    } finally {
      subClose();
    }
  }, 10_000);

  it("builder/build accepts optional scheme + configuration; rejects empty strings", async () => {
    // The user-reported bug: acme has both `Acme` and `Acme-beta`
    // schemes. Without an explicit scheme, RN CLI's default heuristic
    // picks the workspace name (Acme) — works for acme today, but
    // breaks for any project where the workspace name doesn't match
    // the right scheme. Profile.scheme + Profile.configuration close
    // that gap and round-trip through the daemon's builder/build RPC.
    const { daemon, subClose, worktree } = await bootRunningSession();
    try {
      // Happy path: scheme + configuration accepted.
      const okResp = await daemon.client.send({
        type: "command",
        action: "builder/build",
        id: "build-scheme-ok",
        payload: {
          projectRoot: worktree,
          platform: "ios",
          port: 8081,
          variant: "debug",
          scheme: "Acme",
          configuration: "Debug",
        },
      });
      expect((okResp.payload as { ok: boolean }).ok).toBe(true);

      // Empty scheme rejected — silent fall-through to RN CLI's
      // default-scheme heuristic is exactly the ambiguity we're
      // closing.
      const emptyScheme = await daemon.client.send({
        type: "command",
        action: "builder/build",
        id: "build-scheme-empty",
        payload: {
          projectRoot: worktree,
          platform: "ios",
          port: 8081,
          variant: "debug",
          scheme: "",
        },
      });
      expect((emptyScheme.payload as { code?: string }).code).toBe(
        "E_RPC_INVALID_PAYLOAD",
      );

      // Empty configuration rejected for the same reason.
      const emptyConfig = await daemon.client.send({
        type: "command",
        action: "builder/build",
        id: "build-config-empty",
        payload: {
          projectRoot: worktree,
          platform: "ios",
          port: 8081,
          variant: "debug",
          configuration: "",
        },
      });
      expect((emptyConfig.payload as { code?: string }).code).toBe(
        "E_RPC_INVALID_PAYLOAD",
      );
    } finally {
      subClose();
    }
  }, 10_000);

  it("watcher/* RPCs report E_NO_WATCHER_CONFIGURED when profile.onSave is empty", async () => {
    const { daemon, subClose } = await bootRunningSession();
    try {
      const start = await daemon.client.send({
        type: "command",
        action: "watcher/start",
        id: "w-start",
      });
      const startP = start.payload as { ok: boolean; reason?: string };
      expect(startP.ok).toBe(false);
      expect(startP.reason).toBe("E_NO_WATCHER_CONFIGURED");

      const stop = await daemon.client.send({
        type: "command",
        action: "watcher/stop",
        id: "w-stop",
      });
      expect((stop.payload as { ok: boolean }).ok).toBe(false);

      const running = await daemon.client.send({
        type: "command",
        action: "watcher/isRunning",
        id: "w-running",
      });
      expect((running.payload as { running: boolean }).running).toBe(false);
    } finally {
      subClose();
    }
  }, 10_000);

  it("session/profile-update validates, persists to disk, and returns ok", async () => {
    const { daemon, subClose, worktree } = await bootRunningSession();
    try {
      const updated = {
        name: "test",
        isDefault: true,
        worktree: null,
        branch: "main",
        platform: "ios",
        mode: "quick",
        metroPort: 8082,
        devices: {},
        buildVariant: "debug",
        preflight: { checks: [], frequency: "once" },
        onSave: [],
        env: { CUSTOM_VAR: "1" },
        projectRoot: worktree,
      };
      const resp = await daemon.client.send({
        type: "command",
        action: "session/profile-update",
        id: "pu-1",
        payload: { profile: updated },
      });
      expect((resp.payload as { ok: boolean }).ok).toBe(true);

      const profilePath = join(worktree, ".rn-dev", "profiles", "test.json");
      expect(existsSync(profilePath)).toBe(true);
      const written = JSON.parse(readFileSync(profilePath, "utf-8")) as {
        metroPort: number;
        env: Record<string, string>;
      };
      expect(written.metroPort).toBe(8082);
      expect(written.env.CUSTOM_VAR).toBe("1");
    } finally {
      subClose();
    }
  }, 10_000);

  it("session/profile-update rejects a missing profile field", async () => {
    const { daemon, subClose } = await bootRunningSession();
    try {
      const resp = await daemon.client.send({
        type: "command",
        action: "session/profile-update",
        id: "pu-2",
        payload: {},
      });
      const p = resp.payload as { ok: boolean; code?: string };
      expect(p.ok).toBe(false);
      expect(p.code).toBe("E_RPC_INVALID_PAYLOAD");
    } finally {
      subClose();
    }
  }, 10_000);

  it("session/profile-update rejects a denylisted env key", async () => {
    const { daemon, subClose, worktree } = await bootRunningSession();
    try {
      const tainted = {
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
        env: { LD_PRELOAD: "/tmp/evil.so" },
        projectRoot: worktree,
      };
      const resp = await daemon.client.send({
        type: "command",
        action: "session/profile-update",
        id: "pu-3",
        payload: { profile: tainted },
      });
      const p = resp.payload as { ok: boolean; code?: string };
      expect(p.ok).toBe(false);
      // validateProfile surfaces a denylist code from checkEnv; the
      // exact code is policy on profile-guard, but it MUST start with
      // E_PROFILE_ENV (not a generic catch-all) so callers can branch.
      expect(p.code).toMatch(/^E_PROFILE_ENV/);
    } finally {
      subClose();
    }
  }, 10_000);

  // -------------------------------------------------------------------------
  // clean/run — 2026-09-15. Before this RPC existed, `rn-dev/clean` over
  // MCP built a CleanManager in the MCP process and ran it against the
  // project root with no handle on the daemon's Metro. So `clean` deleted
  // node_modules and the Metro caches while Metro kept running and kept
  // serving in-memory transforms from caches that no longer existed. The
  // whole point of routing it through the daemon is that Metro's
  // lifecycle is owned here.
  // -------------------------------------------------------------------------

  it("clean/run rejects an unknown mode before touching Metro", async () => {
    const { daemon, subClose } = await bootRunningSession();
    try {
      const resp = await daemon.client.send({
        type: "command",
        action: "clean/run",
        id: "clean-bad-mode",
        payload: { mode: "nuke-it" },
      });
      expect((resp.payload as { code?: string }).code).toBe(
        "E_RPC_INVALID_PAYLOAD",
      );

      // Metro must be untouched by a rejected call.
      const inst = await daemon.client.send({
        type: "command",
        action: "metro/getInstance",
        id: "clean-bad-mode-inst",
      });
      expect(
        (inst.payload as { instance: { status: string } | null }).instance
          ?.status,
      ).toBe("running");
    } finally {
      subClose();
    }
  }, 10_000);

  it("clean/run rejects an unknown platform", async () => {
    const { daemon, subClose } = await bootRunningSession();
    try {
      const resp = await daemon.client.send({
        type: "command",
        action: "clean/run",
        id: "clean-bad-platform",
        payload: { mode: "dirty", platform: "web" },
      });
      expect((resp.payload as { code?: string }).code).toBe(
        "E_RPC_INVALID_PAYLOAD",
      );
    } finally {
      subClose();
    }
  }, 10_000);

  it("clean/run in dirty mode does no work and leaves Metro alone", async () => {
    const { daemon, subClose } = await bootRunningSession();
    try {
      const resp = await daemon.client.send({
        type: "command",
        action: "clean/run",
        id: "clean-dirty",
        payload: { mode: "dirty", platform: "both" },
      });
      const p = resp.payload as {
        results: unknown[];
        metroRestarted: boolean;
      };
      expect(p.results).toEqual([]);
      // `dirty` resolves to zero steps, so bouncing Metro would be a
      // gratuitous restart — the handler must skip the cycle entirely.
      expect(p.metroRestarted).toBe(false);

      const inst = await daemon.client.send({
        type: "command",
        action: "metro/getInstance",
        id: "clean-dirty-inst",
      });
      expect(
        (inst.payload as { instance: { status: string } | null }).instance
          ?.status,
      ).toBe("running");
    } finally {
      subClose();
    }
  }, 10_000);

  it("clean/run requires a running session", async () => {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveHandles.push(daemon);

    const resp = await daemon.client.send({
      type: "command",
      action: "clean/run",
      id: "clean-no-session",
      payload: { mode: "clean" },
    });
    expect((resp.payload as { code?: string }).code).toBe(
      "E_SESSION_NOT_RUNNING",
    );
  }, 10_000);
});

function payload(evt: IpcMessage):
  | { kind?: string; data?: Record<string, unknown> }
  | undefined {
  return evt.payload as
    | { kind?: string; data?: Record<string, unknown> }
    | undefined;
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
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `waitForEvent: timed out after ${timeoutMs}ms. Events seen: ${JSON.stringify(
      events.map((e) => e.payload),
    )}`,
  );
}
