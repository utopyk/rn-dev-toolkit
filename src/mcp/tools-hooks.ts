// Phase H2j + H2k — agent-facing MCP tools for the hook system.
//
// `rn-dev/hooks-diagnose` (H2j): tail the audit log for hook failures,
// optionally narrowed by target. Hoisted from H6 because agent-driven
// debugging during the e2e milestone needs a way to ask "did my
// build/pre fire? if so, did it succeed?" without `tail -f`.
//
// `rn-dev/hooks-config-validate` (H2k): load the project's
// rn-dev.config.* and cross-check declared hook keys against the
// host's built-in module manifests. Catches typos like "build/before"
// (instead of "build/pre") at validate-time rather than at first hook
// fire. The plan originally called for tsc --noEmit + a generated
// node_modules/@rn-dev/config/types-augment.d.ts; the runtime
// manifest cross-check catches the same typo class without spawning
// tsc, and lands the agent surface in H2's e2e milestone budget.
// Generated-types-augment + tsc lands at H7 once the docs phase
// settles the @rn-dev/config publish story.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModuleManifest } from "@rn-dev/module-sdk";
import {
  buildManifest,
  devSpaceManifest,
  lintTestManifest,
  sessionManifest,
  settingsManifest,
} from "../modules/built-in/manifests.js";
import type { ToolDefinition } from "./tools.js";

interface HookAuditEntry {
  kind: "hook";
  phase: string;
  source: string;
  scriptOrSymbol?: string;
  durationMs?: number;
  exitCode?: number;
  outcome?: string;
  ts?: number;
  seq?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function defaultAuditLogPath(): string {
  return join(homedir(), ".rn-dev", "audit.log");
}

/**
 * Tail the audit log file, parse JSON-line entries, filter to
 * `kind: "hook"` (optionally narrowed to a `target` phase), and
 * return the last `limit` matching entries in chronological order
 * (oldest → newest).
 *
 * Returns an empty array if the audit log does not exist (no hooks
 * have ever fired on this machine) — that's a normal state, not an
 * error.
 */
export function readHookAuditTail(opts: {
  limit: number;
  target?: string;
  auditLogPath?: string;
}): HookAuditEntry[] {
  const path = opts.auditLogPath ?? defaultAuditLogPath();
  if (!existsSync(path)) return [];

  // The audit log can grow large (acme env shows ~280 KB after a
  // few sessions). Reading the entire file is acceptable for H2j —
  // 280 KB streamed parse is sub-millisecond, and the agent caller
  // has already paid the round-trip cost. Smarter tail-from-end
  // streaming lands at H6 if we need it.
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n");
  const matches: HookAuditEntry[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof entry !== "object" ||
      entry === null ||
      (entry as { kind?: unknown }).kind !== "hook"
    ) {
      continue;
    }
    const hookEntry = entry as HookAuditEntry;
    if (opts.target && hookEntry.phase !== opts.target) continue;
    matches.push(hookEntry);
    if (matches.length >= opts.limit) break;
  }
  return matches.reverse();
}

// ---------------------------------------------------------------------------
// hooks-config-validate (H2k)
// ---------------------------------------------------------------------------

const PROJECT_CONFIG_BASENAMES = [
  "rn-dev.config.mjs",
  "rn-dev.config.mts",
  "rn-dev.config.ts",
  "rn-dev.config.js",
] as const;

/**
 * Built-in module manifests known to the host at runtime. The marketplace
 * built-in is registered separately and contributes no hooks; everything
 * a hooks-config-validate call needs lives in this list (H3 will append
 * Clean / Metro / DevTools / Preflight here as those modules land).
 */
const KNOWN_MANIFESTS: ReadonlyArray<ModuleManifest> = [
  buildManifest,
  devSpaceManifest,
  lintTestManifest,
  sessionManifest,
  settingsManifest,
];

interface HookValidationError {
  /** The hook key as it appeared in the user's config. */
  key: string;
  reason:
    | "unknown-module"
    | "unknown-slot"
    | "malformed-key"
    | "config-load-failed";
  message: string;
  /** Most-similar known slot, when reason is unknown-module/unknown-slot. */
  suggestion?: string;
}

interface HookConfigValidateResult {
  configFile: string | null;
  valid: boolean;
  errorCount: number;
  errors: HookValidationError[];
  knownSlots: string[];
}

function findProjectConfig(projectRoot: string): string | null {
  for (const basename of PROJECT_CONFIG_BASENAMES) {
    const candidate = join(projectRoot, basename);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function knownSlotsFromManifests(
  manifests: ReadonlyArray<ModuleManifest>,
): string[] {
  const out: string[] = [];
  for (const m of manifests) {
    const hooks = m.provides?.hooks;
    if (!hooks) continue;
    for (const hookName of hooks) {
      out.push(`${m.id}/${hookName}`);
    }
  }
  return out.sort();
}

/**
 * Trivially-cheap nearest-neighbour: pick the candidate sharing the
 * longest common prefix with `key`. Good enough to catch swap-the-noun
 * typos (`build/before` → `build/pre`); we don't need full Levenshtein
 * for the agent debugging case.
 */
function suggestNearest(
  key: string,
  candidates: ReadonlyArray<string>,
): string | undefined {
  let best: string | undefined;
  let bestLen = 0;
  for (const c of candidates) {
    let i = 0;
    while (i < key.length && i < c.length && key[i] === c[i]) i++;
    if (i > bestLen) {
      bestLen = i;
      best = c;
    }
  }
  // Only suggest when we share at least the module-id prefix
  // (`build/`) so the suggestion is plausibly related.
  return bestLen >= 2 ? best : undefined;
}

export async function validateHookConfig(opts: {
  projectRoot: string;
  manifests?: ReadonlyArray<ModuleManifest>;
}): Promise<HookConfigValidateResult> {
  const manifests = opts.manifests ?? KNOWN_MANIFESTS;
  const knownSlots = knownSlotsFromManifests(manifests);
  const configFile = findProjectConfig(opts.projectRoot);
  if (configFile === null) {
    return {
      configFile: null,
      valid: true,
      errorCount: 0,
      errors: [],
      knownSlots,
    };
  }

  // loadConfig is dynamic-import-based and the same code path the
  // daemon uses; mirroring it here means a CONFIG that loads
  // successfully under the daemon will load successfully here.
  let config: { hooks?: Record<string, unknown> };
  try {
    const mod = await import("@rn-dev/config");
    config = (await mod.loadConfig(configFile, {
      projectRoot: opts.projectRoot,
    })) as { hooks?: Record<string, unknown> };
  } catch (err) {
    return {
      configFile,
      valid: false,
      errorCount: 1,
      errors: [
        {
          key: "<config-file>",
          reason: "config-load-failed",
          message: err instanceof Error ? err.message : String(err),
        },
      ],
      knownSlots,
    };
  }

  const errors: HookValidationError[] = [];
  const declared = config.hooks ?? {};
  const knownSet = new Set(knownSlots);
  const knownModules = new Set(manifests.map((m) => m.id));

  for (const key of Object.keys(declared)) {
    const slash = key.indexOf("/");
    if (slash <= 0 || slash === key.length - 1) {
      errors.push({
        key,
        reason: "malformed-key",
        message: `hook key "${key}" must be of the form "<moduleId>/<hookName>".`,
      });
      continue;
    }
    const moduleId = key.slice(0, slash);
    if (!knownModules.has(moduleId)) {
      errors.push({
        key,
        reason: "unknown-module",
        message: `hook key "${key}" references unknown module "${moduleId}". 3p modules contributed via consumes.hooks must be installed before validation can resolve their slots.`,
        suggestion: suggestNearest(key, knownSlots),
      });
      continue;
    }
    if (!knownSet.has(key)) {
      errors.push({
        key,
        reason: "unknown-slot",
        message: `hook key "${key}" — module "${moduleId}" does not declare a "${key.slice(slash + 1)}" slot in provides.hooks.`,
        suggestion: suggestNearest(key, knownSlots),
      });
    }
  }

  return {
    configFile,
    valid: errors.length === 0,
    errorCount: errors.length,
    errors,
    knownSlots,
  };
}

export function buildHooksTools(): ToolDefinition[] {
  return [
    {
      name: "rn-dev/hooks-diagnose",
      description:
        "Inspect recent hook fires from the audit log. Use after a build/pre or build/post hook fails to see what the runner recorded — the daemon writes a `kind: \"hook\"` audit entry on every failure (success path is silent by design). Optionally narrow by `target` (e.g. \"build/pre\") to focus on one slot.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Optional. Hook target phase to filter by (e.g. \"build/pre\", \"session/init\"). When omitted, returns recent failures across all targets.",
          },
          limit: {
            type: "number",
            description: `Maximum number of entries to return. Default: ${DEFAULT_LIMIT}. Max: ${MAX_LIMIT}.`,
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          auditLogPath: { type: "string" },
          matchedCount: { type: "number" },
          entries: { type: "array" },
          advice: { type: "string" },
        },
      },
      handler: async (args) => {
        const target = typeof args.target === "string" ? args.target : undefined;
        const limit =
          typeof args.limit === "number" && args.limit > 0
            ? Math.min(Math.floor(args.limit), MAX_LIMIT)
            : DEFAULT_LIMIT;
        const auditLogPath = defaultAuditLogPath();
        const entries = readHookAuditTail({ limit, target, auditLogPath });

        let advice: string | undefined;
        if (entries.length === 0) {
          advice = target
            ? `No audit entries for ${target}. Audit only writes on failure; if the hook ran successfully, there will be no entry. Check the source rn-dev.config.* registers a script or fn against this slot.`
            : "No hook failure entries in the audit log. If you expected one, check the daemon is running and rn-dev.config.* is being walked at boot (look for a 'Registered N project hooks' line in session/log).";
        } else {
          const last = entries[entries.length - 1];
          advice = `Most recent ${target ?? "hook"} failure: outcome=${last.outcome ?? "unknown"}${last.exitCode !== undefined ? `, exitCode=${last.exitCode}` : ""}. Check the script source for clues; replicate by re-firing through the daemon RPC.`;
        }

        return {
          structuredContent: {
            auditLogPath,
            matchedCount: entries.length,
            entries,
            ...(advice ? { advice } : {}),
          },
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { auditLogPath, matchedCount: entries.length, entries, advice },
                null,
                2,
              ),
            },
          ],
        };
      },
    },
    {
      name: "rn-dev/hooks-config-validate",
      description:
        "Validate the project's rn-dev.config.* by cross-checking every declared hook key (e.g. \"build/pre\") against the host's built-in module manifests. Catches typos like \"build/before\" at validate-time rather than at first hook fire. Returns the list of unknown-module / unknown-slot errors with did-you-mean suggestions.",
      inputSchema: {
        type: "object",
        properties: {
          projectRoot: {
            type: "string",
            description:
              "Optional. Project root to look for rn-dev.config.* in. Defaults to the MCP server's projectRoot.",
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          configFile: { type: "string" },
          valid: { type: "boolean" },
          errorCount: { type: "number" },
          errors: { type: "array" },
          knownSlots: { type: "array" },
        },
      },
      handler: async (args) => {
        const projectRoot =
          typeof args.projectRoot === "string" && args.projectRoot.length > 0
            ? args.projectRoot
            : process.cwd();
        const result = await validateHookConfig({ projectRoot });
        return {
          structuredContent: result as unknown as Record<string, unknown>,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    },
  ];
}
