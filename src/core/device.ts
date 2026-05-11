import { execAsync, execShellAsync } from "./exec-async.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Device {
  id: string;
  name: string;
  type: "ios" | "android";
  status: "available" | "booted" | "shutdown" | "unauthorized";
  runtime?: string; // iOS only, e.g. "iOS-17-2"
  isPhysical?: boolean; // true for real devices, false/undefined for simulators
}

// ---------------------------------------------------------------------------
// parseAdbDevices
// ---------------------------------------------------------------------------

/**
 * Convention: adb assigns serials starting with `emulator-` to AVDs and
 * arbitrary alphanumeric serials to physical devices. There is no other
 * reliable signal in `adb devices` output to distinguish them.
 */
function isAndroidEmulatorSerial(serial: string): boolean {
  return serial.startsWith("emulator-");
}

/**
 * Parse the text output of `adb devices`.
 *
 * Expected format:
 *   List of devices attached
 *   <serial>\tdevice
 *   <serial>\tunauthorized
 */
export function parseAdbDevices(output: string): Device[] {
  const devices: Device[] = [];

  for (const line of output.split("\n")) {
    const trimmed = line.trim();

    // Skip the header line and empty lines
    if (!trimmed || trimmed.startsWith("List of devices")) {
      continue;
    }

    // Each device line is:  <serial>\t<state>
    const tabIndex = trimmed.lastIndexOf("\t");
    if (tabIndex === -1) {
      continue;
    }

    const serial = trimmed.slice(0, tabIndex).trim();
    const state = trimmed.slice(tabIndex + 1).trim();

    if (state === "device") {
      devices.push({
        id: serial,
        name: serial,
        type: "android",
        status: "available",
        isPhysical: !isAndroidEmulatorSerial(serial),
      });
    } else if (state === "unauthorized") {
      devices.push({
        id: serial,
        name: serial,
        type: "android",
        status: "unauthorized",
        isPhysical: !isAndroidEmulatorSerial(serial),
      });
    }
    // Ignore offline, no permissions, etc.
  }

  return devices;
}

// ---------------------------------------------------------------------------
// enrichAndroidNames — upgrade serials to friendly names via per-device adb
// ---------------------------------------------------------------------------

async function probe(cmd: string, timeout = 5000): Promise<string> {
  try {
    const out = await execAsync(cmd, { timeout });
    return out.split("\n")[0]?.trim() ?? "";
  } catch {
    return "";
  }
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Replace each Android device's serial-as-name with a human-friendly label.
 * Best-effort — falls back to the serial on any adb failure or timeout.
 *
 *  - Physical: prefers `ro.product.marketname` (Samsung-specific but very
 *    user-friendly when present), falls back to "<manufacturer> <model>".
 *  - Emulator: uses `adb emu avd name` (the AVD name), with underscores
 *    replaced by spaces for display.
 *
 * Per-device probes run in parallel so the wizard's device step doesn't
 * stall even with several attached devices.
 */
export async function enrichAndroidNames(devices: Device[]): Promise<Device[]> {
  return Promise.all(
    devices.map(async (d): Promise<Device> => {
      if (d.type !== "android") return d;

      if (d.isPhysical === false) {
        const avd = await probe(`adb -s ${d.id} emu avd name`);
        return avd ? { ...d, name: avd.replace(/_/g, " ") } : d;
      }

      const market = await probe(
        `adb -s ${d.id} shell getprop ro.product.marketname`,
      );
      if (market) return { ...d, name: market };

      const [manufacturer, model] = await Promise.all([
        probe(`adb -s ${d.id} shell getprop ro.product.manufacturer`),
        probe(`adb -s ${d.id} shell getprop ro.product.model`),
      ]);
      const friendly = [capitalize(manufacturer), model].filter(Boolean).join(" ");
      return friendly ? { ...d, name: friendly } : d;
    }),
  );
}

// ---------------------------------------------------------------------------
// parseSimctlDevices
// ---------------------------------------------------------------------------

const SIMRUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.";
const IOS_RUNTIME_RE = /^iOS-/i;

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
}

interface SimctlOutput {
  devices: Record<string, SimctlDevice[]>;
}

/**
 * Parse the JSON output of `xcrun simctl list devices --json`.
 *
 * - Skips devices where `isAvailable` is false.
 * - Only includes iOS simulators (runtime key starts with "iOS-" after
 *   stripping the CoreSimulator prefix).
 * - Maps state "Booted" → status "booted"; everything else → "shutdown".
 * - Attaches the short runtime name (e.g. "iOS-17-2") to each device.
 */
export function parseSimctlDevices(jsonOutput: string): Device[] {
  const parsed = JSON.parse(jsonOutput) as SimctlOutput;
  const devices: Device[] = [];

  for (const [runtimeKey, simulators] of Object.entries(parsed.devices)) {
    // Strip the CoreSimulator prefix to get e.g. "iOS-17-2" or "watchOS-10-0"
    const runtime = runtimeKey.startsWith(SIMRUNTIME_PREFIX)
      ? runtimeKey.slice(SIMRUNTIME_PREFIX.length)
      : runtimeKey;

    // Only include iOS simulators
    if (!IOS_RUNTIME_RE.test(runtime)) {
      continue;
    }

    for (const sim of simulators) {
      if (!sim.isAvailable) {
        continue;
      }

      devices.push({
        id: sim.udid,
        name: sim.name,
        type: "ios",
        status: sim.state === "Booted" ? "booted" : "shutdown",
        runtime,
      });
    }
  }

  return devices;
}

// ---------------------------------------------------------------------------
// listDevices
// ---------------------------------------------------------------------------

/**
 * Discover connected/available devices by calling the real platform tools.
 * Catches errors gracefully if `adb` or `xcrun` are not installed.
 */
export async function listDevices(platform: "ios" | "android" | "both"): Promise<Device[]> {
  const devices: Device[] = [];

  if (platform === "android" || platform === "both") {
    try {
      const output = await execAsync("adb devices", {
        timeout: 15000, // 15s max
      });
      const parsed = parseAdbDevices(output);
      devices.push(...(await enrichAndroidNames(parsed)));
    } catch {
      // adb not available, timed out, or failed
    }
  }

  if (platform === "ios" || platform === "both") {
    // Physical devices via xctrace
    try {
      const output = await execAsync("xcrun xctrace list devices", {
        timeout: 15000,
      });
      devices.push(...parseXctraceDevices(output));
    } catch {
      // xctrace not available
    }

    // Simulators via simctl
    try {
      const output = await execAsync("xcrun simctl list devices --json", {
        timeout: 30000,
      });
      devices.push(...parseSimctlDevices(output));
    } catch {
      // xcrun not available, timed out, or failed
    }
  }

  return devices;
}

// ---------------------------------------------------------------------------
// parseXctraceDevices — physical iOS devices from `xcrun xctrace list devices`
// ---------------------------------------------------------------------------

/**
 * Parse output of `xcrun xctrace list devices` to find physical iOS devices.
 * Format: "Device Name (OS Version) (UDID)"
 */
export function parseXctraceDevices(output: string): Device[] {
  const devices: Device[] = [];
  const lines = output.split("\n");
  let inDevicesSection = false;
  let inOfflineSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "== Devices ==") {
      inDevicesSection = true;
      inOfflineSection = false;
      continue;
    }
    if (trimmed === "== Devices Offline ==") {
      inDevicesSection = false;
      inOfflineSection = true;
      continue;
    }
    if (trimmed === "== Simulators ==") {
      // Stop — we get simulators from simctl instead
      break;
    }

    if (!inDevicesSection && !inOfflineSection) continue;
    if (!trimmed) continue;

    // Match: "Device Name (OS Version) (UDID)"
    const match = trimmed.match(/^(.+?)\s+\(([^)]+)\)\s+\(([0-9A-Fa-f-]+)\)$/);
    if (match) {
      const [, name, version, udid] = match;
      // Skip Macs and Apple Watches
      if (name.includes("MacBook") || name.includes("Mac ") || name.includes("Apple Watch")) continue;

      devices.push({
        id: udid,
        name: name.trim(),
        type: "ios",
        status: inOfflineSection ? "shutdown" : "available",
        runtime: `iOS-${version.replace(/\./g, "-")}`,
        isPhysical: true,
      });
    }
  }

  return devices;
}

// ---------------------------------------------------------------------------
// bootDevice
// ---------------------------------------------------------------------------

/**
 * Boot an iOS simulator. Returns true on success, false on failure.
 * Physical devices are a no-op: they connect via USB/network and have nothing to boot.
 */
export async function bootDevice(device: Device): Promise<boolean> {
  if (device.type !== "ios") {
    return false;
  }
  if (device.isPhysical) {
    return true;
  }

  try {
    await execShellAsync(`xcrun simctl boot ${device.id}`, {
      timeout: 30000,
    });
    return true;
  } catch {
    return false;
  }
}
