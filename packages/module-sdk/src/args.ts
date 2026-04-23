/**
 * Arg narrowing primitives for module tool handlers.
 *
 * Module tool handlers receive `Record<string, unknown>` on the wire. MCP
 * validates incoming args against the manifest's `inputSchema` before
 * dispatch, but that validation is not the handler's only line of
 * defense — a direct `vscode-jsonrpc` poke over the stdio socket, or a
 * schema/handler drift, must not blow up with a `TypeError`. Handlers
 * narrow defensively at the boundary, then dispatch typed shapes to the
 * inner tool functions.
 *
 * This file is the shared library of those narrowers — the Phase 9 / 11
 * / 11-device-control triad duplicated these helpers verbatim. Phase 12
 * promotes them here (Rule-of-Three). Module-specific narrowers
 * (e.g. `stream` for `stdout|stderr`, `statusRange` for HTTP status
 * tuples) stay in their owning module — only the general-purpose
 * primitives live in the SDK. Import these via the SDK barrel
 * (`@rn-dev/module-sdk`); the file-relative path `./args.ts` is the
 * source location, not a public subpath export.
 */

export type Args = Record<string, unknown>;

/** Non-empty string at `args[key]`, else `undefined`. */
export function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Finite number at `args[key]`, else `undefined`. Accepts negatives and
 * non-integers — the caller is responsible for tighter gating (e.g.
 * `Number.isInteger`, range checks) when the wire field requires it.
 * For bounded integer fields like pagination `limit`, prefer
 * `boundedInt` instead.
 */
export function num(args: Args, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Bounded integer at `args[key]`. Returns the value only if it is a
 * finite integer within the inclusive `[min, max]` range; `undefined`
 * otherwise (wrong type, non-integer, out of range). Pagination knobs
 * like `limit` use this to fold type + range checks into one call,
 * replacing the `Number.isInteger && > 0 && <= MAX` inline pattern that
 * used to live in each module's `extractFilter`.
 */
export function boundedInt(
  args: Args,
  key: string,
  opts: { min: number; max: number },
): number | undefined {
  if (opts.min > opts.max) {
    // Caller-config bug, not wire-data. Fail loud so a dynamically-
    // computed `max` that drops below `min` surfaces at test time
    // rather than silently returning `undefined` for every input.
    throw new Error(
      `boundedInt: min (${opts.min}) > max (${opts.max})`,
    );
  }
  const v = args[key];
  if (typeof v !== "number" || !Number.isInteger(v)) return undefined;
  if (v < opts.min || v > opts.max) return undefined;
  return v;
}

/**
 * Array of non-empty strings at `args[key]`, else `undefined`. Filters
 * out non-string / empty entries; returns `undefined` when the filter
 * leaves the array empty (vs. `[]`) so the caller can branch on presence
 * without a length check.
 */
export function strArr(args: Args, key: string): string[] | undefined {
  const v = args[key];
  if (!Array.isArray(v)) return undefined;
  const out = v.filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  return out.length > 0 ? out : undefined;
}

/**
 * `str` with throw-on-missing. `tool` is the MCP tool name, used in the
 * error message so an operator can tell which handler rejected the call.
 */
export function requireStr(args: Args, key: string, tool: string): string {
  const v = str(args, key);
  if (v === undefined) {
    throw new Error(`${tool}: ${key} is required`);
  }
  return v;
}

/** `num` with throw-on-missing. See `requireStr` for the `tool` convention. */
export function requireNum(args: Args, key: string, tool: string): number {
  const v = num(args, key);
  if (v === undefined) {
    throw new Error(`${tool}: ${key} is required`);
  }
  return v;
}

/**
 * Ring-buffer cursor narrower. Modules that stream capture data (metro
 * logs, devtools network) share a cursor shape: `{ bufferEpoch, sequence }`
 * where both are finite numbers. Returns that shape if present and
 * well-formed; `undefined` otherwise.
 *
 * **Returns a fresh object containing only the two known fields.** Any
 * extra properties on the wire cursor are dropped — the return is
 * deliberately the minimal structural shape. If a future cursor variant
 * carries additional fields (e.g. `version`), it will need its own
 * narrower.
 *
 * The return type's fields are `readonly` for caller-side clarity;
 * TypeScript structural widening still assigns cleanly into branded or
 * `readonly`-tagged local cursor types (`MetroLogsCursor`,
 * `NetworkCursor`) at the call site.
 *
 * Default key is `"since"` because that's what every cursor-carrying
 * tool (today's `metro-logs__list`, `devtools-network__list`) names the
 * field on the wire. Pass a different key if a future tool diverges.
 */
export function ringCursor(
  args: Args,
  key: string = "since",
): { readonly bufferEpoch: number; readonly sequence: number } | undefined {
  const v = args[key];
  if (!v || typeof v !== "object") return undefined;
  const c = v as { bufferEpoch?: unknown; sequence?: unknown };
  if (typeof c.bufferEpoch !== "number" || !Number.isFinite(c.bufferEpoch)) {
    return undefined;
  }
  if (typeof c.sequence !== "number" || !Number.isFinite(c.sequence)) {
    return undefined;
  }
  return { bufferEpoch: c.bufferEpoch, sequence: c.sequence };
}
