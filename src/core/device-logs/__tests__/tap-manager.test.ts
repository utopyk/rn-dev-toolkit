/**
 * Unit tests for TapManager — covers refcounting, idempotent start,
 * shutdown, and the adapter contract. Uses an in-memory fake adapter
 * so tests don't shell out to idevicesyslog/adb.
 */

import { describe, it, expect, vi } from "vitest";
import { DeviceLogsStore } from "../buffer.js";
import { TapManager, type SpawnAdapter, type SpawnHandle } from "../tap-manager.js";

function fakeAdapter(): { adapter: SpawnAdapter; killed: () => number } {
  let killCount = 0;
  const adapter: SpawnAdapter = {
    async start() {
      const handle: SpawnHandle = {
        kill: () => { killCount++; },
      };
      return handle;
    },
  };
  return { adapter, killed: () => killCount };
}

describe("TapManager", () => {
  it("starts and tracks a tap", async () => {
    const { adapter } = fakeAdapter();
    const mgr = new TapManager(new DeviceLogsStore(), { spawnAdapter: adapter });
    const tap = await mgr.startTap({ platform: "ios", deviceId: "DEV-1", simulator: false });
    expect(tap.status).toBe("running");
    expect(tap.refcount).toBe(1);
    expect(mgr.listTaps()).toHaveLength(1);
  });

  it("refcounts consumers on the same device", async () => {
    const { adapter } = fakeAdapter();
    const mgr = new TapManager(new DeviceLogsStore(), { spawnAdapter: adapter });
    const a = await mgr.startTap({ platform: "android", deviceId: "S-1" });
    const b = await mgr.startTap({ platform: "android", deviceId: "S-1" });
    expect(a.tapId).toBe(b.tapId);
    expect(b.refcount).toBe(2);
    expect(mgr.listTaps()).toHaveLength(1);
  });

  it("stopTap with refcount > 1 keeps the tap running", async () => {
    const { adapter, killed } = fakeAdapter();
    const mgr = new TapManager(new DeviceLogsStore(), { spawnAdapter: adapter });
    const t = await mgr.startTap({ platform: "android", deviceId: "S-1" });
    await mgr.startTap({ platform: "android", deviceId: "S-1" }); // refcount=2
    const r = await mgr.stopTap(t.tapId);
    expect(r.status).toBe("still-running");
    expect(killed()).toBe(0);
    expect(mgr.listTaps()).toHaveLength(1);
  });

  it("last stopTap kills the subprocess and clears the tap", async () => {
    const { adapter, killed } = fakeAdapter();
    const mgr = new TapManager(new DeviceLogsStore(), { spawnAdapter: adapter });
    const t = await mgr.startTap({ platform: "ios", deviceId: "DEV-1" });
    const r = await mgr.stopTap(t.tapId);
    expect(r.status).toBe("stopped");
    expect(killed()).toBe(1);
    expect(mgr.listTaps()).toHaveLength(0);
  });

  it("startTap surfaces adapter failure as status='error'", async () => {
    const failing: SpawnAdapter = {
      async start() { throw new Error("adb not found"); },
    };
    const mgr = new TapManager(new DeviceLogsStore(), { spawnAdapter: failing });
    const t = await mgr.startTap({ platform: "android", deviceId: "S-1" });
    expect(t.status).toBe("error");
    expect(t.error).toContain("adb not found");
  });

  it("default adapter (no override) errors out — Phase 1 stub", async () => {
    const mgr = new TapManager(new DeviceLogsStore());
    const t = await mgr.startTap({ platform: "ios", deviceId: "DEV-1" });
    expect(t.status).toBe("error");
    expect(t.error).toContain("not yet implemented");
  });

  it("shutdown kills every running tap", async () => {
    const { adapter, killed } = fakeAdapter();
    const mgr = new TapManager(new DeviceLogsStore(), { spawnAdapter: adapter });
    await mgr.startTap({ platform: "ios", deviceId: "A" });
    await mgr.startTap({ platform: "android", deviceId: "B" });
    await mgr.shutdown();
    expect(killed()).toBe(2);
    expect(mgr.listTaps()).toHaveLength(0);
  });

  it("stopTap on unknown tapId is a no-op", async () => {
    const { adapter } = fakeAdapter();
    const mgr = new TapManager(new DeviceLogsStore(), { spawnAdapter: adapter });
    const r = await mgr.stopTap("tap-ios-DOES-NOT-EXIST");
    expect(r.status).toBe("stopped");
  });

  // Verify mock isn't used incorrectly (sanity check that we're testing
  // the real TapManager, not a fake).
  it("uses the real internal logic", () => {
    const { adapter } = fakeAdapter();
    const mgr = new TapManager(new DeviceLogsStore(), { spawnAdapter: adapter });
    expect(vi.isMockFunction(mgr.startTap)).toBe(false);
  });
});
