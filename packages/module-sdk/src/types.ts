// Types for rn-dev module manifests. Hand-written to match manifest.schema.json.
// Any additive change here must also update the JSON schema; any removal or
// type-narrowing is a major-version bump (schema is additive-only within 1.x).

export type ModuleScope = "global" | "per-worktree" | "workspace";

export interface McpToolContribution {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  destructiveHint?: boolean;
  readOnlyHint?: boolean;
  openWorldHint?: boolean;
}

export interface ElectronPanelContribution {
  id: string;
  title: string;
  icon?: string;
  webviewEntry: string;
  hostApi: string[];
}

export interface TuiViewContribution {
  id: string;
  title: string;
  icon?: string;
}

export interface ApiMethodContribution {
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface ModuleContributions {
  mcp?: { tools: McpToolContribution[] };
  electron?: { panels: ElectronPanelContribution[] };
  tui?: { views: TuiViewContribution[] };
  /** Reserved for Phase 10. Schema validates but host ignores in v1. */
  api?: { methods: Record<string, ApiMethodContribution> };
  /** Reserved for Phase 5. Schema validates but host ignores in v1. */
  config?: { schema: Record<string, unknown> };
}

export interface UsesEntry {
  id: string;
  versionRange: string;
}

// ---------------------------------------------------------------------------
// Hook contribution points (Phase H0)
// ---------------------------------------------------------------------------
//
// `provides.hooks` is the module's contribution-point declaration: a list of
// short names (e.g. `["pre", "post", "custom"]`) that other modules — and
// the project's `rn-dev.config.ts` — may target as `<thisModuleId>/<name>`.
//
// `consumes.hooks` is the module's registration list against other modules'
// contribution points. Keys are the fully-qualified `<id>/<name>` reference;
// values describe how to invoke the registration.
//
// Both fields are validated against `manifest.schema.json`. The HookManager
// (Phase H1+) walks these into its registry at session boot.

/**
 * A registration entry inside `consumes.hooks`. Discriminated by the
 * presence of `script` vs `fn` — string is sugar for `{ script }`.
 *
 * Note: `fn` is only meaningful for in-process modules (built-ins). For
 * subprocess modules, an `fn` entry is rejected at manifest load.
 */
export type ManifestHookEntry =
  | string
  | {
      script: string;
      onFail?: "hard" | "warn" | "retry";
      timeoutMs?: number;
      priority?: number;
    }
  | {
      fn: string;
      onFail?: "hard" | "warn" | "retry";
      timeoutMs?: number;
      priority?: number;
    };

export interface ModuleProvides {
  /**
   * Contribution-point names this module exposes. Other modules and the
   * project config may register against `<thisId>/<name>`.
   *
   * Per-item: `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, max 64 chars,
   * `uniqueItems`. Empty array allowed (declares zero contribution points
   * — semantically distinct from omitting the field).
   *
   * The override slot name is hardcoded `custom`; declaring it gates the
   * `<id>/custom` override path.
   */
  hooks?: string[];
}

export interface ModuleConsumes {
  /**
   * Registrations against other modules' contribution points. Keys must
   * match `^[a-z0-9-]+\/[a-z0-9-]+$`. Unknown targets raise
   * `E_HOOK_TARGET_UNKNOWN`; declared-but-not-provided names raise
   * `E_HOOK_NAME_UNDECLARED`.
   */
  hooks?: Record<string, ManifestHookEntry>;
}

export interface ModuleSignature {
  algo: "ed25519";
  publicKey: string;
  signature: string;
}

export interface ModuleSandbox {
  kind: "none" | "node-permission" | "os-sandbox";
  [key: string]: unknown;
}

export interface ModuleTarget {
  kind: "emulator" | "simulator" | "physical";
}

/**
 * The shape of rn-dev-module.json.
 *
 * `signature`, `sandbox`, and `target` are accepted by the schema but the v1
 * host ignores them — they reserve surface for V2.
 */
export interface ModuleManifest {
  id: string;
  version: string;
  hostRange: string;
  scope: ModuleScope;
  experimental?: boolean;
  contributes?: ModuleContributions;
  permissions?: string[];
  activationEvents?: string[];
  /**
   * Hook contribution-point declarations (Phase H0+). Modules declaring
   * any field under `provides` MUST also declare a `hostRange` whose
   * minimum satisfies the host minor that introduced hook support, or
   * the validator emits `E_HOST_RANGE_REQUIRED`.
   */
  provides?: ModuleProvides;
  /**
   * Registrations against other modules' contribution points (Phase H0+).
   * Same `hostRange` constraint as `provides`.
   */
  consumes?: ModuleConsumes;
  /** Reserved for Phase 10. Schema validates but host ignores in v1. */
  uses?: UsesEntry[];
  /** Reserved for V2. */
  signature?: ModuleSignature;
  /** Reserved for V2. */
  sandbox?: ModuleSandbox;
  /** Reserved for V2. */
  target?: ModuleTarget;
}
