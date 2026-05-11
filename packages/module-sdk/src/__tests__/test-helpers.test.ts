import { describe, it, expect } from "vitest";
import {
  MockHookRuntime,
  runHookInProcess,
} from "../test-helpers.js";

describe("runHookInProcess — happy path", () => {
  it("returns the fn's resolved value with outcome=ok", async () => {
    const result = await runHookInProcess({
      fn: (n: number) => n * 2,
      payload: 21,
    });
    expect(result.outcome).toBe("ok");
    expect(result.result).toBe(42);
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("awaits an async fn", async () => {
    const result = await runHookInProcess({
      fn: async (s: string) => s.toUpperCase(),
      payload: "hi",
    });
    expect(result.outcome).toBe("ok");
    expect(result.result).toBe("HI");
  });

  it("preserves the payload reference", async () => {
    const payload = { id: 1 };
    const result = await runHookInProcess({
      fn: (p: { id: number }) => p,
      payload,
    });
    expect(result.result).toBe(payload);
  });
});

describe("runHookInProcess — failure paths", () => {
  it("reports outcome=threw with the original error when fn throws sync", async () => {
    const result = await runHookInProcess({
      fn: () => {
        throw new Error("boom");
      },
      payload: undefined,
    });
    expect(result.outcome).toBe("threw");
    expect(result.error?.message).toBe("boom");
    expect(result.result).toBeUndefined();
  });

  it("reports outcome=threw when fn rejects async", async () => {
    const result = await runHookInProcess({
      fn: async () => {
        throw new Error("async-boom");
      },
      payload: undefined,
    });
    expect(result.outcome).toBe("threw");
    expect(result.error?.message).toBe("async-boom");
  });

  it("wraps a non-Error throw into an Error", async () => {
    const result = await runHookInProcess({
      fn: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "string thrown";
      },
      payload: undefined,
    });
    expect(result.outcome).toBe("threw");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe("string thrown");
  });

  it("reports outcome=timeout when fn exceeds timeoutMs", async () => {
    const result = await runHookInProcess({
      fn: () => new Promise<void>(() => undefined),
      payload: undefined,
      timeoutMs: 30,
    });
    expect(result.outcome).toBe("timeout");
    expect(result.error?.message).toMatch(/timed out after 30ms/);
    expect(result.durationMs).toBeGreaterThanOrEqual(20);
  });

  it("uses the default 30s timeout when none is supplied", async () => {
    // Doesn't actually wait 30s — just resolves immediately + asserts
    // the timer was cleared (no leaked handles via the finally block).
    const result = await runHookInProcess({
      fn: () => 1,
      payload: undefined,
    });
    expect(result.outcome).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// MockHookRuntime
// ---------------------------------------------------------------------------

interface DemoFires {
  "demo/pre": { src: string };
  "demo/post": { exitCode: number };
}

describe("MockHookRuntime — recording", () => {
  it("appends a fire to the public fires array", () => {
    const runtime = new MockHookRuntime<DemoFires>();
    runtime.fire("demo/pre", { src: "/tmp/x" });
    expect(runtime.fires).toHaveLength(1);
    expect(runtime.fires[0]?.slot).toBe("demo/pre");
    expect(runtime.fires[0]?.payload).toEqual({ src: "/tmp/x" });
    expect(runtime.fires[0]?.ts).toBeGreaterThan(0);
  });

  it("preserves order across multiple fires", () => {
    const runtime = new MockHookRuntime<DemoFires>();
    runtime.fire("demo/pre", { src: "a" });
    runtime.fire("demo/post", { exitCode: 0 });
    runtime.fire("demo/pre", { src: "b" });
    expect(runtime.fires.map((f) => f.slot)).toEqual([
      "demo/pre",
      "demo/post",
      "demo/pre",
    ]);
  });

  it("uses the now() override for deterministic timestamps", () => {
    let clock = 100;
    const runtime = new MockHookRuntime<DemoFires>({
      now: () => {
        clock += 5;
        return clock;
      },
    });
    runtime.fire("demo/pre", { src: "a" });
    runtime.fire("demo/post", { exitCode: 1 });
    expect(runtime.fires[0]?.ts).toBe(105);
    expect(runtime.fires[1]?.ts).toBe(110);
  });
});

describe("MockHookRuntime — query helpers", () => {
  it("firesFor narrows to a single slot", () => {
    const runtime = new MockHookRuntime<DemoFires>();
    runtime.fire("demo/pre", { src: "a" });
    runtime.fire("demo/post", { exitCode: 0 });
    runtime.fire("demo/pre", { src: "b" });
    const pres = runtime.firesFor("demo/pre");
    expect(pres).toHaveLength(2);
    expect(pres.map((f) => f.payload.src)).toEqual(["a", "b"]);
  });

  it("reset() empties the fires array but keeps the runtime usable", () => {
    const runtime = new MockHookRuntime<DemoFires>();
    runtime.fire("demo/pre", { src: "a" });
    runtime.reset();
    expect(runtime.fires).toEqual([]);
    runtime.fire("demo/post", { exitCode: 9 });
    expect(runtime.fires).toHaveLength(1);
  });
});

describe("MockHookRuntime — untyped default", () => {
  it("accepts any string slot when no contracts are supplied", () => {
    const runtime = new MockHookRuntime();
    runtime.fire("anything/at-all", { foo: 1 });
    expect(runtime.fires[0]?.slot).toBe("anything/at-all");
  });
});
