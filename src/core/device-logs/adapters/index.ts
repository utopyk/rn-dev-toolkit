/**
 * Default `SpawnAdapter` for the TapManager — dispatches by platform.
 * The TapManager constructor now accepts `createDefaultSpawnAdapter()`
 * in production; tests inject a fake instead.
 */

import type { DeviceLogsStore } from "../buffer.js";
import type { DeviceLogsStartTapArgs } from "../host-capability.js";
import type { SpawnAdapter, SpawnHandle } from "../tap-manager.js";
import { androidSpawnAdapter } from "./android.js";
import { iosSpawnAdapter } from "./ios.js";

export function createDefaultSpawnAdapter(): SpawnAdapter {
  return {
    async start(args: DeviceLogsStartTapArgs, store: DeviceLogsStore): Promise<SpawnHandle> {
      if (args.platform === "ios") return iosSpawnAdapter.start(args, store);
      if (args.platform === "android") return androidSpawnAdapter.start(args, store);
      throw new Error(`device-logs: unsupported platform "${String(args.platform)}"`);
    },
  };
}
