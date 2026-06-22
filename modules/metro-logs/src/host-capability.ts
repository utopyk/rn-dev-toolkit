/**
 * Local mirror of the `metro-logs` host capability surface. The host impl
 * lives at `src/core/metro-logs/host-capability.ts`; the module cannot
 * import it directly (bundling boundary), so the shape is duplicated
 * here. Parity is covered by `__tests__/parity.test.ts`.
 */

import type {
  MetroLogsFilter,
  MetroLogsListResult,
  MetroLogsMeta,
  MetroLogsStatus,
  DeviceLogsFilter,
  DeviceLogsListResult,
  DeviceLogsMeta,
  DeviceLogsStatus,
  DeviceLogsTap,
  DeviceLogSource,
} from "./types.js";

export const METRO_LOGS_CAPABILITY_ID = "metro-logs" as const;

export interface MetroLogsListArgs {
  worktreeKey?: string;
  filter?: MetroLogsFilter;
}

export interface MetroLogsClearArgs {
  worktreeKey?: string;
}

export interface MetroLogsNativeListArgs {
  filter?: DeviceLogsFilter;
}

export interface MetroLogsNativeClearArgs {
  deviceId?: string;
}

export interface MetroLogsStartTapArgs {
  platform: DeviceLogSource;
  deviceId: string;
  simulator?: boolean;
  bundleId?: string;
  packageName?: string;
}

export interface MetroLogsStopTapArgs {
  tapId: string;
}

export interface MetroLogsHostCapability {
  status(worktreeKey?: string): Promise<MetroLogsStatus>;
  list(args: MetroLogsListArgs): Promise<MetroLogsListResult>;
  clear(
    args: MetroLogsClearArgs,
  ): Promise<{ status: "cleared"; meta: MetroLogsMeta }>;
  nativeStatus(): Promise<DeviceLogsStatus>;
  nativeList(args: MetroLogsNativeListArgs): Promise<DeviceLogsListResult>;
  nativeClear(
    args: MetroLogsNativeClearArgs,
  ): Promise<{ status: "cleared"; meta: DeviceLogsMeta }>;
  startTap(args: MetroLogsStartTapArgs): Promise<DeviceLogsTap>;
  stopTap(args: MetroLogsStopTapArgs): Promise<{ status: "stopped" | "still-running" }>;
}
