/**
 * Local mirror of the `device-logs` host capability surface. The host
 * impl lives at `src/core/device-logs/host-capability.ts`; the module
 * cannot import it directly (bundling boundary), so the shape is
 * duplicated here. Parity is covered by `__tests__/parity.test.ts`.
 */

import type {
  DeviceLogsFilter,
  DeviceLogsListResult,
  DeviceLogsMeta,
  DeviceLogsStatus,
  DeviceLogsTap,
  DeviceLogSource,
} from "./types.js";

export const DEVICE_LOGS_CAPABILITY_ID = "device-logs" as const;

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
