import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseAdbDevices,
  parseSimctlDevices,
  parseAvdList,
  listDevices,
  bootDevice,
  setEmulatorSpawner,
  type Device,
} from "../device.js";
import * as execAsync from "../exec-async.js";

// ---------------------------------------------------------------------------
// parseAdbDevices
// ---------------------------------------------------------------------------

describe("parseAdbDevices", () => {
  it("parses normal output with device and unauthorized entries", () => {
    const output = [
      "List of devices attached",
      "emulator-5554\tdevice",
      "R58M31YXXXXX\tdevice",
      "ZX1G22BXXXXX\tunauthorized",
    ].join("\n");

    const devices = parseAdbDevices(output);

    expect(devices).toHaveLength(3);

    expect(devices[0]).toMatchObject({
      id: "emulator-5554",
      name: "emulator-5554",
      type: "android",
      status: "available",
      isPhysical: false,
    });

    expect(devices[1]).toMatchObject({
      id: "R58M31YXXXXX",
      name: "R58M31YXXXXX",
      type: "android",
      status: "available",
      isPhysical: true,
    });

    expect(devices[2]).toMatchObject({
      id: "ZX1G22BXXXXX",
      name: "ZX1G22BXXXXX",
      type: "android",
      status: "unauthorized",
      isPhysical: true,
    });
  });

  it("flags emulator-prefixed serials as virtual and bare alphanumeric serials as physical", () => {
    // Documents the assumption load-bearing for the wizard's UI labels —
    // adb's only reliable signal for emulator-vs-phone is the `emulator-`
    // prefix on the serial.
    const output = [
      "List of devices attached",
      "emulator-5554\tdevice",
      "emulator-5556\tdevice",
      "R5CX23WBLKE\tdevice",
      "ZY222ABCDE\tunauthorized",
    ].join("\n");

    const devices = parseAdbDevices(output);

    expect(devices.map((d) => ({ id: d.id, isPhysical: d.isPhysical }))).toEqual([
      { id: "emulator-5554", isPhysical: false },
      { id: "emulator-5556", isPhysical: false },
      { id: "R5CX23WBLKE", isPhysical: true },
      { id: "ZY222ABCDE", isPhysical: true },
    ]);
  });

  it("handles empty output (just header line)", () => {
    const output = "List of devices attached\n";
    const devices = parseAdbDevices(output);
    expect(devices).toHaveLength(0);
  });

  it("ignores lines that are not device entries", () => {
    const output = [
      "List of devices attached",
      "* daemon not running; starting now at tcp:5037",
      "* daemon started successfully",
      "emulator-5554\tdevice",
    ].join("\n");

    const devices = parseAdbDevices(output);
    expect(devices).toHaveLength(1);
    expect(devices[0].id).toBe("emulator-5554");
  });
});

// ---------------------------------------------------------------------------
// parseSimctlDevices
// ---------------------------------------------------------------------------

describe("parseSimctlDevices", () => {
  const sampleJson = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-17-2": [
        {
          udid: "AAAAAAAA-0000-0000-0000-AAAAAAAAAAAA",
          name: "iPhone 15",
          state: "Booted",
          isAvailable: true,
        },
        {
          udid: "BBBBBBBB-0000-0000-0000-BBBBBBBBBBBB",
          name: "iPhone 15 Pro",
          state: "Shutdown",
          isAvailable: true,
        },
        {
          udid: "CCCCCCCC-0000-0000-0000-CCCCCCCCCCCC",
          name: "iPhone SE (3rd generation)",
          state: "Shutdown",
          isAvailable: false,
        },
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-16-4": [
        {
          udid: "DDDDDDDD-0000-0000-0000-DDDDDDDDDDDD",
          name: "iPhone 14",
          state: "Shutdown",
          isAvailable: true,
        },
      ],
      "com.apple.CoreSimulator.SimRuntime.watchOS-10-0": [
        {
          udid: "EEEEEEEE-0000-0000-0000-EEEEEEEEEEEE",
          name: "Apple Watch Series 9",
          state: "Shutdown",
          isAvailable: true,
        },
      ],
    },
  });

  it("filters out unavailable devices", () => {
    const devices = parseSimctlDevices(sampleJson);
    const ids = devices.map((d) => d.id);
    expect(ids).not.toContain("CCCCCCCC-0000-0000-0000-CCCCCCCCCCCC");
  });

  it("maps Booted state to status 'booted'", () => {
    const devices = parseSimctlDevices(sampleJson);
    const booted = devices.find(
      (d) => d.id === "AAAAAAAA-0000-0000-0000-AAAAAAAAAAAA"
    );
    expect(booted).toBeDefined();
    expect(booted!.status).toBe("booted");
    expect(booted!.type).toBe("ios");
  });

  it("maps Shutdown state to status 'shutdown'", () => {
    const devices = parseSimctlDevices(sampleJson);
    const shutdown = devices.find(
      (d) => d.id === "BBBBBBBB-0000-0000-0000-BBBBBBBBBBBB"
    );
    expect(shutdown).toBeDefined();
    expect(shutdown!.status).toBe("shutdown");
  });

  it("extracts runtime name by stripping the CoreSimulator prefix", () => {
    const devices = parseSimctlDevices(sampleJson);
    const device = devices.find(
      (d) => d.id === "AAAAAAAA-0000-0000-0000-AAAAAAAAAAAA"
    );
    expect(device!.runtime).toBe("iOS-17-2");
  });

  it("returns only iOS devices (skips watchOS, tvOS, etc.)", () => {
    // watchOS entry EEEEEEEE should not be included because its runtime key
    // does not start with iOS
    const devices = parseSimctlDevices(sampleJson);
    const watchDevice = devices.find(
      (d) => d.id === "EEEEEEEE-0000-0000-0000-EEEEEEEEEEEE"
    );
    expect(watchDevice).toBeUndefined();
  });

  it("parses JSON with multiple runtimes and returns all available iOS devices", () => {
    const devices = parseSimctlDevices(sampleJson);
    // Available iOS: iPhone 15 (booted), iPhone 15 Pro (shutdown), iPhone 14 (shutdown)
    // Filtered out: iPhone SE (isAvailable=false), Apple Watch (watchOS)
    expect(devices).toHaveLength(3);
  });

  it("handles an empty devices object", () => {
    const json = JSON.stringify({ devices: {} });
    const devices = parseSimctlDevices(json);
    expect(devices).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// bootDevice
// ---------------------------------------------------------------------------

describe("bootDevice", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true without spawning simctl for physical iPhones", async () => {
    const spy = vi
      .spyOn(execAsync, "execShellAsync")
      .mockResolvedValue("");

    const physical: Device = {
      id: "00008130-001A653A3E11001C",
      name: "Martin Couso's iPhone 15",
      type: "ios",
      status: "shutdown",
      isPhysical: true,
    };

    const result = await bootDevice(physical);

    expect(result).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("no-ops (returns true) for an already-attached Android device", async () => {
    // `emulator-5554` is visible to adb → nothing to boot; bootDevice
    // reports success without ever shelling out to simctl.
    const spy = vi
      .spyOn(execAsync, "execShellAsync")
      .mockResolvedValue("");

    const android: Device = {
      id: "emulator-5554",
      name: "emulator-5554",
      type: "android",
      status: "available",
    };

    const result = await bootDevice(android);

    expect(result).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("launches `emulator -avd <name>` for a cold AVD (id starts with avd:)", async () => {
    // Regression: bug 2026-08-20 — a stopped AVD showed "Device not found"
    // from boot-device because listDevices didn't surface cold AVDs at all.
    // Now they surface as `avd:<name>` and bootDevice spawns them.
    const shellSpy = vi
      .spyOn(execAsync, "execShellAsync")
      .mockResolvedValue("");
    const spawnCalls: string[] = [];
    setEmulatorSpawner((avdName) => {
      spawnCalls.push(avdName);
      return { unref: () => {} };
    });

    const avd: Device = {
      id: "avd:Pixel_6a_API_35",
      name: "Pixel 6a API 35",
      type: "android",
      status: "shutdown",
      isPhysical: false,
      avdName: "Pixel_6a_API_35",
    };

    try {
      const result = await bootDevice(avd);
      expect(result).toBe(true);
      expect(shellSpy).not.toHaveBeenCalled();
      expect(spawnCalls).toEqual(["Pixel_6a_API_35"]);
    } finally {
      setEmulatorSpawner(null);
    }
  });

  it("rejects an AVD id whose name contains shell metacharacters", async () => {
    let spawned = false;
    setEmulatorSpawner(() => {
      spawned = true;
      return { unref: () => {} };
    });
    try {
      const evil: Device = {
        id: "avd:foo;rm -rf /",
        name: "evil",
        type: "android",
        status: "shutdown",
      };
      expect(await bootDevice(evil)).toBe(false);
      expect(spawned).toBe(false);
    } finally {
      setEmulatorSpawner(null);
    }
  });

  it("invokes simctl boot for iOS simulators", async () => {
    const spy = vi
      .spyOn(execAsync, "execShellAsync")
      .mockResolvedValue("");

    const sim: Device = {
      id: "AAAAAAAA-0000-0000-0000-AAAAAAAAAAAA",
      name: "iPhone 15",
      type: "ios",
      status: "shutdown",
      isPhysical: false,
    };

    const result = await bootDevice(sim);

    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toContain("xcrun simctl boot");
    expect(spy.mock.calls[0]?.[0]).toContain(sim.id);
  });
});

// ---------------------------------------------------------------------------
// parseAvdList
// ---------------------------------------------------------------------------

describe("parseAvdList", () => {
  it("returns one name per line", () => {
    expect(parseAvdList("Pixel_6a_API_35\nPixel_Tablet_API_34\n")).toEqual([
      "Pixel_6a_API_35",
      "Pixel_Tablet_API_34",
    ]);
  });

  it("skips blank lines and log preamble that the emulator binary prints", () => {
    // A misconfigured Android SDK prints INFO/WARNING lines above the AVD
    // list; those contain spaces or brackets and must not be treated as
    // AVD names.
    const output = [
      "INFO    | Storing crashdata in: /tmp/foo",
      "WARNING: obsolete AVD system-image; upgrade recommended",
      "",
      "Pixel_6a_API_35",
    ].join("\n");
    expect(parseAvdList(output)).toEqual(["Pixel_6a_API_35"]);
  });

  it("returns [] when the output is empty", () => {
    expect(parseAvdList("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listDevices — Android surface (adb + emulator -list-avds merge)
// ---------------------------------------------------------------------------

describe("listDevices — Android", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces cold AVDs as `shutdown` entries when none are attached", async () => {
    // Regression: bug reported 2026-08-20 — user's only Android target was
    // a powered-off AVD and the wizard rendered an empty device list. The
    // fix is to merge `emulator -list-avds` output into the Android side
    // the way `simctl` already covers iOS.
    const spy = vi
      .spyOn(execAsync, "execAsync")
      .mockImplementation(async (cmd: string) => {
        if (cmd === "adb devices") return "List of devices attached\n";
        if (cmd === "emulator -list-avds") return "Pixel_6a_API_35\n";
        throw new Error(`unexpected cmd: ${cmd}`);
      });

    const devices = await listDevices("android");
    expect(spy).toHaveBeenCalledWith("adb devices", expect.anything());
    expect(spy).toHaveBeenCalledWith(
      "emulator -list-avds",
      expect.anything(),
    );
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: "avd:Pixel_6a_API_35",
      name: "Pixel 6a API 35",
      type: "android",
      status: "shutdown",
      isPhysical: false,
      avdName: "Pixel_6a_API_35",
    });
  });

  it("dedupes a cold AVD whose emulator is already running", async () => {
    // enrichAndroidNames sets `avdName` on the running emulator entry; the
    // merge drops any cold AVD whose name matches, so the same AVD doesn't
    // show up twice.
    vi.spyOn(execAsync, "execAsync").mockImplementation(async (cmd: string) => {
      if (cmd === "adb devices") {
        return "List of devices attached\nemulator-5554\tdevice\n";
      }
      if (cmd === "adb -s emulator-5554 emu avd name") {
        return "Pixel_6a_API_35\n";
      }
      if (cmd === "emulator -list-avds") {
        return "Pixel_6a_API_35\nPixel_Tablet_API_34\n";
      }
      // enrichAndroidNames' physical-only getprop probes should not fire.
      throw new Error(`unexpected cmd: ${cmd}`);
    });

    const devices = await listDevices("android");
    expect(devices.map((d) => d.id).sort()).toEqual([
      "avd:Pixel_Tablet_API_34",
      "emulator-5554",
    ]);
  });

  it("keeps working when `emulator` is not on PATH (no Android SDK)", async () => {
    vi.spyOn(execAsync, "execAsync").mockImplementation(async (cmd: string) => {
      if (cmd === "adb devices") return "List of devices attached\n";
      if (cmd === "emulator -list-avds") throw new Error("command not found");
      throw new Error(`unexpected cmd: ${cmd}`);
    });
    const devices = await listDevices("android");
    expect(devices).toEqual([]);
  });
});
