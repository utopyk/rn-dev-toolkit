import Ajv, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import schema from "../manifest.schema.json" with { type: "json" };
import { ModuleError, ModuleErrorCode } from "./errors.js";
import type { ModuleManifest } from "./types.js";

export interface ManifestError {
  /** JSON Pointer into the candidate (e.g. `/contributes/mcp/tools/0/name`). */
  path: string;
  message: string;
  keyword: string;
}

export type ValidationResult =
  | { valid: true; manifest: ModuleManifest }
  | { valid: false; errors: ManifestError[] };

// Ajv's default export under ESM+esModuleInterop is the constructor.
const ajv = new Ajv({ allErrors: true, strict: false });
const validator: ValidateFunction<ModuleManifest> =
  ajv.compile<ModuleManifest>(schema);

export function validateManifest(candidate: unknown): ValidationResult {
  if (validator(candidate)) {
    return { valid: true, manifest: candidate as ModuleManifest };
  }
  return {
    valid: false,
    errors: (validator.errors ?? []).map(formatError),
  };
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
