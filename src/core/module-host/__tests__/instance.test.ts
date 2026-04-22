import { describe, it, expect, vi } from "vitest";
import {
  ModuleInstance,
  type ModuleInstanceState,
  InvalidStateTransitionError,
} from "../instance.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeInstance(): ModuleInstance {
  return new ModuleInstance({ moduleId: "fixture", scopeUnit: "global" });
}

// ---------------------------------------------------------------------------
// Initial state + identity
// ---------------------------------------------------------------------------

describe("ModuleInstance — identity + initial state", () => {
  it("starts in state 'idle'", () => {
    expect(makeInstance().state).toBe<ModuleInstanceState>("idle");
  });

  it("exposes moduleId and scopeUnit", () => {
    const inst = new ModuleInstance({
      moduleId: "example",
      scopeUnit: "wt-1",
    });
    expect(inst.moduleId).toBe("example");
    expect(inst.scopeUnit).toBe("wt-1");
  });

  it("tracks crash count (starts at 0)", () => {
    expect(makeInstance().crashCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Valid transitions
// ---------------------------------------------------------------------------

describe("ModuleInstance — valid transitions", () => {
  const happyPath: ModuleInstanceState[] = [
    "spawning",
    "handshaking",
    "active",
    "stopping",
    "idle",
  ];

  it("walks idle → spawning → handshaking → active → stopping → idle", () => {
    const inst = makeInstance();
    for (const target of happyPath) {
      inst.transitionTo(target);
      expect(inst.state).toBe(target);
    }
  });

  it("active → updating → active (version-bump drain)", () => {
    const inst = makeInstance();
    inst.transitionTo("spawning");
    inst.transitionTo("handshaking");
    inst.transitionTo("active");
    inst.transitionTo("updating");
    expect(inst.state).toBe("updating");
    inst.transitionTo("active");
    expect(inst.state).toBe("active");
  });

  it("active → restarting → spawning (manual restart)", () => {
    const inst = makeInstance();
    inst.transitionTo("spawning");
    inst.transitionTo("handshaking");
    inst.transitionTo("active");
    inst.transitionTo("restarting");
    inst.transitionTo("spawning");
    expect(inst.state).toBe("spawning");
  });

  it("active → crashed (unexpected exit) and crashed → spawning (supervisor retry)", () => {
    const inst = makeInstance();
    inst.transitionTo("spawning");
    inst.transitionTo("handshaking");
    inst.transitionTo("active");
    inst.transitionTo("crashed");
    expect(inst.state).toBe("crashed");
    expect(inst.crashCount).toBe(1);
    inst.transitionTo("spawning");
    expect(inst.state).toBe("spawning");
  });

  it("crashed → failed (supervisor gave up — terminal)", () => {
    const inst = makeInstance();
    inst.transitionTo("spawning");
    inst.transitionTo("handshaking");
    inst.transitionTo("active");
    inst.transitionTo("crashed");
    inst.transitionTo("failed");
    expect(inst.state).toBe("failed");
  });

  it("failed → spawning is allowed (manual modules/restart)", () => {
    const inst = makeInstance();
    inst.transitionTo("spawning");
    inst.transitionTo("handshaking");
    inst.transitionTo("active");
    inst.transitionTo("crashed");
    inst.transitionTo("failed");
    // Explicit user-triggered recovery:
    inst.transitionTo("spawning");
    expect(inst.state).toBe("spawning");
  });

  it("spawning → crashed (spawn-time failure, e.g. ENOENT)", () => {
    const inst = makeInstance();
    inst.transitionTo("spawning");
    inst.transitionTo("crashed");
    expect(inst.state).toBe("crashed");
    expect(inst.crashCount).toBe(1);
  });

  it("handshaking → crashed (handshake timeout)", () => {
    const inst = makeInstance();
    inst.transitionTo("spawning");
    inst.transitionTo("handshaking");
    inst.transitionTo("crashed");
    expect(inst.state).toBe("crashed");
  });
});

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

describe("ModuleInstance — invalid transitions throw InvalidStateTransitionError", () => {
  it("idle → active is invalid (must go through spawning + handshaking)", () => {
    const inst = makeInstance();
    expect(() => inst.transitionTo("active")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("active → idle is invalid (must go through stopping)", () => {
    const inst = makeInstance();
    inst.transitionTo("spawning");
    inst.transitionTo("handshaking");
    inst.transitionTo("active");
    expect(() => inst.transitionTo("idle")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("idle → handshaking is invalid (no prior spawn)", () => {
    const inst = makeInstance();
    expect(() => inst.transitionTo("handshaking")).toThrow();
  });

  it("error message includes current and target state + module identity", () => {
    const inst = new ModuleInstance({
      moduleId: "pinpoint",
      scopeUnit: "wt-x",
    });
    try {
      inst.transitionTo("active");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStateTransitionError);
      const message = (err as Error).message;
      expect(message).toContain("pinpoint");
      expect(message).toContain("idle");
      expect(message).toContain("active");
    }
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("ModuleInstance — events", () => {
  it("emits 'state-changed' with { from, to } on every transition", () => {
    const inst = makeInstance();
    const listener = vi.fn();
    inst.on("state-changed", listener);

    inst.transitionTo("spawning");
    expect(listener).toHaveBeenCalledWith({ from: "idle", to: "spawning" });

    inst.transitionTo("handshaking");
    expect(listener).toHaveBeenCalledWith({
      from: "spawning",
      to: "handshaking",
    });
  });

  it("does NOT emit 'state-changed' on an invalid transition", () => {
    const inst = makeInstance();
    const listener = vi.fn();
    inst.on("state-changed", listener);
    try {
      inst.transitionTo("active");
    } catch {
      /* expected */
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it("emits 'crashed' with { reason } when entering crashed state", () => {
    const inst = makeInstance();
    const listener = vi.fn();
    inst.on("crashed", listener);

    inst.transitionTo("spawning");
    inst.transitionTo("crashed", { reason: "ENOENT: no such file" });

    expect(listener).toHaveBeenCalledWith({
      reason: "ENOENT: no such file",
    });
  });

  it("emits 'failed' with { reason } when entering failed state", () => {
    const inst = makeInstance();
    const listener = vi.fn();
    inst.on("failed", listener);

    inst.transitionTo("spawning");
    inst.transitionTo("crashed", { reason: "boom" });
    inst.transitionTo("failed", { reason: "too many crashes" });

    expect(listener).toHaveBeenCalledWith({ reason: "too many crashes" });
  });

  it("records reason on crashed/failed for reporting", () => {
    const inst = makeInstance();
    inst.transitionTo("spawning");
    inst.transitionTo("crashed", { reason: "segfault" });
    expect(inst.lastCrashReason).toBe("segfault");
  });
});

// ---------------------------------------------------------------------------
// Crash counter
// ---------------------------------------------------------------------------

describe("ModuleInstance — crash counter", () => {
  it("increments on every transition INTO crashed", () => {
    const inst = makeInstance();
    inst.transitionTo("spawning");
    inst.transitionTo("crashed");
    inst.transitionTo("spawning");
    inst.transitionTo("crashed");
    expect(inst.crashCount).toBe(2);
  });

  it("resets to 0 when reaching active (successful recovery)", () => {
    const inst = makeInstance();
    inst.transitionTo("spawning");
    inst.transitionTo("crashed");
    inst.transitionTo("spawning");
    inst.transitionTo("handshaking");
    inst.transitionTo("active");
    expect(inst.crashCount).toBe(0);
  });

  it("does NOT reset when reaching failed", () => {
    const inst = makeInstance();
    inst.transitionTo("spawning");
    inst.transitionTo("crashed");
    inst.transitionTo("failed");
    expect(inst.crashCount).toBe(1);
  });
});
