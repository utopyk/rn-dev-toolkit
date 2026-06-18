/**
 * Host capability for the `@rn-dev-modules/redux` 3p module. Registered in
 * `registerHostCapabilities` (boot.ts). `redux:read` baseline; `clear()`
 * upgrades to `redux:mutate`.
 *
 * REDACTION RUNS HERE, host-side (P4 decision, stronger than the
 * devtools-network "module redacts" split). The module owns the POLICY —
 * it reads its config and passes `whitelist` / `extraBlacklist` / `mode`
 * in — but the host applies it via `redactValue` BEFORE returning, so raw
 * Redux state/payloads never cross the host→subprocess boundary. The
 * default (no `redaction` arg) is the strictest posture: structure-only,
 * empty whitelist, full DEFAULT_BLACKLIST. `DEFAULT_BLACKLIST` lives
 * host-side and is ALWAYS unioned in, so a module config can extend but
 * never drop it.
 *
 * Worktree scoping mirrors metro-logs: resolve against the session's
 * `defaultWorktreeKey`; an unknown caller key coerces to the default.
 */

import type { ReduxStore } from "./buffer.js";
import { DEFAULT_BLACKLIST, redactValue } from "./redact.js";
import type {
  RedactionConfig,
  RedactionMode,
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

/**
 * Redaction policy the module supplies. `extraBlacklist` EXTENDS the
 * host's `DEFAULT_BLACKLIST` (never replaces it). Omitting the whole
 * object ⇒ strictest defaults.
 */
export interface ReduxRedactionInput {
  whitelist?: readonly string[];
  extraBlacklist?: readonly string[];
  mode?: RedactionMode;
}

function effectiveConfig(input?: ReduxRedactionInput): RedactionConfig {
  return {
    whitelist: input?.whitelist ?? [],
    blacklist: [...DEFAULT_BLACKLIST, ...(input?.extraBlacklist ?? [])],
    mode: input?.mode ?? "mcp-redacted",
  };
}

export interface ReduxListActionsArgs {
  worktreeKey?: string;
  filter?: ReduxActionsFilter;
  redaction?: ReduxRedactionInput;
}
export interface ReduxGetActionArgs {
  worktreeKey?: string;
  sequence: number;
  redaction?: ReduxRedactionInput;
}
export interface ReduxGetStateArgs {
  worktreeKey?: string;
  path?: string;
  redaction?: ReduxRedactionInput;
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

  const redactAction = (a: ReduxActionRecord, cfg: RedactionConfig): ReduxActionRecord => ({
    ...a,
    payload: redactValue(a.payload, cfg).value,
    diff: a.diff === null ? null : redactValue(a.diff, cfg).value,
  });

  return {
    async status(wk) {
      return store.status(resolve(wk));
    },
    async listActions({ worktreeKey, filter, redaction }) {
      const cfg = effectiveConfig(redaction);
      const res = store.listActions(resolve(worktreeKey), filter);
      return { ...res, entries: res.entries.map((a) => redactAction(a, cfg)) };
    },
    async getAction({ worktreeKey, sequence, redaction }) {
      const cfg = effectiveConfig(redaction);
      const action = store.getAction(resolve(worktreeKey), sequence);
      return { action: action === null ? null : redactAction(action, cfg) };
    },
    async getState({ worktreeKey, path, redaction }) {
      const cfg = effectiveConfig(redaction);
      const res = store.getState(resolve(worktreeKey), path ?? "");
      // rootPath = the queried path so whitelist/blacklist evaluate
      // against the FULL state path (reading `auth.session` still sees
      // `auth.session.token` as blacklisted).
      const value = res.present ? redactValue(res.value, cfg, res.path).value : res.value;
      return { ...res, value };
    },
    async clear({ worktreeKey }) {
      return { status: "cleared", meta: store.clear(resolve(worktreeKey)) };
    },
  };
}
