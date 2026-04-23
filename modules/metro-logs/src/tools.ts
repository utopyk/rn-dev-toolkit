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
  MetroLogsFilter,
  MetroLogsListResult,
  MetroLogsMeta,
  MetroLogsStatus,
  MetroLogStream,
} from "./types.js";

const MAX_LIMIT = 1000;

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

function isCursor(value: unknown): value is MetroLogsCursor {
  if (!value || typeof value !== "object") return false;
  const v = value as { bufferEpoch?: unknown; sequence?: unknown };
  return (
    typeof v.bufferEpoch === "number" &&
    Number.isFinite(v.bufferEpoch) &&
    typeof v.sequence === "number" &&
    Number.isFinite(v.sequence)
  );
}

function isStream(value: unknown): value is MetroLogStream {
  return value === "stdout" || value === "stderr";
}

export function extractFilter(args: ListArgs): MetroLogsFilter | undefined {
  const filter: MetroLogsFilter = {};
  if (typeof args.substring === "string" && args.substring.length > 0) {
    filter.substring = args.substring;
  }
  if (isStream(args.stream)) {
    filter.stream = args.stream;
  }
  if (isCursor(args.since)) {
    filter.since = args.since;
  }
  if (
    typeof args.limit === "number" &&
    Number.isInteger(args.limit) &&
    args.limit > 0 &&
    args.limit <= MAX_LIMIT
  ) {
    filter.limit = args.limit;
  }
  return Object.keys(filter).length > 0 ? filter : undefined;
}

// ---------------------------------------------------------------------------
// Input shapes — mirror the manifest's `inputSchema`. MCP validates
// upstream, but handlers still narrow defensively at runtime
// (a module can be poked directly over the vscode-jsonrpc socket).
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
  return cap.list({
    worktreeKey: args.worktree,
    filter: extractFilter(args),
  });
}

export async function clear(
  args: ClearArgs,
  ctx: ModuleToolContext,
): Promise<{ status: "cleared"; meta: MetroLogsMeta }> {
  const cap = resolveCapability(ctx);
  return cap.clear({ worktreeKey: args.worktree });
}
