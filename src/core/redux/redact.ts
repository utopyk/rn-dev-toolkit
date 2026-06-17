/**
 * Redux state/payload redaction — the security control for the redux
 * module (decided 2026-06-17). Pure, no I/O.
 *
 * Model (black/white list):
 *   - A leaf value is REVEALED iff its path is under a whitelist prefix
 *     AND no blacklist pattern matches its key.
 *   - A leaf value matched by the blacklist is ALWAYS redacted, even
 *     inside a whitelisted slice (defense in depth: a slice whitelisted
 *     today that later grows a `token` field still won't leak it).
 *   - Everything else: `mcp-redacted` ⇒ structure-only (`<type>`
 *     placeholder, keys + shape preserved); `full` ⇒ revealed (the
 *     human panel's looser default) but STILL honoring the blacklist.
 *
 * Object/array structure is always preserved (keys + nesting) regardless
 * of mode — only leaf VALUES are hidden. This lets an agent see the shape
 * of state ("there's an `auth.session` object with a `token` string")
 * without the values.
 *
 * Bounded: recursion is capped at `MAX_DEPTH` and total visited nodes at
 * `MAX_NODES`; beyond either, the subtree collapses to a marker and the
 * `truncated` flag is set. Prevents a pathological/huge state tree from
 * blowing the daemon's CPU/memory or an MCP response size.
 */

import type { RedactionConfig } from "./types.js";

/** Placeholder substituted for a redacted/hidden leaf value. */
export const REDACTED = "[redacted]";

export const MAX_DEPTH = 12;
export const MAX_NODES = 10_000;

/**
 * Default blacklist — key globs that must never reach an agent. Tuned for
 * a payments app (acme): auth material, payment fields, and
 * direct PII. `*x*` matches any key containing `x`; bare words match the
 * whole key. Projects extend this via module config.
 */
export const DEFAULT_BLACKLIST: readonly string[] = [
  "*token*",
  "*password*",
  "*secret*",
  "*auth*",
  "*credential*",
  "*card*",
  "*cvv*",
  "*pan*",
  "*ssn*",
  "*apikey*",
  "*api_key*",
  "email",
  "*email*",
  "phone",
  "*phone*",
];

export interface RedactResult {
  readonly value: unknown;
  /** Count of leaf values redacted (blacklist or structure-only). */
  readonly redactedCount: number;
  /** True if depth/node caps collapsed part of the tree. */
  readonly truncated: boolean;
}

/** Compile a `*`-glob to an anchored, case-insensitive RegExp. */
function compileGlob(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex metachars
    .replace(/\*/g, ".*"); // glob star → any run
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Compile a blacklist once and reuse across a whole walk. Returns a
 * predicate over key names.
 */
export function makeBlacklistMatcher(
  blacklist: readonly string[],
): (key: string) => boolean {
  const globs = blacklist.map(compileGlob);
  return (key: string) => globs.some((g) => g.test(key));
}

/**
 * True when `path` (dot-joined) is at or under any whitelist prefix.
 * `auth` whitelists `auth`, `auth.session`, `auth.session.user`, but not
 * `authSettings` (prefix match is segment-aware: equal, or followed by
 * `.`).
 */
export function isWhitelisted(path: string, whitelist: readonly string[]): boolean {
  if (path === "") return false;
  return whitelist.some(
    (prefix) => path === prefix || path.startsWith(prefix + "."),
  );
}

function typePlaceholder(value: unknown): string {
  if (value === null) return "<null>";
  if (Array.isArray(value)) return "<array>";
  const t = typeof value;
  return `<${t}>`;
}

/**
 * Redact a value tree per `config`. `rootPath` lets callers redact a
 * sub-slice while keeping whitelist/blacklist semantics relative to the
 * full state path (e.g. reading `auth.session` still evaluates the
 * whitelist against `auth.session.*`).
 */
export function redactValue(
  value: unknown,
  config: RedactionConfig,
  rootPath = "",
): RedactResult {
  const isBlacklisted = makeBlacklistMatcher(config.blacklist);
  let redactedCount = 0;
  let truncated = false;
  let nodes = 0;

  const walk = (val: unknown, path: string, depth: number, keyName: string): unknown => {
    nodes++;
    if (depth > MAX_DEPTH || nodes > MAX_NODES) {
      truncated = true;
      return "<truncated>";
    }

    // Blacklisted key → always redacted, regardless of mode/whitelist.
    if (keyName !== "" && isBlacklisted(keyName)) {
      redactedCount++;
      return REDACTED;
    }

    if (val !== null && typeof val === "object") {
      if (Array.isArray(val)) {
        return val.map((item, i) => walk(item, `${path}[${i}]`, depth + 1, ""));
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        const childPath = path === "" ? k : `${path}.${k}`;
        out[k] = walk(v, childPath, depth + 1, k);
      }
      return out;
    }

    // Leaf value.
    if (config.mode === "full") return val; // human panel: reveal (blacklist already applied above)
    if (isWhitelisted(path, config.whitelist)) return val; // agent: revealed slice
    redactedCount++;
    return typePlaceholder(val);
  };

  const out = walk(value, rootPath, 0, "");
  return { value: out, redactedCount, truncated };
}
