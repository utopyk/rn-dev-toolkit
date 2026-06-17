/**
 * Redux capture types — shared between the host-side `ReduxStore` and the
 * 3p `@rn-dev-modules/redux` subprocess that queries it via the `redux`
 * host capability.
 *
 * Mirrors the `metro-logs` shapes (ring + cursor + meta envelope). The one
 * structural difference: a Redux session also has a CURRENT STATE snapshot
 * (not just an append-only stream), so `ReduxStore` keeps the latest state
 * alongside the action ring.
 *
 * SECURITY: action payloads, diffs, and state are untrusted external
 * content from the running app AND frequently contain PII / payment /
 * auth data. The store holds them RAW in-memory (the daemon is the
 * developer's own process); redaction (`./redact.ts`) is applied at every
 * read that can cross into an agent's context. Raw values are never
 * persisted to disk or the audit log.
 */

export type RedactionMode = "mcp-redacted" | "full";

/**
 * Black/white-list redaction policy (decided 2026-06-17). A value is
 * revealed only when its path is under a whitelist prefix AND no blacklist
 * pattern matches its key. Everything else is structure-only (keys + types,
 * values replaced by a `<type>` placeholder) in `mcp-redacted` mode, or
 * revealed in `full` mode — but `full` still honors the blacklist.
 */
export interface RedactionConfig {
  /**
   * Path prefixes (dot-joined, e.g. `ui`, `navigation.routes`) whose
   * values are safe to reveal to agents in full. Empty ⇒ nothing is
   * revealed by default (strictest).
   */
  readonly whitelist: readonly string[];
  /**
   * Key-name globs (`*token*`, `email`) ALWAYS redacted, even inside a
   * whitelisted slice. `*` matches any run of characters; matching is
   * case-insensitive and anchored to the whole key.
   */
  readonly blacklist: readonly string[];
  readonly mode: RedactionMode;
}

/** A single dispatched action, stored raw. */
export interface ReduxActionRecord {
  readonly sequence: number;
  readonly at: number;
  readonly type: string;
  /** Raw action payload (everything but `type`). Redacted at read. */
  readonly payload: unknown;
  /**
   * Structural diff the enhancer computed for this action (shallow), or
   * null when the enhancer didn't send one. Raw; redacted at read.
   */
  readonly diff: unknown;
}

/**
 * Pagination cursor. Holders pass `meta.bufferEpoch` + `meta.lastEventSequence`
 * back as `since`; the store drops the cursor when the epoch bumped
 * (`clear()` or a fresh app connection on the session).
 */
export interface ReduxCursor {
  readonly bufferEpoch: number;
  readonly sequence: number;
}

export interface ReduxActionsFilter {
  /** Case-insensitive substring match against the action `type`. */
  typeFilter?: string;
  since?: ReduxCursor;
  /** Clamped at the store layer to `MAX_LIST_LIMIT`. */
  limit?: number;
}

export interface ReduxMeta {
  readonly sessionKey: string;
  /** Bumps on `clear()` or a fresh app/store connection. */
  readonly bufferEpoch: number;
  /** Sequence of the oldest retained action (1-based; 0 if empty). */
  readonly oldestSequence: number;
  /** Sequence of the last appended action (0 if empty). */
  readonly lastEventSequence: number;
  /** Total actions ever received for this session, pre-eviction. */
  readonly totalActionsReceived: number;
  /** Count of actions evicted by the ring. */
  readonly evictedCount: number;
  /** Count of payloads/diffs/state values truncated at the size cap. */
  readonly truncatedCount: number;
  /** Whether a state snapshot has been received yet. */
  readonly hasState: boolean;
  readonly redactionMode: RedactionMode;
}

export interface ReduxActionsResult {
  readonly entries: readonly ReduxActionRecord[];
  /** True when the caller's `since` cursor was from a stale epoch. */
  readonly cursorDropped: boolean;
  readonly meta: ReduxMeta;
}

export interface ReduxStateResult {
  /**
   * The (redacted, by the caller) state at the requested path, or `null`
   * when no state has been received or the path doesn't exist.
   */
  readonly value: unknown;
  /** The path that was read (dot-joined), `""` for the whole tree. */
  readonly path: string;
  /** False when no snapshot has arrived yet (vs a real `null` value). */
  readonly present: boolean;
  readonly meta: ReduxMeta;
}

export interface ReduxStatus {
  readonly meta: ReduxMeta;
  /** Actions currently retained in the ring. */
  readonly bufferSize: number;
  readonly bufferCapacity: number;
}

/** Input frame the ingest layer hands to `ReduxStore.append`. */
export interface ReduxIngestFrame {
  readonly type: string;
  readonly payload?: unknown;
  readonly diff?: unknown;
  /** Full state after this action, when the enhancer sends it. */
  readonly stateAfter?: unknown;
}
