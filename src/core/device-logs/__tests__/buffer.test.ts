/**
 * Unit tests for DeviceLogsStore — covers the metro-logs parallel
 * (ring eviction, epoch on clear, cursor invalidation, level filter
 * threshold, multi-device merge by sequence).
 */

import { describe, it, expect } from "vitest";
import { DeviceLogsStore } from "../buffer.js";
import type { DeviceLogsTap } from "../types.js";

const NO_TAPS: readonly DeviceLogsTap[] = [];

describe("DeviceLogsStore", () => {
  it("appends + lists in sequence order", () => {
    const store = new DeviceLogsStore();
    store.append({ source: "ios", deviceId: "D1", level: "info", message: "first" });
    store.append({ source: "ios", deviceId: "D1", level: "warn", message: "second" });
    const r = store.list(undefined, NO_TAPS);
    expect(r.entries.map((e) => e.message)).toEqual(["first", "second"]);
    expect(r.entries[0]!.sequence).toBeLessThan(r.entries[1]!.sequence);
  });

  it("merges across devices by global sequence", () => {
    const store = new DeviceLogsStore();
    store.append({ source: "ios", deviceId: "A", level: "info", message: "a1" });
    store.append({ source: "android", deviceId: "B", level: "info", message: "b1" });
    store.append({ source: "ios", deviceId: "A", level: "info", message: "a2" });
    const r = store.list(undefined, NO_TAPS);
    expect(r.entries.map((e) => e.message)).toEqual(["a1", "b1", "a2"]);
  });

  it("level filter is inclusive minimum", () => {
    const store = new DeviceLogsStore();
    store.append({ source: "ios", deviceId: "D", level: "debug", message: "d" });
    store.append({ source: "ios", deviceId: "D", level: "info", message: "i" });
    store.append({ source: "ios", deviceId: "D", level: "warn", message: "w" });
    store.append({ source: "ios", deviceId: "D", level: "error", message: "e" });
    const r = store.list({ level: "warn" }, NO_TAPS);
    expect(r.entries.map((e) => e.message)).toEqual(["w", "e"]);
  });

  it("substring filter is case-sensitive", () => {
    const store = new DeviceLogsStore();
    store.append({ source: "ios", deviceId: "D", level: "info", message: "fetch failed" });
    store.append({ source: "ios", deviceId: "D", level: "info", message: "Fetch failed" });
    const r = store.list({ substring: "fetch" }, NO_TAPS);
    expect(r.entries).toHaveLength(1);
  });

  it("deviceId filter restricts to one ring", () => {
    const store = new DeviceLogsStore();
    store.append({ source: "ios", deviceId: "A", level: "info", message: "a" });
    store.append({ source: "android", deviceId: "B", level: "info", message: "b" });
    const r = store.list({ deviceId: "A" }, NO_TAPS);
    expect(r.entries.map((e) => e.message)).toEqual(["a"]);
  });

  it("clear bumps epoch + drops entries; sequence keeps climbing", () => {
    const store = new DeviceLogsStore();
    store.append({ source: "ios", deviceId: "D", level: "info", message: "before" });
    const before = store.list(undefined, NO_TAPS);
    const seqBefore = before.entries[0]!.sequence;
    const epochBefore = before.meta.bufferEpoch;
    store.clear("D", NO_TAPS);
    store.append({ source: "ios", deviceId: "D", level: "info", message: "after" });
    const after = store.list(undefined, NO_TAPS);
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]!.message).toBe("after");
    expect(after.entries[0]!.sequence).toBeGreaterThan(seqBefore);
    expect(after.meta.bufferEpoch).toBeGreaterThan(epochBefore);
  });

  it("stale cursor → cursorDropped", () => {
    const store = new DeviceLogsStore();
    store.append({ source: "ios", deviceId: "D", level: "info", message: "x" });
    const first = store.list(undefined, NO_TAPS);
    store.clear("D", NO_TAPS);
    store.append({ source: "ios", deviceId: "D", level: "info", message: "y" });
    const after = store.list(
      { since: { bufferEpoch: first.meta.bufferEpoch, sequence: 1 } },
      NO_TAPS,
    );
    expect(after.cursorDropped).toBe(true);
  });

  it("respects ring capacity (eviction)", () => {
    const store = new DeviceLogsStore({ capacity: 3 });
    for (const m of ["1", "2", "3", "4"]) {
      store.append({ source: "ios", deviceId: "D", level: "info", message: m });
    }
    const r = store.list(undefined, NO_TAPS);
    expect(r.entries.map((e) => e.message)).toEqual(["2", "3", "4"]);
    expect(r.meta.evictedCount).toBe(1);
    expect(r.meta.totalLinesReceived).toBe(4);
  });

  it("truncates absurdly long messages", () => {
    const store = new DeviceLogsStore();
    const huge = "x".repeat(64 * 1024 + 100);
    const entry = store.append({ source: "ios", deviceId: "D", level: "info", message: huge });
    expect(entry.message.length).toBe(64 * 1024 + " [truncated]".length);
    expect(entry.message.endsWith(" [truncated]")).toBe(true);
  });
});
