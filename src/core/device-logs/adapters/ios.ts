/**
 * iOS tap adapter — dispatches by `simulator` flag:
 *   - true  → `xcrun simctl spawn <udid> log stream --style ndjson [predicate]`
 *   - false → `idevicesyslog -u <udid> [-p <bundleProcessName>]`
 *
 * idevicesyslog requires libimobiledevice (`brew install libimobiledevice`).
 * simctl ships with Xcode.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceLogsStore } from "../buffer.js";
import { parseIosSyslogLine } from "../parsers/ios-syslog.js";
import { parseIosSimctlLine } from "../parsers/ios-simctl.js";
import type { DeviceLogsStartTapArgs } from "../host-capability.js";
import type { SpawnAdapter, SpawnHandle } from "../tap-manager.js";
import { createLineTap } from "./spawn-helper.js";

const execFileP = promisify(execFile);

async function resolveCmd(name: string, installHint: string): Promise<string> {
  try {
    const { stdout } = await execFileP("which", [name]);
    const p = stdout.trim();
    if (!p) throw new Error("not found");
    return p;
  } catch {
    throw new Error(`${name} not on PATH — ${installHint}`);
  }
}

const resolveIdevicesyslog = () =>
  resolveCmd("idevicesyslog", "run `brew install libimobiledevice`");
const resolveXcrun = () =>
  resolveCmd("xcrun", "install Xcode + run `xcode-select --install`");

export const iosSpawnAdapter: SpawnAdapter = {
  async start(args: DeviceLogsStartTapArgs, store: DeviceLogsStore): Promise<SpawnHandle> {
    if (args.platform !== "ios") {
      throw new Error("iosSpawnAdapter received non-ios args");
    }
    const deviceId = args.deviceId;

    if (args.simulator) {
      // Simulator: `xcrun simctl spawn <udid> log stream --style ndjson`.
      // Predicate filters by subsystem when bundleId supplied — the
      // subsystem of an RN app is conventionally the bundle id, but
      // SDKs/Apple system messages have their own subsystems so an
      // unfiltered predicate may be desirable; the bundle filter is
      // applied only when bundleId is present.
      const xcrun = await resolveXcrun();
      const cmdArgs: string[] = ["simctl", "spawn", args.deviceId, "log", "stream", "--style", "ndjson"];
      if (args.bundleId) {
        cmdArgs.push("--predicate", `subsystem CONTAINS "${args.bundleId}"`);
      }
      return createLineTap({
        cmd: xcrun,
        args: cmdArgs,
        store,
        parseLine: (line) => parseIosSimctlLine({ line, deviceId }) ?? null,
      });
    }

    // Physical device via libimobiledevice.
    const idevicesyslog = await resolveIdevicesyslog();
    const cmdArgs: string[] = ["-u", args.deviceId, "--no-colors"];
    if (args.bundleId) {
      // idevicesyslog -p filters by process name. For an RN app, the
      // process name is typically the executable basename (which is
      // usually the product name, not the bundle id). We pass the
      // bundle id anyway as a best-effort hint — if it doesn't match
      // exactly, the user gets nothing and learns to drop the filter.
      // Phase 3 could resolve process name via `ideviceinstaller`.
      cmdArgs.push("-p", args.bundleId);
    }
    return createLineTap({
      cmd: idevicesyslog,
      args: cmdArgs,
      store,
      parseLine: (line) => parseIosSyslogLine({ line, deviceId }) ?? null,
    });
  },
};
