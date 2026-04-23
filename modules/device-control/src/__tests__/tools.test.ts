import { describe, expect, it, vi } from "vitest";
import type { Device, DeviceAdapter, Platform } from "../adapter.js";
import {
  installApk,
  launchApp,
  list,
  logsTail,
  screenshot,
  tap,
  typeText,
} from "../tools.js";

function stubAdapter(partial: Partial<DeviceAdapter> & { platform: Platform }): DeviceAdapter {
  return {
    list: async () => ({ kind: "ok", devices: [] }),
    screenshot: async () => ({ pngBase64: "" }),
    tap: async () => undefined,
    swipe: async () => undefined,
    typeText: async () => undefined,
    launchApp: async () => undefined,
    logsTail: async () => ({ lines: [] }),
    uninstallApp: async () => undefined,
    ...partial,
  } as DeviceAdapter;
}

describe("list()", () => {
  it("merges android + ios devices + surfaces warnings", async () => {
    const android = stubAdapter({
      platform: "android",
      list: async () => ({
        kind: "ok",
        devices: [
          { udid: "em-1", name: "Pixel", platform: "android", state: "booted" },
        ],
      }),
    });
    const ios = stubAdapter({
      platform: "ios",
      list: async () => ({ kind: "unavailable", reason: "xcrun not found" }),
    });
    const result = await list(
      { platform: "both" },
      { getAdapter: (p) => (p === "android" ? android : ios) },
    );
    expect(result.devices).toHaveLength(1);
    expect(result.warnings).toEqual([
      { platform: "ios", reason: "xcrun not found" },
    ]);
  });

  it("honors `platform: 'android'` filter", async () => {
    const ios = stubAdapter({
      platform: "ios",
      list: async () => {
        throw new Error("should not be called");
      },
    });
    const android = stubAdapter({
      platform: "android",
      list: async () => ({ kind: "ok", devices: [] }),
    });
    await list(
      { platform: "android" },
      { getAdapter: (p) => (p === "android" ? android : ios) },
    );
  });
});

describe("screenshot() / tap() / type()", () => {
  const device: Device = {
    udid: "em-1",
    name: "Pixel",
    platform: "android",
    state: "booted",
  };

  function depsWith(adapter: DeviceAdapter) {
    return {
      getAdapter: (p: Platform) => (p === adapter.platform ? adapter : null),
      resolveUdid: async () => adapter.platform,
    };
  }

  it("screenshot() dispatches to the matching adapter", async () => {
    const adapter = stubAdapter({
      platform: "android",
      screenshot: vi.fn(async () => ({ pngBase64: "abc" })),
    });
    const { pngBase64 } = await screenshot({ udid: device.udid }, depsWith(adapter));
    expect(pngBase64).toBe("abc");
    expect(adapter.screenshot).toHaveBeenCalledWith("em-1");
  });

  it("tap() threads x, y to the adapter", async () => {
    const adapter = stubAdapter({
      platform: "android",
      tap: vi.fn(async () => undefined),
    });
    await tap({ udid: device.udid, x: 100, y: 200 }, depsWith(adapter));
    expect(adapter.tap).toHaveBeenCalledWith("em-1", 100, 200);
  });

  it("typeText() threads text verbatim", async () => {
    const adapter = stubAdapter({
      platform: "android",
      typeText: vi.fn(async () => undefined),
    });
    await typeText({ udid: device.udid, text: "hi there" }, depsWith(adapter));
    expect(adapter.typeText).toHaveBeenCalledWith("em-1", "hi there");
  });

  it("logsTail() passes the lines count", async () => {
    const adapter = stubAdapter({
      platform: "android",
      logsTail: vi.fn(async () => ({ lines: ["a", "b"] })),
    });
    const { lines } = await logsTail(
      { udid: device.udid, lines: 42 },
      depsWith(adapter),
    );
    expect(lines).toEqual(["a", "b"]);
    expect(adapter.logsTail).toHaveBeenCalledWith("em-1", 42);
  });

  it("launchApp() demands applicationId on Android", async () => {
    const adapter = stubAdapter({
      platform: "android",
      launchApp: async () => undefined,
    });
    await expect(
      launchApp({ udid: device.udid }, depsWith(adapter)),
    ).rejects.toThrow(/applicationId/);
  });

  it("launchApp() demands bundleId on iOS", async () => {
    const adapter = stubAdapter({
      platform: "ios",
      launchApp: async () => undefined,
    });
    await expect(
      launchApp(
        { udid: "ios-1" },
        {
          getAdapter: (p) => (p === "ios" ? adapter : null),
          resolveUdid: async () => "ios",
        },
      ),
    ).rejects.toThrow(/bundleId/);
  });

  it("install-apk rejects non-android devices", async () => {
    const adapter = stubAdapter({
      platform: "ios",
      installApp: async () => undefined,
    });
    await expect(
      installApk(
        { udid: "ios-1", apkPath: "/tmp/x.apk" },
        {
          getAdapter: () => adapter,
          resolveUdid: async () => "ios",
        },
      ),
    ).rejects.toThrow(/Android/);
  });

  it("screenshot() throws when udid can't be resolved to a platform", async () => {
    await expect(
      screenshot(
        { udid: "ghost" },
        {
          getAdapter: () => null,
          resolveUdid: async () => null,
        },
      ),
    ).rejects.toThrow(/not currently connected/);
  });
});
