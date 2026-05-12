// Narrowers for daemon RPC payloads. Phase D0.5 foundation work —
// counterpart of [packages/module-sdk/src/args.ts] but for daemon-side
// RPC handlers (whose payloads arrive as `Record<string, unknown>` on
// the wire and otherwise get read with raw property access).
//
// The Phase D1+ supervisor refactor will thread `sessionId` through
// every RPC handler in [src/daemon/index.ts:428-660]. Without narrowers,
// each handler reads `payload.sessionId` as `unknown` and the raw access
// pattern proliferates. With them, handlers say
// `requireSessionId(payload, "session/stop")` and the brand makes the
// flow type-safe end-to-end.
//
// Pattern mirrors `requireStr` / `str` in
// [packages/module-sdk/src/args.ts] — the `tool` (here: `where`)
// argument is used in the error message so an operator can tell which
// handler rejected the call.

import {
  asSessionId,
  type SessionId,
} from "../core/identifiers.js";
import {
  validateProfile,
  type ValidatedProfile,
} from "./profile-guard.js";

/**
 * Internal RPC payload shape — RPC handlers receive an unknown blob
 * after JSON parsing. Narrow per-field through the helpers below; do
 * not access fields directly.
 */
export type RpcPayload = Record<string, unknown>;

/**
 * Read a non-empty string `sessionId` from the payload. Throws
 * `RpcArgError` ("E_RPC_INVALID_PAYLOAD") with a helpful context when
 * missing or malformed.
 *
 * Returns the branded `SessionId` so callers can pass it directly into
 * `Map<SessionId, ...>.get(...)` without further casts.
 */
export function requireSessionId(
  payload: unknown,
  where: string,
): SessionId {
  const sid = stringField(payload, "sessionId");
  if (sid === undefined) {
    throw new RpcArgError(
      "E_RPC_INVALID_PAYLOAD",
      `${where}: sessionId required`,
    );
  }
  return asSessionId(sid);
}

/**
 * Optional sessionId — returns `undefined` if absent or malformed.
 * Used by `events/subscribe` and `sessions/list`, which both accept
 * a missing sessionId (with different meanings — see plan § A4).
 */
export function optionalSessionId(payload: unknown): SessionId | undefined {
  const sid = stringField(payload, "sessionId");
  return sid === undefined ? undefined : asSessionId(sid);
}

/**
 * Read a `profile` field through `validateProfile` and return the
 * branded `ValidatedProfile`. Throws on absence or validation failure;
 * the error code is the validator's own (`E_PROFILE_*`) so operators
 * see the specific field that failed, not a generic
 * `E_RPC_INVALID_PAYLOAD`.
 */
export function requireProfile(
  payload: unknown,
  where: string,
): ValidatedProfile {
  if (!payload || typeof payload !== "object") {
    throw new RpcArgError(
      "E_RPC_INVALID_PAYLOAD",
      `${where}: payload not object`,
    );
  }
  const raw = (payload as RpcPayload).profile;
  const result = validateProfile(raw);
  if (!result.ok) {
    throw new RpcArgError(result.code, `${where}: ${result.message}`);
  }
  return result.profile;
}

/**
 * Optional `profile` field — returns `undefined` if absent. Returns a
 * validated profile when present; throws (not returns undefined) if a
 * profile-shaped value is present but malformed, so silent-skip bugs
 * don't hide bad payloads. Used by `events/subscribe`.
 */
export function optionalProfile(
  payload: unknown,
  where: string,
): ValidatedProfile | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const raw = (payload as RpcPayload).profile;
  if (raw === undefined || raw === null) return undefined;
  const result = validateProfile(raw);
  if (!result.ok) {
    throw new RpcArgError(result.code, `${where}: ${result.message}`);
  }
  return result.profile;
}

/**
 * Discriminated input for `events/subscribe`. Phase D2 reads the wire
 * payload through `parseEventsSubscribeInput` and dispatches by `mode`;
 * the `{ profile && sessionId }` cell from the original four-cell
 * matrix becomes unrepresentable at compile time.
 *
 * Observer-mode (the original `{ neither }` cell) was replaced with
 * an explicit `sessions/list` RPC — see plan § B2.
 */
export type EventsSubscribeInput =
  | { mode: "boot-or-join"; profile: ValidatedProfile }
  | { mode: "attach-by-id"; sessionId: SessionId };

/**
 * Parse an `events/subscribe` payload into the discriminated union.
 * Rejects payloads with both fields, neither field, or malformed
 * profile / sessionId. The error code distinguishes the failure mode
 * (`E_SUBSCRIBE_INVALID_ARGS` for shape problems vs the validator's
 * own `E_PROFILE_*` for profile content).
 *
 * Note: this is type-level scaffolding for Phase D2; today's
 * `events/subscribe` handler in [src/daemon/index.ts] still consumes
 * the legacy shape. The parser ships here so D2 can adopt it without
 * inventing parsing rules on the fly.
 */
export function parseEventsSubscribeInput(
  payload: unknown,
  where: string,
): EventsSubscribeInput {
  const hasProfile =
    !!payload &&
    typeof payload === "object" &&
    (payload as RpcPayload).profile !== undefined &&
    (payload as RpcPayload).profile !== null;
  const hasSessionId =
    stringField(payload, "sessionId") !== undefined;

  if (hasProfile && hasSessionId) {
    throw new RpcArgError(
      "E_SUBSCRIBE_INVALID_ARGS",
      `${where}: pass either profile or sessionId, not both`,
    );
  }
  if (!hasProfile && !hasSessionId) {
    throw new RpcArgError(
      "E_SUBSCRIBE_INVALID_ARGS",
      `${where}: pass either profile (boot-or-join) or sessionId (attach-by-id)`,
    );
  }

  if (hasProfile) {
    return { mode: "boot-or-join", profile: requireProfile(payload, where) };
  }
  return { mode: "attach-by-id", sessionId: requireSessionId(payload, where) };
}

/**
 * Lightweight error carrying both a daemon-RPC code and a message.
 * Handlers catch this and convert it to the wire error shape; the
 * `code` survives unchanged so test assertions on
 * `code: "E_RPC_INVALID_PAYLOAD"` stay green across the migration.
 */
export class RpcArgError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "RpcArgError";
  }
}

function stringField(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const v = (payload as RpcPayload)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
