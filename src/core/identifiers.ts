// Branded identifiers shared across the daemon, core, app, and Electron
// layers. Phase D0.5 foundation work — the multi-session daemon plan
// (docs/plans/2026-05-12-feat-multi-session-daemon-and-electron-plan.md)
// needs at least two distinct string identifiers in flight simultaneously
// (sessionId, worktreeKey), and the existing single-session code lets them
// cross-mix because both are typed as bare `string`.
//
// Pattern mirrors `ValidatedProfile` in
// [src/daemon/profile-guard.ts:28-30] — a single mint point, phantom brand
// (zero runtime cost), downstream APIs refuse the raw `string` form.
//
// `WorktreeKey` is back-compatible: existing code that still passes
// `string` around continues to work; new code that takes `WorktreeKey`
// rejects the bare string at the type system. Migration is incremental.
import { randomUUID } from "node:crypto";

declare const SessionIdBrand: unique symbol;
/**
 * Opaque per-session identifier. Server-minted UUID; clients echo it
 * verbatim and never construct. See DR-1 in the plan.
 */
export type SessionId = string & { readonly [SessionIdBrand]: true };

declare const WorktreeKeyBrand: unique symbol;
/**
 * Hashed worktree path. Today minted by `ArtifactStore.worktreeHash`;
 * the brand lets call sites that compose composite keys (e.g.
 * `${worktreeKey}:${sessionId}`) refuse a bare string at compile time.
 *
 * Simplicity-reviewer recommendation in the deepening pass (§ A2): prefer
 * keying Maps by `SessionId` alone where possible, since SessionId is
 * already unique by construction. WorktreeKey is metadata, not identity.
 */
export type WorktreeKey = string & { readonly [WorktreeKeyBrand]: true };

/**
 * Mint a fresh SessionId. Server-only; never called from client paths.
 * Uses `crypto.randomUUID()` — RFC 4122 v4, collision-resistant for the
 * lifetime of a daemon process (and across daemons).
 */
export function generateSessionId(): SessionId {
  return randomUUID() as SessionId;
}

/**
 * Mint a SessionId from a known-trusted source. Used by deserializers
 * that read sessionIds off the wire — the caller proves the string came
 * from the daemon's own `generateSessionId` (typically by round-trip).
 * Validates non-empty.
 */
export function asSessionId(raw: string): SessionId {
  if (raw.length === 0) {
    throw new Error("asSessionId: empty string");
  }
  return raw as SessionId;
}

/**
 * Mint a WorktreeKey from a hash string. Caller is responsible for
 * having produced the hash via the canonical `ArtifactStore.worktreeHash`
 * path (or an equivalent deterministic hash). Validates non-empty and
 * rejects colons — see § A2 in the plan's deepening notes; colon is the
 * delimiter the ModuleHostManager `keyFor` helper uses for composite
 * scope keys, so a colon in a WorktreeKey would round-trip ambiguously.
 */
export function asWorktreeKey(raw: string): WorktreeKey {
  if (raw.length === 0) {
    throw new Error("asWorktreeKey: empty string");
  }
  if (raw.includes(":")) {
    throw new Error(`asWorktreeKey: contains colon: ${raw}`);
  }
  return raw as WorktreeKey;
}
