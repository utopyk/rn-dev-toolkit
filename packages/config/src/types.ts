// Project-config types for `@rn-dev/config`. Hand-written to match
// `config.schema.json`; any change to one must update the other.
//
// Daemon-side validation uses the JSON schema; author-time autocomplete uses
// these TS types. The lockstep CI test pins the two together so they cannot
// drift silently.

import type { ModuleManifest } from "@rn-dev/module-sdk";

// ---------------------------------------------------------------------------
// HookContracts — the typed-payload registry
// ---------------------------------------------------------------------------
//
// `HookContracts` is a module-augmentable interface keyed on the
// `<moduleId>/<hookName>` slot. Each built-in module module-augments it via
// `declare module '@rn-dev/config'`; 3p modules can do the same. Closes the
// `payload: unknown` leak everywhere except inside the parser.
//
// H0 ships an empty registry. H2/H3 phases that wrap Builder/Clean/etc as
// built-in modules will each augment a slot here.

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HookContracts {}

// ---------------------------------------------------------------------------
// Phase template-literal type
// ---------------------------------------------------------------------------

/**
 * `<moduleId>/<hookName>` reference shape. Used everywhere a string would
 * stand in for "the qualified name of a hook contribution point" — the
 * literal type catches simple typos at compile time.
 */
export type HookPhase = `${string}/${string}`;

// ---------------------------------------------------------------------------
// HookSlotsOf — derive registrable slots from a manifest tuple
// ---------------------------------------------------------------------------

/**
 * Given a `ModuleManifest`, expand `provides.hooks: ['pre','post']` into
 * the literal-union `'<id>/pre' | '<id>/post'`. When `provides.hooks` is
 * absent or empty, expands to `never` (registering against a slot the
 * module doesn't expose is a compile error).
 */
export type HookSlotsOf<M extends ModuleManifest> = M extends {
  id: infer Id extends string;
  provides: { hooks: infer Hooks extends readonly string[] };
}
  ? Hooks[number] extends infer N extends string
    ? `${Id}/${N}`
    : never
  : never;

// ---------------------------------------------------------------------------
// OverrideSlotOf — derive the override slot for a manifest
// ---------------------------------------------------------------------------

/**
 * Override slot is hardcoded as `custom`. Resolves to `<id>/custom` only
 * when `provides.hooks` actually contains `'custom'`; otherwise `never`.
 */
export type OverrideSlotOf<M extends ModuleManifest> = M extends {
  id: infer Id extends string;
  provides: { hooks: infer Hooks extends readonly string[] };
}
  ? "custom" extends Hooks[number]
    ? `${Id}/custom`
    : never
  : never;

// ---------------------------------------------------------------------------
// HookEntry — registration shape (project config form)
// ---------------------------------------------------------------------------

export type OnFailMode = "hard" | "warn" | "retry";

export interface HookEntryCommon {
  onFail?: OnFailMode;
  /** Wall-clock timeout for the registration. Phase default applies if omitted. */
  timeoutMs?: number;
  /** Higher fires earlier within a phase. Defaults to 0. */
  priority?: number;
}

/** Sugar — a bare string is shorthand for `{ script }`. */
export type HookEntryString = string;

/** Subprocess hook — script path resolved against the config-file's containing dir. */
export interface HookEntryScript extends HookEntryCommon {
  script: string;
  fn?: never;
}

/**
 * In-process hook — only meaningful for project configs (closures are free).
 * Subprocess modules registering an `fn` entry are rejected at manifest load.
 */
export interface HookEntryFn<P = unknown, R = unknown> extends HookEntryCommon {
  fn: (payload: P) => Promise<R> | R;
  script?: never;
}

/** Discriminated by key presence — not a tag. */
export type HookEntry<P = unknown, R = unknown> =
  | HookEntryString
  | HookEntryScript
  | HookEntryFn<P, R>;

// ---------------------------------------------------------------------------
// HookRecord — JSON-line record protocol
// ---------------------------------------------------------------------------
//
// Records emitted by hook subprocesses on stdout. The runner narrows on
// `kind` and forwards records that don't match a known shape as `log`-level
// info lines (mirrors `parseSubscribePayload` idiom in the daemon).

export type HookRecord =
  | { kind: "ack"; replaced: boolean }
  | { kind: "log"; level: "debug" | "info" | "warn" | "error"; text: string }
  | { kind: "progress"; percent: number; text?: string }
  | { kind: "result"; data?: unknown }
  | null;

// ---------------------------------------------------------------------------
// RnDevConfig — the project config shape
// ---------------------------------------------------------------------------

/**
 * Default-shape registration map. The generic in `defineConfig` narrows
 * keys to the active `BuiltInModules` slot union; this fallback type is
 * used when callers explicitly type `RnDevConfig` without that context.
 */
export type HookRegistrations = Partial<Record<HookPhase, HookEntry>>;

/**
 * The shape exported by a project's `rn-dev.config.ts`.
 *
 * `allowModuleOverrides` and `allowModuleHardFails` are advisory in H0
 * — they're shape-validated here but the gate logic ships in H5.
 */
export interface RnDevConfig {
  hooks?: HookRegistrations;
  /**
   * Module IDs whose `consumes.hooks` registrations against `<id>/custom`
   * the project opts in to. Without this, 3p override registrations are
   * loaded but not registered (security gate, H5).
   */
  allowModuleOverrides?: string[];
  /**
   * Module IDs whose `onFail: 'hard'` against non-override slots the
   * project opts in to. Without this, 3p hard fails are downgraded to
   * `'warn'` with an audit entry (security gate, H5).
   */
  allowModuleHardFails?: string[];
}
