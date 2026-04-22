import { ModuleError, ModuleErrorCode } from "@rn-dev/module-sdk";

// MetaMCP convention — also used by Phase 1's enforceToolPrefix at manifest
// load time. Kept as a constant so future widenings of the separator (e.g. to
// allow a literal __ inside a tool suffix) go through one code path.
export const TOOL_NAMESPACE_SEPARATOR = "__";

/**
 * Split a tool name into (moduleId, tool) pair, or `null` if the name does
 * NOT use the double-underscore 3p convention (built-ins pass through flat).
 *
 *   "device-control__screenshot"   → { moduleId: "device-control", tool: "screenshot" }
 *   "device-control__record__stop" → { moduleId: "device-control", tool: "record__stop" }
 *   "metro/reload"                 → null (built-in)
 */
export function splitNamespacedToolName(
  name: string,
): { moduleId: string; tool: string } | null {
  const idx = name.indexOf(TOOL_NAMESPACE_SEPARATOR);
  if (idx <= 0) return null;
  const moduleId = name.slice(0, idx);
  const tool = name.slice(idx + TOOL_NAMESPACE_SEPARATOR.length);
  if (!tool) return null;
  return { moduleId, tool };
}

/**
 * Built-ins keep the flat namespace (`metro/*`, `devtools/*`, `modules/*`,
 * `marketplace/*`, `rn-dev/*`). Returns `true` when `name` looks flat — i.e.
 * contains no `__` separator.
 */
export function isFlatNamespaceTool(name: string): boolean {
  return !name.includes(TOOL_NAMESPACE_SEPARATOR);
}

export interface AssertMcpToolNameInput {
  moduleId: string;
  name: string;
  isBuiltIn: boolean;
}

/**
 * Validate a tool name against the Phase 1 contract:
 *   - Third-party tool MUST be `<moduleId>__<tool>`.
 *   - Built-in tool MUST NOT use the `__` separator (forces `metro/*` form).
 *
 * Throws a typed `ModuleError(E_TOOL_NAME_UNPREFIXED)` on any violation so
 * the MCP boundary can surface the code to agents the same way the
 * manifest-load path does.
 */
export function assertMcpToolName(input: AssertMcpToolNameInput): void {
  if (input.isBuiltIn) {
    if (!isFlatNamespaceTool(input.name)) {
      throw new ModuleError(
        ModuleErrorCode.E_TOOL_NAME_UNPREFIXED,
        `Built-in module "${input.moduleId}" contributed tool "${input.name}" which uses the 3p double-underscore form; built-ins must use the flat namespace (e.g. "${input.moduleId}/<verb>").`,
        { moduleId: input.moduleId, name: input.name, isBuiltIn: true },
      );
    }
    return;
  }

  const expectedPrefix = `${input.moduleId}${TOOL_NAMESPACE_SEPARATOR}`;
  if (!input.name.startsWith(expectedPrefix)) {
    throw new ModuleError(
      ModuleErrorCode.E_TOOL_NAME_UNPREFIXED,
      `Third-party tool "${input.name}" must be prefixed with "${expectedPrefix}" (module id: "${input.moduleId}").`,
      {
        moduleId: input.moduleId,
        name: input.name,
        expectedPrefix,
        isBuiltIn: false,
      },
    );
  }
}
