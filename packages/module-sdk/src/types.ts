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
  /** Reserved for Phase 10. Schema validates but host ignores in v1. */
  uses?: UsesEntry[];
  /** Reserved for V2. */
  signature?: ModuleSignature;
  /** Reserved for V2. */
  sandbox?: ModuleSandbox;
  /** Reserved for V2. */
  target?: ModuleTarget;
}
