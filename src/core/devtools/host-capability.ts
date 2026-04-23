/**
 * Devtools host capability — Phase 9. Exposes the `DevToolsManager` query
 * surface to 3p module subprocesses via the module capability registry.
 *
 * Tunneled over vscode-jsonrpc `host/call`: inside a module subprocess,
 * `ctx.host.capability<DevtoolsHostCapability>("devtools")` round-trips
 * each method back to the daemon, where it resolves against the manager
 * instance registered at `startServicesAsync` time.
 *
 * The DTO layer (redaction, `captureBodies`) lives in the module
 * subprocess — this capability returns raw `NetworkEntry` / `CaptureMeta`
 * values. Trust boundary: the module is spawned by the host, so bodies
 * cross the vscode-jsonrpc pipe unredacted. The module is responsible
 * for applying MCP-facing redaction before emitting a DTO to its caller.
 *
 * Worktree scoping (Security Phase 9): the capability ALWAYS resolves
 * against `defaultWorktreeKey`. Caller-supplied `worktreeKey` values are
 * validated against a host-known allowlist and silently ignored when
 * unknown — preventing a module with `devtools:capture` from reading or
 * mutating another worktree's capture state. Agents can still surface the
 * current worktree via `status()`'s meta envelope.
 */

import type { DevToolsManager } from "../devtools.js";
import type {
  CaptureListResult,
  CaptureMeta,
  DevToolsStatus,
  NetworkEntry,
  NetworkFilter,
} from "./types.js";

export const DEVTOOLS_CAPABILITY_ID = "devtools" as const;
export const DEVTOOLS_CAPABILITY_PERMISSION = "devtools:capture" as const;

export interface DevtoolsListArgs {
  worktreeKey?: string;
  filter?: NetworkFilter;
}

export interface DevtoolsGetArgs {
  worktreeKey?: string;
  requestId: string;
}

export interface DevtoolsSelectTargetArgs {
  worktreeKey?: string;
  targetId: string;
}

export interface DevtoolsClearArgs {
  worktreeKey?: string;
}

export interface DevtoolsHostCapability {
  status(worktreeKey?: string): Promise<DevToolsStatus>;
  list(args: DevtoolsListArgs): Promise<CaptureListResult<NetworkEntry>>;
  get(args: DevtoolsGetArgs): Promise<NetworkEntry | null>;
  selectTarget(
    args: DevtoolsSelectTargetArgs
  ): Promise<{ status: "switched"; meta: CaptureMeta }>;
  clear(
    args: DevtoolsClearArgs
  ): Promise<{ status: "cleared"; meta: CaptureMeta }>;
}

/**
 * Optional accessor for the allowed worktree-key set. `createDevtoolsHostCapability`
 * calls this before every method so v1 daemons with a single worktree can
 * pass `() => [defaultWorktreeKey]` while forward-compat multi-worktree
 * daemons can thread the registry through.
 */
export type AllowedWorktreeKeys = () => readonly string[];

export function createDevtoolsHostCapability(
  manager: DevToolsManager,
  defaultWorktreeKey: string,
  allowedWorktreeKeys?: AllowedWorktreeKeys
): DevtoolsHostCapability {
  const allowedSet = (): Set<string> => {
    const arr = allowedWorktreeKeys?.() ?? [defaultWorktreeKey];
    return new Set(arr.length > 0 ? arr : [defaultWorktreeKey]);
  };
  const resolve = (wk?: string): string => {
    if (typeof wk !== "string" || wk.length === 0) return defaultWorktreeKey;
    return allowedSet().has(wk) ? wk : defaultWorktreeKey;
  };

  return {
    async status(wk) {
      return manager.status(resolve(wk));
    },
    async list({ worktreeKey, filter }) {
      return manager.listNetwork(resolve(worktreeKey), filter);
    },
    async get({ worktreeKey, requestId }) {
      if (typeof requestId !== "string" || requestId.length === 0) return null;
      return manager.getNetwork(resolve(worktreeKey), requestId);
    },
    async selectTarget({ worktreeKey, targetId }) {
      if (typeof targetId !== "string" || targetId.length === 0) {
        throw new Error("devtools.selectTarget: targetId is required");
      }
      const wk = resolve(worktreeKey);
      await manager.selectTarget(wk, targetId);
      return { status: "switched", meta: manager.status(wk).meta };
    },
    async clear({ worktreeKey }) {
      const wk = resolve(worktreeKey);
      manager.clear(wk);
      return { status: "cleared", meta: manager.status(wk).meta };
    },
  };
}
