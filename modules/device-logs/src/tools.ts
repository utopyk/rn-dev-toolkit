/**
 * MCP tool handlers for `@rn-dev-modules/device-logs`. Each handler fans
 * out to the `device-logs` host capability and returns a stable DTO.
 *
 * Surface: status / list / clear are read+mutate; start-tap / stop-tap
 * spawn or kill an external CLI (idevicesyslog, simctl, adb) — the
 * `device:logs:tap` permission gates those.
 */

import type { ModuleToolContext } from "@rn-dev/module-sdk";
import {
  DEVICE_LOGS_CAPABILITY_ID,
  type DeviceLogsHostCapability,
} from "./host-capability.js";
import type {
  DeviceLogsCursor,
  DeviceLogsListResult,
  DeviceLogsMeta,
  DeviceLogsStatus,
  DeviceLogsTap,
  DeviceLogLevel,
  DeviceLogSource,
} from "./types.js";

/**
 * Maximum `list.limit` allowed at the wire boundary. Matches the host's
 * `MAX_LIST_LIMIT` in `src/core/device-logs/buffer.ts`.
 */
export const MAX_LIST_LIMIT = 1000;

function resolveCapability(ctx: ModuleToolContext): DeviceLogsHostCapability {
  const cap = ctx.host.capability<DeviceLogsHostCapability>(
    DEVICE_LOGS_CAPABILITY_ID,
  );
  if (!cap) throw new Error("device-logs capability unavailable");
  return cap;
}

// ---------------------------------------------------------------------------
// Input shapes — mirror the manifest's `inputSchema`. Already-narrowed
// types produced by `index.ts::toListArgs` et al.
// ---------------------------------------------------------------------------

export interface StatusArgs {}

export interface ListArgs {
  deviceId?: string;
  source?: DeviceLogSource;
  level?: DeviceLogLevel;
  substring?: string;
  since?: DeviceLogsCursor;
  limit?: number;
}

export interface ClearArgs {
  deviceId?: string;
}

export interface StartTapArgs {
  platform: DeviceLogSource;
  deviceId: string;
  simulator?: boolean;
  bundleId?: string;
  packageName?: string;
}

export interface StopTapArgs {
  tapId: string;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function status(
  _args: StatusArgs,
  ctx: ModuleToolContext,
): Promise<DeviceLogsStatus> {
  const cap = resolveCapability(ctx);
  return cap.status();
}

export async function list(
  args: ListArgs,
  ctx: ModuleToolContext,
): Promise<DeviceLogsListResult> {
  const cap = resolveCapability(ctx);
  // Explicit literal rebuild (not `{...args}`) so excess-property checks
  // catch drift between the wire shape and the capability shape.
  const { deviceId, source, level, substring, since, limit } = args;
  return cap.list({ filter: { deviceId, source, level, substring, since, limit } });
}

export async function clear(
  args: ClearArgs,
  ctx: ModuleToolContext,
): Promise<{ status: "cleared"; meta: DeviceLogsMeta }> {
  const cap = resolveCapability(ctx);
  return cap.clear({ deviceId: args.deviceId });
}

export async function startTap(
  args: StartTapArgs,
  ctx: ModuleToolContext,
): Promise<DeviceLogsTap> {
  const cap = resolveCapability(ctx);
  return cap.startTap(args);
}

export async function stopTap(
  args: StopTapArgs,
  ctx: ModuleToolContext,
): Promise<{ status: "stopped" | "still-running" }> {
  const cap = resolveCapability(ctx);
  return cap.stopTap(args);
}
