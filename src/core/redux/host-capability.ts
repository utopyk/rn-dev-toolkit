/**
 * Host capability for the `@rn-dev-modules/redux` 3p module. Registered in
 * `registerHostCapabilities` (boot.ts). Mirrors the metro-logs capability:
 * `redux:read` baseline, `clear()` upgrades to `redux:mutate`.
 *
 * Returns data RAW. Redaction (black/white list) is applied by the MODULE
 * at the MCP boundary (`modules/redux/src/dto.ts`, P4) using the module's
 * own config — same split as devtools-network (host returns bodies; the
 * module's dto applies the `mcp-redacted` gate). Raw values crossing the
 * host→subprocess RPC are both the developer's local processes under the
 * daemon; they never reach an agent un-redacted.
 *
 * Worktree scoping mirrors metro-logs: always resolve against the
 * session's `defaultWorktreeKey`; a caller-supplied key is honored only
 * when on the host-known allowlist, else silently coerced to the default.
 */

import type { ReduxStore } from "./buffer.js";
import type {
  ReduxActionRecord,
  ReduxActionsFilter,
  ReduxActionsResult,
  ReduxMeta,
  ReduxStateResult,
  ReduxStatus,
} from "./types.js";

export const REDUX_CAPABILITY_ID = "redux" as const;

export const REDUX_CAPABILITY_READ_PERMISSION = "redux:read" as const;
export const REDUX_CAPABILITY_MUTATE_PERMISSION = "redux:mutate" as const;

export const REDUX_METHOD_PERMISSIONS: Readonly<Record<string, string>> = {
  status: REDUX_CAPABILITY_READ_PERMISSION,
  listActions: REDUX_CAPABILITY_READ_PERMISSION,
  getAction: REDUX_CAPABILITY_READ_PERMISSION,
  getState: REDUX_CAPABILITY_READ_PERMISSION,
  clear: REDUX_CAPABILITY_MUTATE_PERMISSION,
};

export interface ReduxListActionsArgs {
  worktreeKey?: string;
  filter?: ReduxActionsFilter;
}
export interface ReduxGetActionArgs {
  worktreeKey?: string;
  sequence: number;
}
export interface ReduxGetStateArgs {
  worktreeKey?: string;
  path?: string;
}
export interface ReduxClearArgs {
  worktreeKey?: string;
}

export interface ReduxHostCapability {
  status(worktreeKey?: string): Promise<ReduxStatus>;
  listActions(args: ReduxListActionsArgs): Promise<ReduxActionsResult>;
  getAction(args: ReduxGetActionArgs): Promise<{ action: ReduxActionRecord | null }>;
  getState(args: ReduxGetStateArgs): Promise<ReduxStateResult>;
  clear(args: ReduxClearArgs): Promise<{ status: "cleared"; meta: ReduxMeta }>;
}

export type AllowedWorktreeKeys = () => readonly string[];

export function createReduxHostCapability(
  store: ReduxStore,
  defaultWorktreeKey: string,
  allowedWorktreeKeys?: AllowedWorktreeKeys,
): ReduxHostCapability {
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
      return store.status(resolve(wk));
    },
    async listActions({ worktreeKey, filter }) {
      return store.listActions(resolve(worktreeKey), filter);
    },
    async getAction({ worktreeKey, sequence }) {
      return { action: store.getAction(resolve(worktreeKey), sequence) };
    },
    async getState({ worktreeKey, path }) {
      return store.getState(resolve(worktreeKey), path ?? "");
    },
    async clear({ worktreeKey }) {
      return { status: "cleared", meta: store.clear(resolve(worktreeKey)) };
    },
  };
}
