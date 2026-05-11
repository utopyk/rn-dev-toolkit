import AjvDefault, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import semver from "semver";
import schema from "../manifest.schema.json" with { type: "json" };
import { ModuleError, ModuleErrorCode } from "./errors.js";
import type { ModuleManifest } from "./types.js";

/**
 * Host minor version that introduced hook fields. Manifests declaring
 * `provides.hooks` or `consumes.hooks` MUST require at least this minor
 * via their `hostRange`, or older daemons would silently ignore the
 * declarations and produce confusing runtime behavior.
 *
 * Bump in lockstep with daemon major/minor releases that add or change
 * hook semantics.
 */
export const HOOK_FIELDS_HOST_MINIMUM = "0.1.0";

export interface ManifestError {
  /** JSON Pointer into the candidate (e.g. `/contributes/mcp/tools/0/name`). */
  path: string;
  message: string;
  keyword: string;
}

export type ValidationResult =
  | { valid: true; manifest: ModuleManifest }
  | { valid: false; errors: ManifestError[] };

// Ajv publishes as CJS without an `exports` map, so the esm default-interop
// shape differs between `moduleResolution: bundler` (where the default is
// the class directly) and `moduleResolution: NodeNext` (where it's
// `{ default: Class }`). The any-cast below lets the SDK compile cleanly
// under both — its consumers (modules/*) use NodeNext, the SDK itself is
// built in bundler mode.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvAny = AjvDefault as any;
const AjvCtor = (AjvAny?.default ?? AjvAny) as new (
  opts?: { allErrors?: boolean; strict?: boolean }
) => { compile<T>(schema: unknown): ValidateFunction<T> };
const ajv = new AjvCtor({ allErrors: true, strict: false });
const validator: ValidateFunction<ModuleManifest> =
  ajv.compile<ModuleManifest>(schema);

export function validateManifest(candidate: unknown): ValidationResult {
  const schemaOk = validator(candidate);
  const schemaErrors: ManifestError[] = schemaOk
    ? []
    : (validator.errors ?? []).map(formatError);

  // Post-schema cross-field checks. We run these whenever the candidate
  // is shape-plausible enough to read the relevant fields, even if the
  // schema rejected something else — that surfaces all problems at once
  // rather than forcing the author through a fix-rerun-fix loop.
  const hostRangeErrors =
    typeof candidate === "object" && candidate !== null
      ? checkHookHostRange(candidate as Partial<ModuleManifest>)
      : [];

  if (schemaOk && hostRangeErrors.length === 0) {
    return { valid: true, manifest: candidate as ModuleManifest };
  }
  return { valid: false, errors: [...schemaErrors, ...hostRangeErrors] };
}

/**
 * Author-facing helper. Validates the manifest at runtime and throws a
 * `ModuleError` with `E_INVALID_MANIFEST` on schema violation.
 *
 * Does NOT enforce the `<moduleId>__<tool>` 3p prefix — that rule applies only
 * to third-party modules and is checked by the host registry at load time.
 */
export function defineModule<T extends ModuleManifest>(manifest: T): T {
  const result = validateManifest(manifest);
  if (!result.valid) {
    throw new ModuleError(
      ModuleErrorCode.E_INVALID_MANIFEST,
      formatErrorSummary(result.errors),
      { errors: result.errors },
    );
  }
  return manifest;
}

/**
 * Enforce the tool-prefix policy on a manifest that's already schema-valid.
 *
 * Third-party modules MUST prefix every MCP tool with `<manifest.id>__`.
 * Built-ins are exempt (they keep the flat namespace).
 *
 * Throws `ModuleError` with `E_TOOL_NAME_UNPREFIXED` on the first offending
 * tool.
 */
export function enforceToolPrefix(
  manifest: ModuleManifest,
  options: { isBuiltIn: boolean },
): void {
  if (options.isBuiltIn) return;
  const tools = manifest.contributes?.mcp?.tools ?? [];
  const prefix = `${manifest.id}__`;
  for (const tool of tools) {
    if (!tool.name.startsWith(prefix)) {
      throw new ModuleError(
        ModuleErrorCode.E_TOOL_NAME_UNPREFIXED,
        `Third-party tool "${tool.name}" must be prefixed with "${prefix}" (module id: "${manifest.id}").`,
        { moduleId: manifest.id, toolName: tool.name, expectedPrefix: prefix },
      );
    }
  }
}

function formatError(err: ErrorObject): ManifestError {
  return {
    path: err.instancePath || "/",
    message: err.message ?? "invalid",
    keyword: err.keyword,
  };
}

function formatErrorSummary(errors: ManifestError[]): string {
  const lines = errors.map(
    (e) => `  ${e.path}: ${e.message} (${e.keyword})`,
  );
  return `Invalid rn-dev module manifest:\n${lines.join("\n")}`;
}

function checkHookHostRange(
  manifest: Partial<ModuleManifest>,
): ManifestError[] {
  const provides = manifest.provides;
  const consumes = manifest.consumes;
  const declaresHooks =
    (provides !== undefined && provides.hooks !== undefined) ||
    (consumes !== undefined && consumes.hooks !== undefined);
  if (!declaresHooks) return [];

  const hostRange = manifest.hostRange;
  if (typeof hostRange !== "string" || hostRange.length === 0) {
    // No hostRange present — schema validation will already flag it; nothing
    // useful to add here.
    return [];
  }

  const minVer = semver.minVersion(hostRange);
  if (minVer === null) {
    return [
      {
        path: "/hostRange",
        message: `Manifest declares hook fields but hostRange "${hostRange}" is not a parseable semver range.`,
        keyword: "E_HOST_RANGE_REQUIRED",
      },
    ];
  }
  if (semver.lt(minVer, HOOK_FIELDS_HOST_MINIMUM)) {
    return [
      {
        path: "/hostRange",
        message: `Manifest declares hook fields but hostRange "${hostRange}" allows daemon versions older than ${HOOK_FIELDS_HOST_MINIMUM}, which would silently drop the hook declarations.`,
        keyword: "E_HOST_RANGE_REQUIRED",
      },
    ];
  }
  return [];
}
