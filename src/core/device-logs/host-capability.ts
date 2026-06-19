/**
 * Host capability for the `@rn-dev-modules/device-logs` 3p module.
 *
 * Registered in `startServicesAsync` alongside the other capabilities.
 * Permissions mirror the metro-logs pattern: `device:logs:read` for
 * status/list, `device:logs:mutate` for clear, `device:logs:tap` for
 * start-tap / stop-tap (these spawn external CLIs).
 *
 * Scoping: unlike `metro-logs` (per-worktree), device-logs is GLOBAL —
 * devices outlive sessions and a single physical device can be shared
 * across worktrees. The capability delegates store reads to a single
 * `DeviceLogsStore` instance and start/stop calls to a `TapManager`.
 */

import type { DeviceLogsStore } from "./buffer.js";
import type { TapManager } from "./tap-manager.js";
import type {
  DeviceLogsFilter,
  DeviceLogsListResult,
  DeviceLogsMeta,
  DeviceLogsStatus,
  DeviceLogsTap,
  DeviceLogSource,
} from "./types.js";

export const DEVICE_LOGS_CAPABILITY_ID = "device-logs" as const;

export const DEVICE_LOGS_CAPABILITY_READ_PERMISSION =
  "device:logs:read" as const;
export const DEVICE_LOGS_CAPABILITY_MUTATE_PERMISSION =
  "device:logs:mutate" as const;
export const DEVICE_LOGS_CAPABILITY_TAP_PERMISSION =
  "device:logs:tap" as const;

export const DEVICE_LOGS_METHOD_PERMISSIONS: Readonly<Record<string, string>> = {
  status: DEVICE_LOGS_CAPABILITY_READ_PERMISSION,
  list: DEVICE_LOGS_CAPABILITY_READ_PERMISSION,
  clear: DEVICE_LOGS_CAPABILITY_MUTATE_PERMISSION,
  startTap: DEVICE_LOGS_CAPABILITY_TAP_PERMISSION,
  stopTap: DEVICE_LOGS_CAPABILITY_TAP_PERMISSION,
};

export interface DeviceLogsListArgs {
  filter?: DeviceLogsFilter;
}

export interface DeviceLogsClearArgs {
  deviceId?: string;
}

export interface DeviceLogsStartTapArgs {
  platform: DeviceLogSource;
  deviceId: string;
  simulator?: boolean;
  bundleId?: string;
  packageName?: string;
}

export interface DeviceLogsStopTapArgs {
  tapId: string;
}

export interface DeviceLogsHostCapability {
  status(): Promise<DeviceLogsStatus>;
  list(args: DeviceLogsListArgs): Promise<DeviceLogsListResult>;
  clear(
    args: DeviceLogsClearArgs,
  ): Promise<{ status: "cleared"; meta: DeviceLogsMeta }>;
  startTap(args: DeviceLogsStartTapArgs): Promise<DeviceLogsTap>;
  stopTap(args: DeviceLogsStopTapArgs): Promise<{ status: "stopped" | "still-running" }>;
}

export function createDeviceLogsHostCapability(
  store: DeviceLogsStore,
  manager: TapManager,
): DeviceLogsHostCapability {
  return {
    async status() {
      return store.status(manager.listTaps());
    },
    async list({ filter }) {
      return store.list(filter, manager.listTaps());
    },
    async clear({ deviceId }) {
      const meta = store.clear(deviceId, manager.listTaps());
      return { status: "cleared", meta };
    },
    async startTap(args) {
      return manager.startTap(args);
    },
    async stopTap({ tapId }) {
      return manager.stopTap(tapId);
    },
  };
}
