/**
 * Android tap adapter — spawns `adb -s <serial> logcat -v threadtime`
 * filtered to the target package's PID when supplied.
 *
 * PID filter: we resolve once via `adb -s <serial> shell pidof <package>`
 * and pass --pid to logcat. If the app isn't running yet, we omit the
 * filter and let the user see everything until the app starts. The
 * caller can restart the tap once the app launches to add the filter.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceLogsStore } from "../buffer.js";
import { parseAndroidLine } from "../parsers/android-logcat.js";
import type {
  DeviceLogsStartTapArgs,
} from "../host-capability.js";
import type { SpawnAdapter, SpawnHandle } from "../tap-manager.js";
import { createLineTap } from "./spawn-helper.js";

const execFileP = promisify(execFile);

/** Resolve the path to adb. Throws if not found — the caller surfaces
 *  this as the tap-descriptor `error`. */
async function resolveAdb(): Promise<string> {
  try {
    const { stdout } = await execFileP("which", ["adb"]);
    const p = stdout.trim();
    if (!p) throw new Error("not found");
    return p;
  } catch {
    throw new Error(
      "adb not on PATH — install Android Platform Tools or add `~/Library/Android/sdk/platform-tools` to PATH",
    );
  }
}

/** Best-effort pidof. Returns -1 when the app isn't running, the device
 *  is offline, or pidof isn't available on the target's android build. */
async function pidofPackage(
  adb: string,
  serial: string,
  pkg: string,
): Promise<number> {
  try {
    const { stdout } = await execFileP(adb, ["-s", serial, "shell", "pidof", pkg], {
      timeout: 4000,
    });
    const first = stdout.trim().split(/\s+/)[0];
    const n = Number(first);
    return Number.isFinite(n) && n > 0 ? n : -1;
  } catch {
    return -1;
  }
}

export const androidSpawnAdapter: SpawnAdapter = {
  async start(args: DeviceLogsStartTapArgs, store: DeviceLogsStore): Promise<SpawnHandle> {
    if (args.platform !== "android") {
      throw new Error("androidSpawnAdapter received non-android args");
    }
    const adb = await resolveAdb();

    // Build args — `-v threadtime` is the standard parseable format,
    // `-T 1` starts at the most-recent line so we don't drown in
    // history on startup. Package filter applied via --pid when available.
    const adbArgs: string[] = ["-s", args.deviceId, "logcat", "-v", "threadtime", "-T", "1"];

    if (args.packageName) {
      const pid = await pidofPackage(adb, args.deviceId, args.packageName);
      if (pid > 0) {
        adbArgs.push(`--pid=${pid}`);
      }
      // If pid resolution failed, we still tap — the user sees noise
      // until the app starts; better than failing the tap entirely.
    }

    const deviceId = args.deviceId;
    return createLineTap({
      cmd: adb,
      args: adbArgs,
      store,
      parseLine: (line) => {
        const parsed = parseAndroidLine({ line, deviceId });
        return parsed ?? null;
      },
      onStderr: (line) => {
        // adb prints status to stderr (`waiting for device`, etc.) —
        // captured silently here. The tap descriptor's status would
        // need refinement to surface these mid-run; out of scope for v1.
        // Drop the unused parameter so noUnusedLocals doesn't complain.
        void line;
      },
    });
  },
};
