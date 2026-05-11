// Internal hook-system types. Public hook contracts live in
// `@rn-dev/config` (`HookContracts`, `HookEntry`, `HookPhase`); this
// file holds the shapes that flow between the SRP-split classes
// (Registry / Dispatcher / Runner / AuditWriter / Manager) and don't
// need to be exposed to module authors.

import type { HookEntry, HookPhase, OnFailMode } from "@rn-dev/config";
import type { ResolvedHookScript } from "./path-resolver.js";

/** Where a hook registration came from. */
export type RegistrationSource =
  | { kind: "project"; configPath: string }
  | { kind: "module"; moduleId: string; manifestPath: string };

/**
 * Resolved registration runtime shape. `script` registrations carry the
 * captured `ResolvedHookScript` (TOCTOU fingerprint included); `fn`
 * registrations carry the closure plus a stable display name for logs
 * and audit entries.
 */
export type RegistrationResolved =
  | { kind: "script"; script: ResolvedHookScript }
  | {
      kind: "fn";
      symbol: string;
      fn: (payload: unknown) => Promise<unknown> | unknown;
    };

/**
 * One slot of registration after the registry has accepted it. Shape is
 * identical for project-level and module-level entries; the `source`
 * discriminator keeps audit/event readers oriented.
 */
export interface Registration {
  /** "<moduleId>/<hookName>". */
  target: HookPhase;
  source: RegistrationSource;
  resolved: RegistrationResolved;
  priority: number;
  /** 0-based monotonic sequence within a registry. Determines tie order. */
  registrationOrder: number;
  onFail: OnFailMode;
  timeoutMs?: number;
  /** True when the slot's `<hookName>` part is `custom` — the override slot. */
  isOverride: boolean;
  /**
   * True when no provider with the matching `<moduleId>` has declared a
   * `provides.hooks` slot covering this `<hookName>`. The dispatcher
   * skips orphans at fire time and emits `hooks/orphaned` on registry
   * walk; H5 surfaces them in the `hooks-list` MCP tool.
   */
  orphaned: boolean;
}

/** Input shape `HookRegistry.addRegistration` accepts. */
export interface RegistrationInput {
  target: HookPhase;
  source: RegistrationSource;
  entry: HookEntry;
  resolved: RegistrationResolved;
}

/** A single contribution point declared by a provider. */
export interface ContributionPoint {
  moduleId: string;
  hookName: string;
}

/** Snapshot returned by `HookManager.dumpRegistry()` for vitest assertions. */
export interface RegistryDump {
  /** All known providers, keyed by moduleId, valued by their declared hook names. */
  providers: Record<string, string[]>;
  /** Pre-baked sorted list per `<moduleId>/<hookName>` slot. */
  registrations: Record<string, Registration[]>;
  /** Subset where `orphaned: true`. */
  orphaned: Registration[];
}
