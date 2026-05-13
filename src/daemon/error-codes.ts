// Central error-code union for daemon RPC and session lifecycle.
// Phase D0.5 foundation work.
//
// Before this file existed, error codes were bare string literals at
// each `code: "E_..."` site in [src/daemon/index.ts] and adjacent
// handlers. The multi-session migration renames (`E_PROFILE_MISMATCH` →
// `E_SESSION_NOT_FOUND` for the attach-by-id path; D8 lifted the
// `E_SESSION_ALREADY_RUNNING` singleton-pin in favor of
// `E_SESSION_ALREADY_EXISTS` + `E_PORT_CONFLICT`) would land silently
// otherwise — any string-comparing caller keeps compiling against the
// old code. With a central union, a rename or addition becomes a
// compile error at every consumer.
//
// Adoption is incremental: existing handlers can keep emitting string
// literals; new handlers in D1+ use the union. The compiler enforces
// only when both sides annotate against `SessionErrorCode` (or
// `DaemonRpcErrorCode`).

/**
 * Errors emitted by session-lifecycle and multi-session RPC handlers.
 * Added in Phase D0.5; new codes from the multi-session plan land here
 * as they're introduced in D1+. See decision register § A5.
 */
export type SessionErrorCode =
  // Pre-existing — emitted by today's supervisor.
  | "E_PROFILE_MISMATCH"
  | "E_SESSION_NOT_RUNNING"
  | "E_SESSION_STOPPING"
  // Pre-existing — emitted by the daemon RPC dispatcher.
  | "E_RPC_FAILED"
  | "E_RPC_INVALID_PAYLOAD"
  | "E_RPC_NOT_AUTHORIZED"
  | "E_UNKNOWN_ACTION"
  | "E_SUBSCRIBE_INVALID_KINDS"
  // Pre-existing — hook-system failures (H1).
  | "E_HOOK_FAILED"
  // New in Phase D1+ (multi-session). See plan § B for rationale.
  | "E_UNKNOWN_SESSION"
  | "E_SESSION_ALREADY_EXISTS"
  | "E_SESSION_AMBIGUOUS"
  | "E_PORT_CONFLICT"
  | "E_PROFILE_BOOT_IN_FLIGHT"
  | "E_SUBSCRIBE_INVALID_ARGS";

/**
 * Discriminated result type for RPC handlers. Today's handlers return
 * ad-hoc shapes; D1+ supervisor methods (`start`, `attach`, `stop`,
 * etc.) return `RpcResult<T>` so the caller can narrow on `kind`
 * exhaustively.
 *
 * Note: the existing supervisor returns `StartSessionResult` etc. with
 * its own ok/error shapes. Migration is opt-in per call site.
 */
export type RpcResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "error"; code: SessionErrorCode; message: string };

/**
 * Structured error payload for `E_SESSION_AMBIGUOUS`. The agent / client
 * gets the candidate sessions in the same round-trip so it can retry
 * with the right sessionId. See plan § B2.
 */
export interface SessionAmbiguousData {
  availableSessions: ReadonlyArray<{
    sessionId: string;
    profileName: string;
  }>;
}
