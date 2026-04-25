// Per-connection registry of subscribe-socket capabilities.
//
// Phase 13.6 — under the multiplexed channel design (Lean D), a
// subscribe socket optionally accepts follow-up RPCs from the same
// connection. The opt-in is daemon-enforced via the
// `supportsBidirectionalRpc` field on the events/subscribe payload;
// without it, the daemon rejects any RPC arriving on that socket.
//
// Mirrors `SenderBindings`'s API shape. One instance per supervisor
// boot, cleared by `clearConnection(connectionId)` on socket close.

export interface SubscribeEntry {
  /** Whether the client declared `supportsBidirectionalRpc: true`. */
  readonly bidirectional: boolean;
  // NOTE: kindFilter was removed (P0-4 Phase 13.6 PR-C). The filter value
  // is captured as a closure variable inside handleEventsSubscribe and used
  // directly by the `matchesKindFilter` check there; storing it in the
  // registry had no readers and was YAGNI. If per-subscriber kind-filter
  // introspection is ever needed, add it back with a concrete use case.
}

export class SubscribeRegistry {
  private entries = new Map<string, SubscribeEntry>();

  register(connectionId: string, entry: SubscribeEntry): void {
    this.entries.set(connectionId, entry);
  }

  has(connectionId: string): boolean {
    return this.entries.has(connectionId);
  }

  isBidirectional(connectionId: string): boolean {
    return this.entries.get(connectionId)?.bidirectional === true;
  }

  clearConnection(connectionId: string): void {
    this.entries.delete(connectionId);
  }
}

/**
 * Returns true if `eventKind` passes the given filter.
 *
 * - `null`  → subscriber wants all events (back-compat default)
 * - `[]`    → subscriber wants no events
 * - entries are either exact (`metro/log`) or prefix-glob (`modules/*`)
 */
export function matchesKindFilter(
  filter: readonly string[] | null,
  eventKind: string,
): boolean {
  if (filter === null) return true;
  for (const entry of filter) {
    if (entry.endsWith("/*")) {
      const prefix = entry.slice(0, -1); // keep the trailing slash: "modules/"
      if (eventKind.startsWith(prefix)) return true;
    } else if (entry === eventKind) {
      return true;
    }
  }
  return false;
}

export type ParseKindsResult =
  | { ok: true; kinds: readonly string[] | null }
  | { ok: false; code: "E_SUBSCRIBE_INVALID_KINDS"; message: string };

/**
 * Validates and normalises the raw `kinds` field from the wire payload.
 *
 * - `undefined` → `{ ok: true, kinds: null }` (all events — back-compat)
 * - `[]`        → `{ ok: true, kinds: [] }` (no events)
 * - valid array of non-empty strings, each either exact or trailing-`/*` glob
 *
 * Rejects: non-array, non-string entries, empty strings, any `*` not in
 * the trailing `/*` position.
 */
export function parseKinds(raw: unknown): ParseKindsResult {
  if (raw === undefined) return { ok: true, kinds: null };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      code: "E_SUBSCRIBE_INVALID_KINDS",
      message: "kinds must be an array of strings",
    };
  }
  // P1-4: size bound — reject pathologically large arrays before iterating.
  if (raw.length > 256) {
    return {
      ok: false,
      code: "E_SUBSCRIBE_INVALID_KINDS",
      message: "kinds array exceeds the 256-entry limit",
    };
  }
  // P1-2: typed accumulator — defensive copy prevents post-parse mutation
  // poisoning and avoids the `as string[]` cast that lets a mutable input
  // array bypass the per-entry validation done below.
  const kinds: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) {
      return {
        ok: false,
        code: "E_SUBSCRIBE_INVALID_KINDS",
        message: "kinds entries must be non-empty strings",
      };
    }
    // P1-4: entry length bound.
    if (entry.length > 128) {
      return {
        ok: false,
        code: "E_SUBSCRIBE_INVALID_KINDS",
        message: `kinds entry exceeds the 128-character limit: "${entry.slice(0, 20)}…"`,
      };
    }
    // Only trailing /* is allowed as a glob; reject any other * placement.
    const starIndex = entry.indexOf("*");
    if (starIndex !== -1) {
      if (!entry.endsWith("/*") || starIndex !== entry.length - 1) {
        return {
          ok: false,
          code: "E_SUBSCRIBE_INVALID_KINDS",
          message: `kinds entry "${entry}" — only trailing "/*" is allowed as glob`,
        };
      }
    }
    kinds.push(entry);
  }
  return { ok: true, kinds };
}
