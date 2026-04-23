/**
 * MCP tool handlers for `@rn-dev-modules/devtools-network`. Each handler
 * fans out to the `devtools` host capability, applies S5 body redaction
 * via the module's `captureBodies` config, and returns a stable DTO.
 */

import type { ModuleToolContext } from "@rn-dev/module-sdk";
import {
  DEVTOOLS_CAPABILITY_ID,
  type DevtoolsHostCapability,
} from "./host-capability.js";
import {
  projectMeta,
  toDto,
  toListDto,
  type DevToolsListDto,
  type NetworkEntryDto,
} from "./dto.js";
import type { NetworkCursor, NetworkFilter } from "./types.js";

export type { NetworkCursor } from "./types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveCapability(ctx: ModuleToolContext): DevtoolsHostCapability {
  const cap = ctx.host.capability<DevtoolsHostCapability>(DEVTOOLS_CAPABILITY_ID);
  if (!cap) {
    // Generic message — mirrors the host-side error to avoid leaking whether
    // the capability is missing vs. the permission is not granted.
    throw new Error("devtools capability unavailable");
  }
  return cap;
}

/**
 * Security Phase 9: read captureBodies via a typeguard and fail-closed on
 * type confusion. Host-side schema validation on `modules/config/set`
 * should already prevent this, but the MCP redaction gate is defense-in-
 * depth: a hand-edited `config.json` that writes `{captureBodies:"true"}`
 * (string) must not leak bodies.
 */
function readCaptureBodies(ctx: ModuleToolContext): boolean {
  const raw = (ctx.config as { captureBodies?: unknown }).captureBodies;
  return raw === true;
}

const MAX_LIMIT = 1000;

function isCursor(value: unknown): value is NetworkCursor {
  if (!value || typeof value !== "object") return false;
  const v = value as { bufferEpoch?: unknown; sequence?: unknown };
  return (
    typeof v.bufferEpoch === "number" &&
    Number.isFinite(v.bufferEpoch) &&
    typeof v.sequence === "number" &&
    Number.isFinite(v.sequence)
  );
}

function extractFilter(args: ListArgs): NetworkFilter | undefined {
  const filter: NetworkFilter = {};
  if (typeof args.urlRegex === "string") filter.urlRegex = args.urlRegex;
  if (Array.isArray(args.methods)) {
    const methods = args.methods.filter(
      (m): m is string => typeof m === "string" && m.length > 0,
    );
    if (methods.length > 0) filter.methods = methods;
  }
  if (
    Array.isArray(args.statusRange) &&
    args.statusRange.length === 2 &&
    typeof args.statusRange[0] === "number" &&
    typeof args.statusRange[1] === "number" &&
    Number.isFinite(args.statusRange[0]) &&
    Number.isFinite(args.statusRange[1])
  ) {
    filter.statusRange = [args.statusRange[0], args.statusRange[1]];
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
// Input shapes — typed precisely at the boundary. The manifest's
// `inputSchema` is the source of truth; these mirror it. MCP validates
// against the schema before dispatch, but handlers still narrow defensively
// at runtime (see `extractFilter`).
// ---------------------------------------------------------------------------

export interface StatusArgs {
  worktree?: string;
}

export interface ListArgs {
  worktree?: string;
  urlRegex?: string;
  methods?: string[];
  statusRange?: [number, number];
  since?: NetworkCursor;
  limit?: number;
}

export interface GetArgs {
  worktree?: string;
  requestId: string;
}

export interface SelectTargetArgs {
  worktree?: string;
  targetId: string;
}

export interface ClearArgs {
  worktree?: string;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function status(args: StatusArgs, ctx: ModuleToolContext) {
  const cap = resolveCapability(ctx);
  const captureBodies = readCaptureBodies(ctx);
  const st = await cap.status(args.worktree);
  return {
    meta: projectMeta(st.meta, { captureBodies }),
    targets: st.targets,
    rnVersion: st.rnVersion,
    proxyPort: st.proxyPort,
    sessionNonce: st.sessionNonce,
    bodyCaptureEnabled: captureBodies,
  };
}

export async function list(
  args: ListArgs,
  ctx: ModuleToolContext
): Promise<DevToolsListDto> {
  const cap = resolveCapability(ctx);
  const result = await cap.list({
    worktreeKey: args.worktree,
    filter: extractFilter(args),
  });
  return toListDto(result, { captureBodies: readCaptureBodies(ctx) });
}

export async function get(
  args: GetArgs,
  ctx: ModuleToolContext
): Promise<NetworkEntryDto | { error: "not-found"; requestId: string }> {
  const cap = resolveCapability(ctx);
  const entry = await cap.get({
    worktreeKey: args.worktree,
    requestId: args.requestId,
  });
  if (!entry) return { error: "not-found", requestId: args.requestId };
  return toDto(entry, { captureBodies: readCaptureBodies(ctx) });
}

export async function selectTarget(
  args: SelectTargetArgs,
  ctx: ModuleToolContext
) {
  const cap = resolveCapability(ctx);
  return cap.selectTarget({
    worktreeKey: args.worktree,
    targetId: args.targetId,
  });
}

export async function clear(args: ClearArgs, ctx: ModuleToolContext) {
  const cap = resolveCapability(ctx);
  return cap.clear({ worktreeKey: args.worktree });
}
