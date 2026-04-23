import { describe, expect, it, vi } from "vitest";
import { createIosAdapter, parseDevices } from "../ios-adapter.js";

describe("parseDevices (iOS)", () => {
  it("flattens runtime buckets into a single Device[]", () => {
    const raw = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-4": [
          {
            udid: "AAAA-1111",
            name: "iPhone 15",
            state: "Booted",
            isAvailable: true,
          },
          {
            udid: "BBBB-2222",
            name: "iPhone 15 Pro",
            state: "Shutdown",
            isAvailable: true,
          },
        ],
        "com.apple.CoreSimulator.SimRuntime.iOS-17-0": [
          {
            udid: "CCCC-3333",
            name: "iPhone 14",
            state: "Shutdown",
            isAvailable: true,
          },
        ],
      },
    });
    const devices = parseDevices(raw);
    expect(devices).toHaveLength(3);
    expect(devices[0]).toMatchObject({
      udid: "AAAA-1111",
      name: "iPhone 15",
      platform: "ios",
      state: "booted",
    });
    expect(devices[1]?.state).toBe("unavailable");
  });

  it("returns [] for malformed JSON", () => {
    expect(parseDevices("not json")).toEqual([]);
  });

  it("skips devices missing udid; falls back to udid when name is missing", () => {
    const raw = JSON.stringify({
      devices: {
        "runtime": [
          { udid: "AAAA-1111", name: "ok", state: "Booted" },
          { udid: "BBBB-2222" }, // missing name — fall back
          { name: "no-udid", state: "Booted" }, // skip
        ],
      },
    });
    const devices = parseDevices(raw);
    expect(devices).toHaveLength(2);
    expect(devices[1]).toMatchObject({ udid: "BBBB-2222", name: "BBBB-2222" });
  });
});

describe("IosAdapter (via runSimctl stub)", () => {
  it("list() returns 'unavailable' when simctl throws", async () => {
    const adapter = createIosAdapter({
      runSimctl: async () => {
        throw new Error("xcrun: command not found");
      },
    });
    const result = await adapter.list();
    expect(result.kind).toBe("unavailable");
  });

  it("launchApp() invokes `simctl launch <udid> <bundleId>`", async () => {
    const runSimctl = vi.fn(async () => "");
    const adapter = createIosAdapter({ runSimctl });
    await adapter.launchApp("AAAA", "com.example.app");
    expect(runSimctl).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "launch", "AAAA", "com.example.app"],
      undefined,
    );
  });

  it("tap() throws because simctl has no tap primitive", async () => {
    const adapter = createIosAdapter({ runSimctl: async () => "" });
    await expect(adapter.tap("AAAA", 10, 20)).rejects.toThrow(/not implemented/);
  });

  it("typeText() also throws (simctl has no text-input primitive)", async () => {
    const adapter = createIosAdapter({ runSimctl: async () => "" });
    await expect(adapter.typeText("AAAA", "hello")).rejects.toThrow(/not implemented/);
  });

  it("humanRuntime maps iOS-17-4 → 'iOS 17.4' on parsed entries", () => {
    const raw = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-4": [
          { udid: "AAAA", name: "iPhone 15", state: "Booted" },
        ],
      },
    });
    const devices = parseDevices(raw);
    expect(devices[0]?.runtime).toBe("iOS 17.4");
  });

  it("uninstallApp() invokes `simctl uninstall`", async () => {
    const runSimctl = vi.fn(async () => "");
    const adapter = createIosAdapter({ runSimctl });
    await adapter.uninstallApp("AAAA", "com.example.app");
    expect(runSimctl).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "uninstall", "AAAA", "com.example.app"],
      undefined,
    );
  });
});
