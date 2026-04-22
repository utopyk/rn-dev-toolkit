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
