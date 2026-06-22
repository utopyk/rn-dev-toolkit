/**
 * MCP tool handlers for `@rn-dev-modules/metro-logs`. Each handler fans
 * out to the `metro-logs` host capability and returns a stable DTO.
 *
 * Scope (intentionally narrow): list / status / clear. Reload + dev-menu
 * are Metro *lifecycle* surfaces — they belong on a future `metro-control`
 * module with `exec:react-native` permission. Keeping this module
 * read-dominated lets it ship with the low-bar `metro:logs:read`
 * permission and a single mutate surface (`clear`) that an operator can
 * reason about in isolation.
 */

import type { ModuleToolContext } from "@rn-dev/module-sdk";
import {
  METRO_LOGS_CAPABILITY_ID,
  type MetroLogsHostCapability,
} from "./host-capability.js";
import type {
  MetroLogsCursor,
  MetroLogsListResult,
  MetroLogsMeta,
  MetroLogsStatus,
  MetroLogStream,
  DeviceLogLevel,
  DeviceLogSource,
  DeviceLogsCursor,
  DeviceLogsListResult,
  DeviceLogsMeta,
  DeviceLogsStatus,
  DeviceLogsTap,
} from "./types.js";

/**
 * Maximum `list.limit` allowed at the wire boundary. Matches the host's
 * `MAX_LIST_LIMIT` in `src/core/metro-logs/buffer.ts`; the host applies
 * its own clamp as defense-in-depth, but the wire layer rejects values
 * outside this range so an agent gets `undefined` → host-default
 * behavior rather than a silently-truncated limit.
 */
export const MAX_LIST_LIMIT = 1000;

function resolveCapability(ctx: ModuleToolContext): MetroLogsHostCapability {
  const cap = ctx.host.capability<MetroLogsHostCapability>(
    METRO_LOGS_CAPABILITY_ID,
  );
  if (!cap) {
    // Generic message — mirrors the host-side error shape so a denied
    // permission and a missing capability aren't distinguishable.
    throw new Error("metro-logs capability unavailable");
  }
  return cap;
}

// ---------------------------------------------------------------------------
// Input shapes — mirror the manifest's `inputSchema`. These are the
// already-narrowed types produced by `index.ts::toListArgs` et al.
// MCP validates upstream, `index.ts` narrows defensively at the wire
// boundary, and handlers below trust both layers.
// ---------------------------------------------------------------------------

export interface StatusArgs {
  worktree?: string;
}

export interface ListArgs {
  worktree?: string;
  substring?: string;
  stream?: MetroLogStream;
  since?: MetroLogsCursor;
  limit?: number;
}

export interface ClearArgs {
  worktree?: string;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function status(
  args: StatusArgs,
  ctx: ModuleToolContext,
): Promise<MetroLogsStatus> {
  const cap = resolveCapability(ctx);
  return cap.status(args.worktree);
}

export async function list(
  args: ListArgs,
  ctx: ModuleToolContext,
): Promise<MetroLogsListResult> {
  const cap = resolveCapability(ctx);
  // Explicit literal rebuild (not `{ worktree, ...filter } = args`) so
  // that a future non-filter field on `ListArgs` doesn't silently leak
  // to the capability via the structural rest-spread — TS's excess-
  // property check only fires on fresh object literals, not on
  // computed rest objects. Named destructure also drops any
  // `__proto__` own-data-property a wire payload may carry (JSON.parse
  // creates it as own data, not prototype link).
  const { worktree, substring, stream, since, limit } = args;
  return cap.list({
    worktreeKey: worktree,
    filter: { substring, stream, since, limit },
  });
}

export async function clear(
  args: ClearArgs,
  ctx: ModuleToolContext,
): Promise<{ status: "cleared"; meta: MetroLogsMeta }> {
  const cap = resolveCapability(ctx);
  return cap.clear({ worktreeKey: args.worktree });
}

// ── Native-tap surface (folded from the deleted `device-logs` module) ───

export interface NativeStatusArgs {}

export interface NativeListArgs {
  deviceId?: string;
  source?: DeviceLogSource;
  level?: DeviceLogLevel;
  substring?: string;
  since?: DeviceLogsCursor;
  limit?: number;
}

export interface NativeClearArgs {
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

export async function nativeStatus(
  _args: NativeStatusArgs,
  ctx: ModuleToolContext,
): Promise<DeviceLogsStatus> {
  return resolveCapability(ctx).nativeStatus();
}

export async function nativeList(
  args: NativeListArgs,
  ctx: ModuleToolContext,
): Promise<DeviceLogsListResult> {
  const { deviceId, source, level, substring, since, limit } = args;
  return resolveCapability(ctx).nativeList({
    filter: { deviceId, source, level, substring, since, limit },
  });
}

export async function nativeClear(
  args: NativeClearArgs,
  ctx: ModuleToolContext,
): Promise<{ status: "cleared"; meta: DeviceLogsMeta }> {
  return resolveCapability(ctx).nativeClear({ deviceId: args.deviceId });
}

export async function startTap(
  args: StartTapArgs,
  ctx: ModuleToolContext,
): Promise<DeviceLogsTap> {
  return resolveCapability(ctx).startTap(args);
}

export async function stopTap(
  args: StopTapArgs,
  ctx: ModuleToolContext,
): Promise<{ status: "stopped" | "still-running" }> {
  return resolveCapability(ctx).stopTap(args);
}
