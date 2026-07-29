import { describe, expect, it } from "vitest";
import {
  DEFAULT_IDLE_RELEASE_MS,
  IdleTracker,
  resolveIdleReleaseMs,
} from "../idle-release.js";

describe("resolveIdleReleaseMs", () => {
  it("defaults to 60 minutes when unset or empty", () => {
    expect(resolveIdleReleaseMs({})).toBe(DEFAULT_IDLE_RELEASE_MS);
    expect(resolveIdleReleaseMs({ RN_DEV_MCP_IDLE_RELEASE_MS: "" })).toBe(
      DEFAULT_IDLE_RELEASE_MS,
    );
  });

  it("accepts a positive integer override in ms", () => {
    expect(resolveIdleReleaseMs({ RN_DEV_MCP_IDLE_RELEASE_MS: "300000" })).toBe(
      300_000,
    );
  });

  it("disables via 0 or off", () => {
    expect(resolveIdleReleaseMs({ RN_DEV_MCP_IDLE_RELEASE_MS: "0" })).toBeNull();
    expect(resolveIdleReleaseMs({ RN_DEV_MCP_IDLE_RELEASE_MS: "off" })).toBeNull();
    expect(resolveIdleReleaseMs({ RN_DEV_MCP_IDLE_RELEASE_MS: "OFF" })).toBeNull();
  });

  it("falls back to the default on garbage or negative values", () => {
    expect(resolveIdleReleaseMs({ RN_DEV_MCP_IDLE_RELEASE_MS: "soon" })).toBe(
      DEFAULT_IDLE_RELEASE_MS,
    );
    expect(resolveIdleReleaseMs({ RN_DEV_MCP_IDLE_RELEASE_MS: "-5" })).toBe(
      DEFAULT_IDLE_RELEASE_MS,
    );
  });
});

describe("IdleTracker", () => {
  it("is not idle before the window elapses", () => {
    let clock = 1_000;
    const tracker = new IdleTracker(10_000, () => clock);
    clock = 10_999;
    expect(tracker.isIdle()).toBe(false);
  });

  it("becomes idle once the window fully elapses", () => {
    let clock = 1_000;
    const tracker = new IdleTracker(10_000, () => clock);
    clock = 11_000;
    expect(tracker.isIdle()).toBe(true);
  });

  it("touch resets the idle clock", () => {
    let clock = 1_000;
    const tracker = new IdleTracker(10_000, () => clock);
    clock = 10_500;
    tracker.touch();
    clock = 20_000;
    expect(tracker.isIdle()).toBe(false);
    expect(tracker.idleFor()).toBe(9_500);
    clock = 20_500;
    expect(tracker.isIdle()).toBe(true);
  });
});
