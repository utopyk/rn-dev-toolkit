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
import type { NetworkCursor } from "./types.js";

export type { NetworkCursor } from "./types.js";

/**
 * Maximum `list.limit` allowed at the wire boundary. Mirrors the host's
 * own defensive clamp; the wire layer rejects out-of-range values so an
 * agent gets `undefined` → host-default behavior rather than silent
 * truncation.
 */
export const MAX_LIST_LIMIT = 1000;

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

// ---------------------------------------------------------------------------
// Input shapes — typed precisely at the boundary. The manifest's
// `inputSchema` is the source of truth; these mirror it. MCP validates
// against the schema, `index.ts` narrows defensively at the wire
// boundary via SDK helpers, and handlers below trust both layers.
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
  // Explicit literal rebuild (not `{ worktree, ...filter } = args`) so
  // that a future non-filter field on `ListArgs` doesn't silently leak
  // to the capability via the structural rest-spread — TS's excess-
  // property check only fires on fresh object literals, not on
  // computed rest objects. Named destructure also drops any
  // `__proto__` own-data-property a wire payload may carry (JSON.parse
  // creates it as own data, not prototype link).
  const { worktree, urlRegex, methods, statusRange, since, limit } = args;
  const result = await cap.list({
    worktreeKey: worktree,
    filter: { urlRegex, methods, statusRange, since, limit },
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
