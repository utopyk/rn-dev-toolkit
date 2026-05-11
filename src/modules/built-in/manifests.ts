// Phase 5b — pure-data built-in manifests. Kept in a separate file so tests
// and server-side code can import them without pulling in `@opentui/react`
// via the TUI components that sit next to each `RnDevModule` export. The
// RnDevModule files re-export these manifests so the existing import
// surface (`src/modules/index.ts`) stays additive.

import type { ModuleManifest } from "@rn-dev/module-sdk";

/**
 * Phase 5b — manifest shape for the built-in DevSpace module. In-process
 * and privileged; the host registers it via `ModuleRegistry.registerBuiltIn`
 * which stamps `kind: "built-in-privileged"` on the resulting
 * `RegisteredModule`. No MCP tools yet — DevSpace actions are driven from
 * the top-level `rn-dev/*` tool surface, not proxied through the module.
 */
export const devSpaceManifest: ModuleManifest = {
  id: "dev-space",
  version: "0.1.0",
  hostRange: ">=0.1.0",
  scope: "global",
  contributes: {
    tui: {
      views: [{ id: "dev-space", title: "Dev Space", icon: "🚀" }],
    },
  },
  activationEvents: ["onStartup"],
};

export const lintTestManifest: ModuleManifest = {
  id: "lint-test",
  version: "0.1.0",
  hostRange: ">=0.1.0",
  scope: "global",
  contributes: {
    tui: {
      views: [{ id: "lint-test", title: "Lint & Test", icon: "\ud83e\uddea" }],
    },
  },
  activationEvents: ["onStartup"],
};

/**
 * Phase H1 — `session` is a synthetic built-in that owns the daemon's
 * session lifecycle hooks. Modules `consumes.hooks` against
 * `session/init` to run code once the daemon has booted, and against
 * `session/profile-changed` to react to a profile-update RPC.
 *
 * The manifest contributes no TUI/MCP surface — it exists purely as
 * the host-end of the hook contribution-points namespace. The
 * `kind: "built-in-privileged"` stamp comes from `registerBuiltIn`,
 * which is gated on `BUILT_IN_MODULE_ALLOWLIST` (see
 * `src/modules/built-in-allowlist.ts`). `session/shutdown` is
 * deliberately deferred until a consumer asks for it; we don't want
 * to ship a contribution point that has no use case yet.
 */
export const sessionManifest: ModuleManifest = {
  id: "session",
  version: "0.1.0",
  hostRange: ">=0.1.0",
  scope: "global",
  provides: { hooks: ["init", "profile-changed"] },
  activationEvents: ["onStartup"],
};

/**
 * Phase H2e — wraps the in-process Builder (src/core/builder.ts) behind
 * the `BuildHostCapability` factory. `build/pre` fires BEFORE the
 * Builder's `build(opts)` call; `build/post` fires AFTER `done`. The
 * `custom` slot is the override entry point — H2 declares it but
 * `loadProjectHooks` rejects override consumers without
 * `allowModuleOverrides: ['build']` opt-in (full override semantics
 * land in Phase H4).
 *
 * No TUI / MCP surface contributions: Builder is driven from the host's
 * own `builder/build` RPC and the renderer's status bar / shortcuts
 * (Phase 13.6 PR-C wired this), not through module-system contributions.
 * The build module exists purely to own the hook contribution-points
 * namespace + the in-process capability instance.
 */
export const buildManifest: ModuleManifest = {
  id: "build",
  version: "0.1.0",
  hostRange: ">=0.1.0",
  scope: "global",
  provides: { hooks: ["pre", "post", "custom"] },
  activationEvents: ["onStartup"],
};

/**
 * Settings carries the only Phase 5b built-in that exposes user-tweakable
 * preferences via `contributes.config.schema`. Phase 5b ships the schema
 * declaration; actually migrating the renderer Settings view to drive
 * `modules/config/*` is Phase 5c / the Settings-panel migration follow-up.
 */
export const settingsManifest: ModuleManifest = {
  id: "settings",
  version: "0.1.0",
  hostRange: ">=0.1.0",
  scope: "global",
  contributes: {
    tui: {
      views: [{ id: "settings", title: "Settings", icon: "\u2699" }],
    },
    config: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          theme: {
            type: "string",
            description:
              "Active UI theme id. Must match one of the themes reported by the theme provider.",
          },
          showExperimentalModules: {
            type: "boolean",
            description:
              "Surface modules that declare `experimental: true` in their manifest.",
          },
        },
      },
    },
  },
  activationEvents: ["onStartup"],
};
