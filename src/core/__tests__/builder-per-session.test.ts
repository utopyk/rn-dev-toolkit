/**
 * Phase D3 — Builder Promise-returning + per-session correctness.
 *
 * Pins three load-bearing invariants:
 *
 *   1. `build()` returns a `BuildHandle` whose `promise` resolves
 *      exactly once per call, with the same `buildId` that flows
 *      through the matching `done` event.
 *
 *   2. iOS+Android concurrent builds against ONE Builder don't
 *      cross-talk. The pre-D3 `.once("done")` pattern in
 *      `client-rpcs.ts:201` would mis-fire post-hooks because the
 *      concurrency-guard's synthetic `done` would settle the first
 *      build's listener. Promise-per-handle is per-call by
 *      construction.
 *
 *   3. Two `Builder` instances (one per session) run concurrent
 *      builds independently — no shared state, no cross-talk.
 *
 * Uses `vi.mock("child_process")` to skip the real xcodebuild/gradle
 * spawn; the test fakes proc.on("exit", code => …) to drive the
 * resolver chain.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Builder, type BuildHandle, type BuildResult } from "../builder.js";

interface FakeProc extends EventEmitter {
  pid: number;
  stdout: { on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
  unref?: ReturnType<typeof vi.fn>;
}

const activeProcs: FakeProc[] = [];

// Mock child_process.spawn so we never invoke xcodebuild / gradle.
// Each spawn returns a fresh FakeProc the test can drive via .emit("exit").
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const proc = new EventEmitter() as unknown as FakeProc;
      proc.pid = 10000 + activeProcs.length;
      proc.exitCode = null;
      proc.stdout = { on: vi.fn() };
      proc.stderr = { on: vi.fn() };
      proc.kill = vi.fn();
      proc.unref = vi.fn();
      activeProcs.push(proc);
      return proc;
    }),
  };
});

// Drive a FakeProc to its exit handler — flips exitCode then emits.
function settleProc(proc: FakeProc, code: number): void {
  proc.exitCode = code;
  proc.emit("exit", code);
}

describe("Builder Promise-returning build() (Phase D3)", () => {
  beforeEach(() => {
    activeProcs.length = 0;
  });

  it("build() returns a BuildHandle whose promise resolves with BuildResult on subprocess exit", async () => {
    const builder = new Builder();
    const handle: BuildHandle = builder.build({
      projectRoot: "/repo",
      platform: "ios",
      port: 8081,
      variant: "debug",
    });

    expect(typeof handle.buildId).toBe("string");
    expect(handle.buildId.length).toBeGreaterThan(0);

    const proc = activeProcs[0];
    expect(proc).toBeDefined();

    // Race-free check: promise must not have resolved yet — the
    // subprocess hasn't exited.
    let settled = false;
    void handle.promise.then(() => {
      settled = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);

    settleProc(proc!, 0);
    const result = await handle.promise;
    expect(result.success).toBe(true);
  });

  it("done event carries the matching buildId, scoped to the handle that fired it", async () => {
    const builder = new Builder();
    const doneEvents: Array<{ buildId: string; success: boolean }> = [];
    builder.on("done", (evt: { buildId: string; success: boolean }) => {
      doneEvents.push({ buildId: evt.buildId, success: evt.success });
    });

    const h1 = builder.build({
      projectRoot: "/repo",
      platform: "ios",
      port: 8081,
      variant: "debug",
    });

    // Spawn a real subprocess for h1; settle it cleanly.
    settleProc(activeProcs[0]!, 0);
    const r1 = await h1.promise;
    expect(r1.success).toBe(true);

    // After h1 settles, a fresh build is allowed.
    const h2 = builder.build({
      projectRoot: "/repo",
      platform: "android",
      port: 8081,
      variant: "debug",
    });
    settleProc(activeProcs[1]!, 1);
    const r2 = await h2.promise;
    expect(r2.success).toBe(false);

    // Two done events, each tagged with its own buildId.
    expect(doneEvents).toHaveLength(2);
    expect(doneEvents[0]!.buildId).toBe(h1.buildId);
    expect(doneEvents[1]!.buildId).toBe(h2.buildId);
    expect(doneEvents[0]!.buildId).not.toBe(doneEvents[1]!.buildId);
  });

  it("concurrent iOS+Android against one Builder — concurrency guard rejects the second, both promises settle without cross-talk", async () => {
    const builder = new Builder();
    const hIos = builder.build({
      projectRoot: "/repo",
      platform: "ios",
      port: 8081,
      variant: "debug",
    });
    const hAndroid = builder.build({
      projectRoot: "/repo",
      platform: "android",
      port: 8081,
      variant: "debug",
    });

    // Distinct buildIds — never cross.
    expect(hIos.buildId).not.toBe(hAndroid.buildId);

    // Android resolves immediately with the guard rejection. iOS is
    // still in-flight until we settle its subprocess.
    const androidResult: BuildResult = await hAndroid.promise;
    expect(androidResult.success).toBe(false);
    expect(androidResult.errors[0]!.summary).toMatch(/already in progress/i);

    let iosSettled = false;
    void hIos.promise.then(() => {
      iosSettled = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(iosSettled).toBe(false);

    settleProc(activeProcs[0]!, 0);
    const iosResult = await hIos.promise;
    expect(iosResult.success).toBe(true);
  });

  it("two Builder instances (one per session) run concurrent builds without sharing state", async () => {
    const builderA = new Builder();
    const builderB = new Builder();

    const hA = builderA.build({
      projectRoot: "/repo-A",
      platform: "ios",
      port: 8081,
      variant: "debug",
    });
    const hB = builderB.build({
      projectRoot: "/repo-B",
      platform: "ios",
      port: 8082,
      variant: "debug",
    });

    // Each Builder spawned its own subprocess. No concurrency-guard
    // rejection across instances.
    expect(activeProcs).toHaveLength(2);

    // Settle them in reverse order to prove the resolvers are
    // independent and don't cross instances.
    settleProc(activeProcs[1]!, 0);
    const rB = await hB.promise;
    expect(rB.success).toBe(true);

    let aSettled = false;
    void hA.promise.then(() => {
      aSettled = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(aSettled).toBe(false);

    settleProc(activeProcs[0]!, 1);
    const rA = await hA.promise;
    expect(rA.success).toBe(false);
  });

  it("dispose() cancels an in-flight build and awaits its resolver chain", async () => {
    const builder = new Builder();
    const handle = builder.build({
      projectRoot: "/repo",
      platform: "ios",
      port: 8081,
      variant: "debug",
    });

    const proc = activeProcs[0]!;
    // `dispose()` calls `cancel()` which kills the subprocess. The
    // kill mock here doesn't actually emit `exit`; we wire it
    // manually to simulate the OS delivering SIGKILL.
    proc.kill.mockImplementation(() => {
      settleProc(proc, 137);
    });

    await builder.dispose();
    const result = await handle.promise;
    expect(result.success).toBe(false);
    // After dispose, isBuilding clears.
    expect(builder.isBuilding).toBe(false);
  });
});
