import { describe, it, expect, vi } from "vitest";
import { ModuleInstance } from "../instance.js";
import { Supervisor } from "../supervisor.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  instance: ModuleInstance;
  onRespawn: ReturnType<typeof vi.fn>;
  clock: { now: number };
  supervisor: Supervisor;
}

function setup(
  overrides: Partial<{
    maxCrashesInWindow: number;
    windowMs: number;
  }> = {},
): Harness {
  const instance = new ModuleInstance({
    moduleId: "super-test",
    scopeUnit: "global",
  });
  const onRespawn = vi.fn();
  const clock = { now: 0 };
  const supervisor = new Supervisor({
    instance,
    onRespawn,
    clock: () => clock.now,
    maxCrashesInWindow: overrides.maxCrashesInWindow ?? 5,
    windowMs: overrides.windowMs ?? 3 * 60_000,
  });
  supervisor.attach();
  return { instance, onRespawn, clock, supervisor };
}

function spawnActive(instance: ModuleInstance): void {
  instance.transitionTo("spawning");
  instance.transitionTo("handshaking");
  instance.transitionTo("active");
}

/**
 * Simulate a crash BEFORE stabilization — idle/crashed → spawning → crashed.
 * Used by crash-loop tests that must avoid the `active` checkpoint (which
 * resets the sliding window).
 */
function spawnAndCrash(
  instance: ModuleInstance,
  reason = "boom",
): void {
  if (instance.state === "idle" || instance.state === "crashed") {
    instance.transitionTo("spawning");
  }
  instance.transitionTo("crashed", { reason });
}

// ---------------------------------------------------------------------------
// Restart policy — single crash, under the threshold
// ---------------------------------------------------------------------------

describe("Supervisor — transient crashes", () => {
  it("single crash triggers onRespawn (not 'failed')", () => {
    const { instance, onRespawn } = setup();
    spawnActive(instance);
    instance.transitionTo("crashed", { reason: "boom" });
    expect(onRespawn).toHaveBeenCalledTimes(1);
    expect(instance.state).toBe("crashed");
  });

  it("four crashes in the window all respawn (threshold is 5)", () => {
    const { instance, onRespawn, clock } = setup();
    for (let i = 0; i < 4; i++) {
      clock.now += 1000;
      spawnAndCrash(instance, `boom ${i}`);
    }
    expect(onRespawn).toHaveBeenCalledTimes(4);
    expect(instance.state).toBe("crashed");
  });
});

// ---------------------------------------------------------------------------
// Restart policy — crash loop crosses the threshold
// ---------------------------------------------------------------------------

describe("Supervisor — crash loop detection", () => {
  it("fifth crash within window transitions instance to 'failed'", () => {
    const { instance, onRespawn, clock } = setup();
    for (let i = 0; i < 5; i++) {
      clock.now += 1000;
      spawnAndCrash(instance);
    }
    expect(instance.state).toBe("failed");
    // onRespawn called on the first 4 transient crashes, not the 5th.
    expect(onRespawn).toHaveBeenCalledTimes(4);
  });

  it("emits 'failed' with a reason that references the threshold and window", () => {
    const { instance, clock } = setup({ windowMs: 60_000 });
    const failedSpy = vi.fn();
    instance.on("failed", failedSpy);
    for (let i = 0; i < 5; i++) {
      clock.now += 1000;
      spawnAndCrash(instance);
    }
    expect(failedSpy).toHaveBeenCalledTimes(1);
    const reason = failedSpy.mock.calls[0]?.[0]?.reason ?? "";
    expect(reason).toMatch(/5/);
    expect(reason).toMatch(/60000|supervisor/i);
  });
});

// ---------------------------------------------------------------------------
// Sliding window
// ---------------------------------------------------------------------------

describe("Supervisor — sliding window", () => {
  it("crashes outside the window are evicted (5 crashes, but only 4 within window → respawn)", () => {
    const { instance, onRespawn, clock } = setup({
      maxCrashesInWindow: 5,
      windowMs: 60_000,
    });

    // Four crashes spread across the window
    for (let i = 0; i < 4; i++) {
      clock.now += 10_000;
      spawnAndCrash(instance);
    }
    // Jump clock forward well past the 60s window — old crashes evicted
    clock.now += 120_000;
    // One more crash — now only 1 within window
    spawnAndCrash(instance);

    expect(onRespawn).toHaveBeenCalledTimes(5); // all respawned
    expect(instance.state).toBe("crashed");
  });
});

// ---------------------------------------------------------------------------
// Crash tracking reset on successful recovery
// ---------------------------------------------------------------------------

describe("Supervisor — crash-window reset on recovery", () => {
  it("reaching 'active' clears the window so future crashes restart counting", () => {
    const { instance, onRespawn, clock } = setup({
      maxCrashesInWindow: 5,
      windowMs: 10 * 60_000,
    });

    // 4 quick crashes — window is 10min so these all count
    for (let i = 0; i < 4; i++) {
      clock.now += 1000;
      spawnAndCrash(instance);
    }
    expect(onRespawn).toHaveBeenCalledTimes(4);

    // Recovery
    instance.transitionTo("spawning");
    instance.transitionTo("handshaking");
    instance.transitionTo("active");
    // Now crash — should be treated as the 1st, not the 5th.
    clock.now += 1000;
    instance.transitionTo("crashed");

    expect(instance.state).toBe("crashed");
    expect(onRespawn).toHaveBeenCalledTimes(5);
  });
});

// ---------------------------------------------------------------------------
// detach()
// ---------------------------------------------------------------------------

describe("Supervisor — detach", () => {
  it("stops reacting to crashes after detach()", () => {
    const { instance, onRespawn, supervisor } = setup();
    spawnActive(instance);
    supervisor.detach();
    instance.transitionTo("crashed");
    expect(onRespawn).not.toHaveBeenCalled();
  });
});
