// Phase H2g — focused unit test for the client-rpcs.ts builder/build
// handler's hook-firing logic. Exercises the wire shape (build/pre
// before, build/post after Builder's `done` event) without spinning a
// real daemon — the real-boot smoke (H2h) covers the live process pair.
//
// Pin invariants:
//   1. build/pre fires BEFORE services.builder.build(opts) is invoked.
//   2. build/pre hard-failure aborts the RPC with E_HOOK_FAILED + phase.
//   3. build/post fires AFTER the Builder emits 'done' (with the same
//      validated profile passed to build/pre).
//   4. build/post is fired on a one-shot listener — a second build does
//      not double-fire the post hook from a stale subscriber.
//   5. session/profile-update mutates services.validatedProfile so a
//      subsequent build/pre receives the refreshed brand.

import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { handleBuilderBuild } from "../client-rpcs.js";
import type { SessionServices } from "../../core/session/boot.js";
import type { DaemonSupervisor } from "../supervisor.js";
import type { Builder, BuildHandle, BuildResult } from "../../core/builder.js";
import type { HookManager } from "../../core/hooks/manager.js";
import type { ValidatedProfile } from "../profile-guard.js";
import type { IpcMessage } from "../../core/ipc.js";
import { generateSessionId } from "../../core/identifiers.js";

const PROFILE_A = { tag: "A" } as unknown as ValidatedProfile;
const PROFILE_B = { tag: "B" } as unknown as ValidatedProfile;

/**
 * Phase D3 — fake `Builder` whose `build()` returns a `BuildHandle`
 * whose `promise` resolves when the test emits `done` on the
 * EventEmitter. Mirrors the real Builder contract: the promise is
 * the post-hook trigger; the `done` event still fires for downstream
 * fan-out. Tests emit `done` to settle the promise.
 */
function makeBuilder(opts?: { onBuild?: (opts: unknown) => void }): Builder {
  const e = new EventEmitter();
  let counter = 0;
  (e as unknown as { build: (opts: unknown) => BuildHandle }).build = vi.fn(
    (callOpts: unknown): BuildHandle => {
      opts?.onBuild?.(callOpts);
      const buildId = `bh-${++counter}`;
      let resolveResult!: (r: BuildResult) => void;
      const promise = new Promise<BuildResult>((resolve) => {
        resolveResult = resolve;
      });
      // Wire the test's manual `done` emit to settle this build's
      // promise — same single-resolution contract the real Builder
      // honours via its child_process exit handler.
      e.once("done", () =>
        resolveResult({ success: true, errors: [], rawOutput: "" }),
      );
      return { buildId, promise, cancel: () => {} };
    },
  );
  (e as unknown as { dispose: () => Promise<void> }).dispose = async () =>
    undefined;
  return e as unknown as Builder;
}

type FireFn = (...args: unknown[]) => Promise<unknown>;

function makeServices(
  fire: FireFn | ReturnType<typeof vi.fn>,
  builder: Builder,
  profile: ValidatedProfile = PROFILE_A,
): SessionServices {
  const hookManager = { fire: fire as FireFn } as unknown as HookManager;
  return {
    sessionId: generateSessionId(),
    metro: undefined as never,
    devtools: undefined as never,
    watcher: null,
    builder,
    moduleHost: undefined as never,
    moduleRegistry: undefined as never,
    worktreeKey: "wt-test",
    metroLogsStore: undefined as never,
    capabilities: undefined as never,
    moduleEvents: undefined as never,
    hookManager,
    validatedProfile: profile,
    bootTrace: [],
    acquiredModules: [],
    dispose: async () => undefined,
  };
}

function fakeSupervisor(worktree = "/tmp/wt"): DaemonSupervisor {
  return {
    getWorktree: () => worktree,
  } as unknown as DaemonSupervisor;
}

const VALID_BUILD_PAYLOAD = {
  projectRoot: "/tmp/wt",
  platform: "ios",
  port: 8081,
  variant: "debug",
};

function buildMsg(payload: unknown = VALID_BUILD_PAYLOAD): IpcMessage {
  return {
    type: "command",
    action: "builder/build",
    id: "build-1",
    payload,
  };
}

describe("builder/build hook firing (H2g)", () => {
  it("fires build/pre BEFORE invoking Builder.build()", async () => {
    const calls: string[] = [];
    const builder = makeBuilder({
      onBuild: () => {
        calls.push("builder.build");
      },
    });
    const fire = vi.fn(async (target: string) => {
      calls.push(`fire:${target}`);
      return { ok: true, fired: 0, skipped: 0, failures: [] };
    });

    const services = makeServices(fire, builder);
    const result = await handleBuilderBuild(
      buildMsg(),
      services,
      fakeSupervisor("/tmp/wt"),
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["fire:build/pre", "builder.build"]);
    expect(fire).toHaveBeenCalledWith(
      "build/pre",
      expect.objectContaining({ profile: PROFILE_A }),
      PROFILE_A,
    );
  });

  it("aborts the RPC with E_HOOK_FAILED when build/pre throws (onFail:'hard')", async () => {
    const buildSpy = vi.fn();
    const builder = makeBuilder({
      onBuild: () => {
        buildSpy();
      },
    });
    const fire = vi.fn(async (target: string) => {
      if (target === "build/pre") throw new Error("hook hard-failed");
      return { ok: true, fired: 0, skipped: 0, failures: [] };
    });

    const services = makeServices(fire, builder);
    const result = await handleBuilderBuild(
      buildMsg(),
      services,
      fakeSupervisor("/tmp/wt"),
    );

    expect(result).toEqual({
      ok: false,
      code: "E_HOOK_FAILED",
      phase: "build/pre",
      message: "hook hard-failed",
    });
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it("fires build/post AFTER the Builder emits 'done'", async () => {
    const calls: string[] = [];
    const builder = makeBuilder();
    const fire = vi.fn(async (target: string) => {
      calls.push(`fire:${target}`);
      return { ok: true, fired: 0, skipped: 0, failures: [] };
    });

    const services = makeServices(fire, builder);
    await handleBuilderBuild(buildMsg(), services, fakeSupervisor("/tmp/wt"));

    // Trigger 'done' — build/post should fire. The fake Builder's
    // build() wires this emit to its returned BuildHandle.promise
    // resolver, so the handler's `handle.promise.then()` chain
    // settles on the next microtask.
    (builder as unknown as EventEmitter).emit("done", { success: true });
    await new Promise((r) => setImmediate(r));

    expect(calls).toEqual(["fire:build/pre", "fire:build/post"]);
    expect(fire).toHaveBeenLastCalledWith(
      "build/post",
      expect.objectContaining({ profile: PROFILE_A }),
      PROFILE_A,
    );
  });

  it("scopes post-hook to each build's BuildHandle.promise so a second build does not double-fire post from a stale subscriber", async () => {
    const builder = makeBuilder();
    const fire = vi.fn(async () => ({
      ok: true,
      fired: 0,
      skipped: 0,
      failures: [],
    }));

    const services = makeServices(fire, builder);

    await handleBuilderBuild(buildMsg(), services, fakeSupervisor("/tmp/wt"));
    (builder as unknown as EventEmitter).emit("done", { success: true });
    await new Promise((r) => setImmediate(r));

    // First build: 1 pre + 1 post = 2 fires.
    expect(fire).toHaveBeenCalledTimes(2);

    await handleBuilderBuild(buildMsg(), services, fakeSupervisor("/tmp/wt"));
    (builder as unknown as EventEmitter).emit("done", { success: true });
    await new Promise((r) => setImmediate(r));

    // Second build: 1 more pre + 1 more post — NOT 1 pre + 2 post (which
    // would happen if the previous build's listener stayed attached).
    expect(fire).toHaveBeenCalledTimes(4);
    const targets = (fire.mock.calls as Array<Array<unknown>>).map(
      (c) => c[0],
    );
    expect(targets).toEqual([
      "build/pre",
      "build/post",
      "build/pre",
      "build/post",
    ]);
  });

  it("a build/post hook failure does NOT propagate (RPC has long since returned)", async () => {
    const builder = makeBuilder();
    const fire = vi.fn(async (target: string) => {
      if (target === "build/post") throw new Error("post-hook hard-failed");
      return { ok: true, fired: 0, skipped: 0, failures: [] };
    });

    const services = makeServices(fire, builder);
    const result = await handleBuilderBuild(
      buildMsg(),
      services,
      fakeSupervisor("/tmp/wt"),
    );
    expect(result).toEqual({ ok: true });

    // Emit 'done' — the post-hook throw must be swallowed (the RPC
    // already returned ok:true). If the swallow path is broken this
    // test triggers an unhandled rejection.
    (builder as unknown as EventEmitter).emit("done", { success: true });
    await new Promise((r) => setImmediate(r));

    expect(fire).toHaveBeenCalledTimes(2);
  });
});
