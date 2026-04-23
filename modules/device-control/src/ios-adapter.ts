// iOS adapter — wraps `xcrun simctl` for the booted iOS simulators.
//
// Physical iPhone control requires `idb` or DeviceLink; this adapter
// only handles simulators in v0.1.0. Physical-device coverage is the
// natural Phase 8 scope.

import { execBinary, execBinaryText, execErrorToError } from "./exec.js";
import type { Device, DeviceAdapter, ListOutcome } from "./adapter.js";

export interface IosAdapterOptions {
  /** Inject a mock for the `xcrun simctl` shell — tests funnel through this. */
  runSimctl?: typeof runSimctlDefault;
  /** Override `xcrun` binary (rare — cross-toolchain Xcode installs). */
  xcrunBinary?: string;
}

export function createIosAdapter(options: IosAdapterOptions = {}): DeviceAdapter {
  const runSimctl = options.runSimctl ?? runSimctlDefault;
  const binary = options.xcrunBinary ?? "xcrun";

  async function simctl(argv: readonly string[], timeoutMs?: number): Promise<string> {
    return runSimctl(binary, ["simctl", ...argv], timeoutMs ? { timeoutMs } : undefined);
  }

  async function simctlBuf(argv: readonly string[], timeoutMs?: number): Promise<Buffer> {
    const outcome = await execBinary(
      binary,
      ["simctl", ...argv],
      timeoutMs ? { timeoutMs } : undefined,
    );
    if (outcome.kind === "ok") return outcome.stdout;
    throw execErrorToError(outcome);
  }

  return {
    platform: "ios",

    async list(): Promise<ListOutcome> {
      try {
        const raw = await simctl(["list", "-j", "devices"]);
        return { kind: "ok", devices: parseDevices(raw) };
      } catch (err) {
        return {
          kind: "unavailable",
          reason:
            err instanceof Error ? err.message : "simctl list failed",
        };
      }
    },

    async screenshot(udid) {
      // `simctl io <udid> screenshot -` writes PNG bytes to stdout.
      const png = await simctlBuf(["io", udid, "screenshot", "-"]);
      return { pngBase64: png.toString("base64") };
    },

    async tap(_udid, _x, _y) {
      // simctl has no direct tap. `xcrun simctl ui <udid> appearance` etc.
      // are the closest; for actual input we'd shell `idb` or an Accessibility
      // bridge. Ship "not implemented" for v0.1.0 rather than fake success.
      throw new Error(
        "tap is not implemented for iOS simulators in v0.1.0 — install `idb` and drive via Phase 8 adapter",
      );
    },

    async swipe(_udid, _x1, _y1, _x2, _y2, _durationMs) {
      throw new Error(
        "swipe is not implemented for iOS simulators in v0.1.0",
      );
    },

    async typeText(_udid, _text) {
      throw new Error(
        "text input is not implemented for iOS simulators in v0.1.0 — use the hardware keyboard or Phase 8 adapter",
      );
    },

    async launchApp(udid, bundleId) {
      await simctl(["launch", udid, bundleId]);
    },

    async logsTail(udid, _lines) {
      // simctl doesn't offer a line-count knob; we time-bound with --last
      // and split client-side. `lines` is advisory — we return the whole
      // buffer capped by the shared exec oversize guard.
      const raw = await simctl(
        ["spawn", udid, "log", "show", "--last", "1m", "--style", "compact"],
        20_000,
      );
      return { lines: raw.split("\n").filter((l) => l.length > 0) };
    },

    async uninstallApp(udid, bundleId) {
      await simctl(["uninstall", udid, bundleId]);
    },
  };
}

async function runSimctlDefault(
  binary: string,
  argv: readonly string[],
  options?: { timeoutMs?: number },
): Promise<string> {
  return execBinaryText(binary, argv, options);
}

/**
 * Parse `xcrun simctl list -j devices` output. Top-level shape:
 *   { "devices": { "<runtime>": [ { udid, name, state, isAvailable, ... } ] } }
 *
 * We flatten the runtime buckets into a single Device[]; `runtime` is
 * preserved on each device so the panel + MCP callers can group if they
 * want to.
 */
export function parseDevices(raw: string): Device[] {
  const out: Device[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  const devices = (parsed as Record<string, unknown>)["devices"];
  if (!devices || typeof devices !== "object") return out;
  for (const [runtime, list] of Object.entries(devices as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const rawDevice of list) {
      if (!rawDevice || typeof rawDevice !== "object") continue;
      const d = rawDevice as Record<string, unknown>;
      const udid = typeof d["udid"] === "string" ? d["udid"] : null;
      const name = typeof d["name"] === "string" ? d["name"] : udid;
      if (!udid || !name) continue;
      const state = mapState(typeof d["state"] === "string" ? d["state"] : "");
      out.push({
        udid,
        name,
        platform: "ios",
        state,
        runtime: humanRuntime(runtime),
      });
    }
  }
  return out;
}

function mapState(raw: string): Device["state"] {
  if (raw === "Booted") return "booted";
  if (raw === "Shutdown") return "unavailable";
  return "unknown";
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-17-4` → `iOS 17.4`. */
function humanRuntime(runtimeId: string): string {
  const idx = runtimeId.lastIndexOf(".");
  if (idx === -1) return runtimeId;
  // `iOS-17-4` → `iOS 17.4`. Split the platform prefix off the version
  // digits so the space-vs-dot distinction survives multiple hyphens.
  return runtimeId.slice(idx + 1).replace(/^([A-Za-z]+)-/, "$1 ").replace(/-/g, ".");
}

