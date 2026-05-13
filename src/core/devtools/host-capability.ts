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
import type { SessionId } from "../identifiers.js";
import type {
  CaptureListResult,
  CaptureMeta,
  DevToolsStatus,
  NetworkEntry,
  NetworkFilter,
} from "./types.js";

export const DEVTOOLS_CAPABILITY_ID = "devtools" as const;

/**
 * Legacy umbrella permission. Retained as the registry's baseline so the
 * v1 manifest shape keeps working; `host-rpc`'s alias expansion widens it
 * to `devtools:capture:read + :mutate` for the grace period. Third-party
 * modules shipping against Phase 10+ should declare the granular
 * permissions directly — `DEVTOOLS_CAPABILITY_READ_PERMISSION` and/or
 * `DEVTOOLS_CAPABILITY_MUTATE_PERMISSION`.
 */
export const DEVTOOLS_CAPABILITY_PERMISSION = "devtools:capture" as const;

/** Required to `status()` / `list()` / `get()` — read-only access. */
export const DEVTOOLS_CAPABILITY_READ_PERMISSION =
  "devtools:capture:read" as const;

/**
 * Required to `clear()` / `selectTarget()` — mutates the capture buffer
 * or switches the CDP target for every subscriber on the worktree.
 */
export const DEVTOOLS_CAPABILITY_MUTATE_PERMISSION =
  "devtools:capture:mutate" as const;

/**
 * Per-method permission map. Registered alongside the capability so the
 * host-rpc layer can do the second-level check without the capability
 * impl knowing about the caller. Keyed by the method names on
 * `DevtoolsHostCapability`.
 */
export const DEVTOOLS_METHOD_PERMISSIONS: Readonly<Record<string, string>> = {
  status: DEVTOOLS_CAPABILITY_READ_PERMISSION,
  list: DEVTOOLS_CAPABILITY_READ_PERMISSION,
  get: DEVTOOLS_CAPABILITY_READ_PERMISSION,
  selectTarget: DEVTOOLS_CAPABILITY_MUTATE_PERMISSION,
  clear: DEVTOOLS_CAPABILITY_MUTATE_PERMISSION,
};

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

/**
 * Phase D3 — the underlying DevToolsManager keys by SessionId; this
 * capability shape is module-facing and stays `worktreeKey`-shaped for
 * back-compat with already-shipped 3p modules. The factory translates
 * the worktreeKey check to a SessionId at the manager boundary via the
 * required `sessionId` argument: the host (bootSessionServices)
 * already knows which sessionId owns the manager registration, so the
 * translation is a single inject at construction time, not a
 * lookup-by-worktree at request time.
 */
export function createDevtoolsHostCapability(
  manager: DevToolsManager,
  defaultWorktreeKey: string,
  sessionId: SessionId,
  allowedWorktreeKeys?: AllowedWorktreeKeys
): DevtoolsHostCapability {
  const allowedSet = (): Set<string> => {
    const arr = allowedWorktreeKeys?.() ?? [defaultWorktreeKey];
    return new Set(arr.length > 0 ? arr : [defaultWorktreeKey]);
  };
  // The capability accepts a worktreeKey from the module subprocess
  // for back-compat. After the cross-worktree guard, the value is
  // discarded — the manager is per-session, so we route every call to
  // the session this capability instance was constructed for.
  const validateWorktreeKey = (wk?: string): void => {
    if (typeof wk !== "string" || wk.length === 0) return;
    if (!allowedSet().has(wk)) {
      // Silently route to the default — preserve the cross-worktree
      // guard semantics tested in
      // `__tests__/host-capability.test.ts`.
      return;
    }
  };

  return {
    async status(wk) {
      validateWorktreeKey(wk);
      return manager.status(sessionId);
    },
    async list({ worktreeKey, filter }) {
      validateWorktreeKey(worktreeKey);
      return manager.listNetwork(sessionId, filter);
    },
    async get({ worktreeKey, requestId }) {
      validateWorktreeKey(worktreeKey);
      if (typeof requestId !== "string" || requestId.length === 0) return null;
      return manager.getNetwork(sessionId, requestId);
    },
    async selectTarget({ worktreeKey, targetId }) {
      validateWorktreeKey(worktreeKey);
      if (typeof targetId !== "string" || targetId.length === 0) {
        throw new Error("devtools.selectTarget: targetId is required");
      }
      await manager.selectTarget(sessionId, targetId);
      return { status: "switched", meta: manager.status(sessionId).meta };
    },
    async clear({ worktreeKey }) {
      validateWorktreeKey(worktreeKey);
      manager.clear(sessionId);
      return { status: "cleared", meta: manager.status(sessionId).meta };
    },
  };
}
