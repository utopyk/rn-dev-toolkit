/**
 * Local mirror of the `redux` host capability surface. The host impl lives
 * at `src/core/redux/host-capability.ts`; the module can't import it
 * (bundling boundary), so the shape is duplicated here. Parity covered by
 * `__tests__/parity.test.ts`.
 *
 * Redaction is applied HOST-SIDE: the module passes its operator-configured
 * `redaction` policy; the host applies it before returning, so raw state
 * never reaches this subprocess. `extraBlacklist` EXTENDS the host's
 * default blacklist; omitting `redaction` ⇒ strictest defaults.
 */

import type {
  RedactionMode,
  ReduxActionRecord,
  ReduxActionsFilter,
  ReduxActionsResult,
  ReduxMeta,
  ReduxStateResult,
  ReduxStatus,
} from "./types.js";

export const REDUX_CAPABILITY_ID = "redux" as const;

export interface ReduxRedactionInput {
  whitelist?: readonly string[];
  extraBlacklist?: readonly string[];
  mode?: RedactionMode;
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
