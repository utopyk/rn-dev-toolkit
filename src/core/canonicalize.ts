/**
 * Deterministic JSON canonicalization.
 *
 * Given any JSON-serializable value, returns a string where objects have
 * their keys sorted alphabetically at every level. The audit log uses
 * this for its HMAC chain — the hash of an entry must be stable across
 * the hosts that emit it and the ones that later verify it, so we can't
 * rely on `JSON.stringify`'s insertion-order behavior.
 *
 * Relocated here from `audit-log.ts` (Phase 11 Simplicity P2): this is a
 * pure helper with no audit-log coupling, and `audit-log.ts` shouldn't
 * need a "test-only re-export" just so the cycle guard is exercisable.
 * Tests import `canonicalize` directly from this module.
 *
 * Cycle guard (Phase 10 P2-8): self-references throw an explicit
 * `AuditCanonicalizationError` rather than blowing up the call stack —
 * makes the failure traceable back to canonicalize() instead of looking
 * like a generic recursion bug.
 */

export class AuditCanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditCanonicalizationError";
  }
}

export function canonicalize(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (seen.has(value)) {
    throw new AuditCanonicalizationError(
      "canonicalize(): input contains a cycle (self-reference) and cannot be deterministically serialized",
    );
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return "[" + value.map((v) => canonicalize(v, seen)).join(",") + "]";
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map(
      (k) => JSON.stringify(k) + ":" + canonicalize(obj[k], seen),
    );
    return "{" + parts.join(",") + "}";
  } finally {
    seen.delete(value);
  }
}
