import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseAdbDevices, parseSimctlDevices, bootDevice, type Device } from "../device.js";
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

  it("returns false for android devices without spawning simctl", async () => {
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

    expect(result).toBe(false);
    expect(spy).not.toHaveBeenCalled();
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
