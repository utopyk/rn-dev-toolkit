/**
 * MCP tool handlers for `@rn-dev-modules/redux`. Each fans out to the
 * `redux` host capability. Redaction is the host's job; this layer reads
 * the operator's per-module config (`ctx.config`) and passes the policy
 * in. Reads are fail-closed: a malformed config value coerces to the
 * STRICTEST posture (structure-only, no extra reveal), never the loosest.
 */

import type { ModuleToolContext } from "@rn-dev/module-sdk";
import {
  REDUX_CAPABILITY_ID,
  type ReduxHostCapability,
  type ReduxRedactionInput,
} from "./host-capability.js";
import type {
  ReduxActionRecord,
  ReduxActionsResult,
  ReduxCursor,
  ReduxMeta,
  ReduxStateResult,
  ReduxStatus,
} from "./types.js";

export const MAX_LIST_LIMIT = 1000;

function resolveCapability(ctx: ModuleToolContext): ReduxHostCapability {
  const cap = ctx.host.capability<ReduxHostCapability>(REDUX_CAPABILITY_ID);
  if (!cap) throw new Error("redux capability unavailable");
  return cap;
}

/**
 * Read the operator's redaction policy from module config, fail-closed.
 * `whitelist` / `blacklist` accept only arrays of strings; `mode` accepts
 * only the literal `"full"` to loosen — anything else (missing, wrong
 * type, typo) stays `mcp-redacted`. So a corrupt config can never silently
 * widen exposure.
 */
function readRedaction(ctx: ModuleToolContext): ReduxRedactionInput {
  const cfg = ctx.config as {
    whitelist?: unknown;
    blacklist?: unknown;
    mode?: unknown;
  };
  const stringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    whitelist: stringArray(cfg.whitelist),
    extraBlacklist: stringArray(cfg.blacklist),
    mode: cfg.mode === "full" ? "full" : "mcp-redacted",
  };
}

export interface StatusArgs {
  worktree?: string;
}
export interface StateArgs {
  worktree?: string;
  path?: string;
}
export interface ActionsArgs {
  worktree?: string;
  typeFilter?: string;
  since?: ReduxCursor;
  limit?: number;
}
export interface ActionArgs {
  worktree?: string;
  sequence: number;
}
export interface ClearArgs {
  worktree?: string;
}

export async function status(args: StatusArgs, ctx: ModuleToolContext): Promise<ReduxStatus> {
  return resolveCapability(ctx).status(args.worktree);
}

export async function state(args: StateArgs, ctx: ModuleToolContext): Promise<ReduxStateResult> {
  const { worktree, path } = args;
  return resolveCapability(ctx).getState({
    worktreeKey: worktree,
    path,
    redaction: readRedaction(ctx),
  });
}

export async function actions(args: ActionsArgs, ctx: ModuleToolContext): Promise<ReduxActionsResult> {
  const { worktree, typeFilter, since, limit } = args;
  return resolveCapability(ctx).listActions({
    worktreeKey: worktree,
    filter: { typeFilter, since, limit },
    redaction: readRedaction(ctx),
  });
}

export async function action(
  args: ActionArgs,
  ctx: ModuleToolContext,
): Promise<{ action: ReduxActionRecord | null }> {
  return resolveCapability(ctx).getAction({
    worktreeKey: args.worktree,
    sequence: args.sequence,
    redaction: readRedaction(ctx),
  });
}

export async function clear(
  args: ClearArgs,
  ctx: ModuleToolContext,
): Promise<{ status: "cleared"; meta: ReduxMeta }> {
  return resolveCapability(ctx).clear({ worktreeKey: args.worktree });
}
