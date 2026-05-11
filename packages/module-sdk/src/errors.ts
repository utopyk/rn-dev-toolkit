// Typed error codes surfaced by the module system.
// Stable identifiers — do not rename; any removal is a major-version bump.

export const ModuleErrorCode = {
  /** Module is in FAILED state or was never installed. */
  MODULE_UNAVAILABLE: "MODULE_UNAVAILABLE",
  /** Generic permission-denied (permissions[] advisory check). */
  E_NOT_ALLOWED: "E_NOT_ALLOWED",
  /** Module did not reach ACTIVE within the cold-start SLO. */
  MODULE_ACTIVATION_TIMEOUT: "MODULE_ACTIVATION_TIMEOUT",
  /** Host-side permission check rejected the call (e.g. missing fs:artifacts). */
  E_PERMISSION_DENIED: "E_PERMISSION_DENIED",
  /** `uses:` dependency not satisfied by the installed module set. */
  E_MISSING_DEP: "E_MISSING_DEP",
  /** Curated modules.json SHA didn't match the host-pinned value. */
  E_MANIFEST_SHA_MISMATCH: "E_MANIFEST_SHA_MISMATCH",
  /** destructiveHint tool invoked without explicit confirmation/flag. */
  E_DESTRUCTIVE_REQUIRES_CONFIRM: "E_DESTRUCTIVE_REQUIRES_CONFIRM",
  /** 3p module contributed a tool name not prefixed with `<moduleId>__`. */
  E_TOOL_NAME_UNPREFIXED: "E_TOOL_NAME_UNPREFIXED",
  /** npm lockfile integrity mismatch during marketplace install. */
  E_INTEGRITY_MISMATCH: "E_INTEGRITY_MISMATCH",
  /** host.call() target method not declared in contributes.api.methods. */
  E_METHOD_NOT_EXPOSED: "E_METHOD_NOT_EXPOSED",
  /** Manifest failed JSON Schema validation. Details include the ajv error list. */
  E_INVALID_MANIFEST: "E_INVALID_MANIFEST",
  /** Module declared a hostRange that does not include the current host version. */
  E_HOST_RANGE_MISMATCH: "E_HOST_RANGE_MISMATCH",
  /** tool/<name> request on a live subprocess threw or returned an error that wasn't one of the more specific codes above. */
  E_MODULE_CALL_FAILED: "E_MODULE_CALL_FAILED",
} as const;

export type ModuleErrorCode =
  (typeof ModuleErrorCode)[keyof typeof ModuleErrorCode];

export class ModuleError extends Error {
  readonly code: ModuleErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ModuleErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ModuleError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Hook error catalog (Phase H0)
// ---------------------------------------------------------------------------
//
// The set is intentionally narrow — 7 root codes whose meaning carries through
// the lifecycle from manifest validation (H0) to subprocess dispatch (H1+).
// `E_HOOK_CONFIG_INVALID` carries a `cause` discriminator and `E_HOOK_FAILED`
// carries an `outcome` discriminator so MCP clients render specific messages
// without the catalog fanning out into a code-per-failure-mode taxonomy.
//
// Two extras (`E_HOST_RANGE_REQUIRED` and `E_HOOK_INTERPRETER_MISSING`) were
// added during plan review. The first closes the old-daemon forward-compat
// gap; the second names the case where a script's interpreter is missing
// at fire time and would otherwise surface as a generic exec failure.

/** Discriminator for `E_HOOK_CONFIG_INVALID`. */
export type HookConfigInvalidCause =
  | "parse-failed"
  | "threw"
  | "shape-invalid"
  | "config-load-timeout"
  | "version-mismatch"
  | "path-outside-project";

/** Discriminator for `E_HOOK_FAILED`. */
export type HookFailedOutcome =
  | "multiple-override"
  | "multiple-results"
  | "crashed-before-payload"
  | "cycle-detected"
  | "path-mutated"
  | "queue-full"
  | "timeout"
  | "script-unreadable";

export const HookErrorCode = {
  /**
   * `consumes.hooks` references a `<id>/<name>` whose `<id>` is not a known
   * module. Caught at config/manifest load — never surfaces at fire time.
   */
  E_HOOK_TARGET_UNKNOWN: "E_HOOK_TARGET_UNKNOWN",
  /**
   * `consumes.hooks` references a `<id>/<name>` whose target module exists
   * but does not declare `<name>` in `provides.hooks`. Includes a
   * did-you-mean suggestion in `details.suggestion`.
   */
  E_HOOK_NAME_UNDECLARED: "E_HOOK_NAME_UNDECLARED",
  /**
   * Script path resolves outside the config-file's containing directory
   * after `realpathSync`. Fires when a symlink-then-prefix-check would
   * otherwise be bypassed.
   */
  E_HOOK_PATH_OUTSIDE_PROJECT: "E_HOOK_PATH_OUTSIDE_PROJECT",
  /**
   * A 3p module's `consumes.hooks` registers against another module's
   * `custom` override slot but the project did not opt in via
   * `allowModuleOverrides: ['<id>']`.
   */
  E_HOOK_OVERRIDE_NOT_PERMITTED: "E_HOOK_OVERRIDE_NOT_PERMITTED",
  /**
   * Project's `rn-dev.config.ts` failed to load or shape-validate. The
   * `cause` discriminator (see `HookConfigInvalidCause`) names the
   * specific subkind — clients render specific guidance per cause.
   */
  E_HOOK_CONFIG_INVALID: "E_HOOK_CONFIG_INVALID",
  /**
   * A hook fire failed at dispatch time. The `outcome` discriminator
   * (see `HookFailedOutcome`) names the specific subkind. Recovery is
   * the calling site's choice (some are retried, some abort the RPC).
   */
  E_HOOK_FAILED: "E_HOOK_FAILED",
  /**
   * `hooks/run` MCP tool received `mode: "real"` while the daemon is
   * running with `RN_DEV_DAEMON_MODE=prod`. Synthetic mode is also
   * rejected outright in production.
   */
  E_HOOK_RUN_REAL_DENIED: "E_HOOK_RUN_REAL_DENIED",
  /**
   * Manifest declares `provides.hooks` or `consumes.hooks` but its
   * `hostRange` allows daemon versions that pre-date hook support.
   * Older daemons would silently ignore the declarations.
   */
  E_HOST_RANGE_REQUIRED: "E_HOST_RANGE_REQUIRED",
  /**
   * Hook script's shebang interpreter (or implicit `node`/`bun` runtime)
   * cannot be resolved on the host. Surfaced at fire time, not registration,
   * because PATH membership is dynamic.
   */
  E_HOOK_INTERPRETER_MISSING: "E_HOOK_INTERPRETER_MISSING",
} as const;

export type HookErrorCode = (typeof HookErrorCode)[keyof typeof HookErrorCode];

/**
 * Per-code details payload. Discriminator on `code` lets clients narrow
 * without parsing the human-readable `message`.
 */
export type HookErrorDetails =
  | { code: typeof HookErrorCode.E_HOOK_TARGET_UNKNOWN; reference: string }
  | {
      code: typeof HookErrorCode.E_HOOK_NAME_UNDECLARED;
      reference: string;
      moduleId: string;
      hookName: string;
      suggestion?: string;
    }
  | {
      code: typeof HookErrorCode.E_HOOK_PATH_OUTSIDE_PROJECT;
      script: string;
      resolved: string;
      projectRoot: string;
    }
  | {
      code: typeof HookErrorCode.E_HOOK_OVERRIDE_NOT_PERMITTED;
      moduleId: string;
      targetModuleId: string;
    }
  | {
      code: typeof HookErrorCode.E_HOOK_CONFIG_INVALID;
      cause: HookConfigInvalidCause;
      configPath?: string;
      line?: number;
      column?: number;
    }
  | {
      code: typeof HookErrorCode.E_HOOK_FAILED;
      outcome: HookFailedOutcome;
      phase: `${string}/${string}`;
      moduleId: string;
      hookName: string;
      exitCode?: number;
    }
  | {
      code: typeof HookErrorCode.E_HOOK_RUN_REAL_DENIED;
      mode: "real" | "synthetic";
      daemonMode: "dev" | "prod";
    }
  | {
      code: typeof HookErrorCode.E_HOST_RANGE_REQUIRED;
      hostRange: string;
      requiredMinimum: string;
    }
  | {
      code: typeof HookErrorCode.E_HOOK_INTERPRETER_MISSING;
      interpreter: string;
      script: string;
    };

export class HookError extends Error {
  readonly code: HookErrorCode;
  readonly details: HookErrorDetails;

  constructor(message: string, details: HookErrorDetails) {
    super(message);
    this.name = "HookError";
    this.code = details.code;
    this.details = details;
  }
}
