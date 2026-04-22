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

export const metroLogsManifest: ModuleManifest = {
  id: "metro-logs",
  version: "0.1.0",
  hostRange: ">=0.1.0",
  scope: "global",
  contributes: {
    tui: {
      views: [{ id: "metro-logs", title: "Metro Logs", icon: "\ud83d\udce1" }],
    },
    config: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          follow: {
            type: "boolean",
            description: "Auto-scroll the log viewer as new lines arrive.",
          },
          filter: {
            type: "string",
            description: "Substring filter applied to each log line.",
          },
        },
      },
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
