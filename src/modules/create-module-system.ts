// Shared module-system bootstrap — the one call-site where the capability
// registry is created, `appInfo` / `log` are registered (with the reserved-id
// opt-in), the `ModuleHostManager` is instantiated, the four built-in manifests
// are stamped, and the Marketplace built-in is wired into the capability
// registry.
//
// Before this factory, both `src/app/start-flow.ts` and
// `electron/module-system-bootstrap.ts` duplicated the same seven steps; every
// new built-in required a synchronized two-file edit. Phase 6 adds a third
// concern (install flow) so the duplication is extracted once here.
//
// Callers supply the pieces that genuinely differ between paths:
//   - TUI / daemon: `metro` + `artifacts` capabilities, legacy Ink registrations
//     (done BEFORE calling this factory — `moduleRegistry` is created here),
//     user-global manifest loading (done AFTER, since scopeUnit differs).
//   - Electron: no metro/artifacts capabilities; different logger sink; its own
//     moduleEvents EventEmitter (not an IPC-bridged one).

import type { CapabilityRegistry as CapabilityRegistryType } from "../core/module-host/capabilities.js";
import { CapabilityRegistry } from "../core/module-host/capabilities.js";
import { ModuleHostManager } from "../core/module-host/manager.js";
import { ModuleRegistry } from "./registry.js";
import {
  devSpaceManifest,
  lintTestManifest,
  settingsManifest,
} from "./built-in/manifests.js";
import { registerMarketplaceBuiltIn } from "./built-in/marketplace.js";

export interface AppInfoCapability {
  hostVersion: string;
  platform: NodeJS.Platform;
  worktreeKey: string | null;
}

export interface LogCapability {
  debug: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
}

export interface CreateModuleSystemOptions {
  hostVersion: string;
  worktreeKey: string | null;
  /**
   * Platform string exposed via the `appInfo` capability. Defaults to
   * `process.platform`; tests override.
   */
  platform?: NodeJS.Platform;
  /** Host-scoped logger exposed as the `log` capability. */
  logger: LogCapability;
  /**
   * Inject an existing `CapabilityRegistry` instead of constructing a new one.
   * Callers that need to add capabilities BEFORE built-ins register (e.g. the
   * TUI path wiring `metro` / `artifacts`) can construct the registry, stamp
   * their own entries, then pass it here — `appInfo` / `log` / `modules` still
   * register on top.
   */
  capabilities?: CapabilityRegistryType;
  /**
   * Inject an existing `ModuleRegistry` instead of constructing a new one.
   * The TUI path uses this to thread the same registry through legacy Ink
   * registrations (populated in `startFlow`) and manifest-shape built-ins
   * (stamped here). The two live on independent maps inside ModuleRegistry,
   * so there is no collision.
   */
  moduleRegistry?: ModuleRegistry;
}

export interface ModuleSystem {
  capabilities: CapabilityRegistryType;
  moduleHost: ModuleHostManager;
  moduleRegistry: ModuleRegistry;
}

export function createModuleSystem(opts: CreateModuleSystemOptions): ModuleSystem {
  const capabilities = opts.capabilities ?? new CapabilityRegistry();

  capabilities.register<AppInfoCapability>(
    "appInfo",
    {
      hostVersion: opts.hostVersion,
      platform: opts.platform ?? process.platform,
      worktreeKey: opts.worktreeKey,
    },
    { allowReserved: true },
  );
  capabilities.register<LogCapability>("log", opts.logger, {
    allowReserved: true,
  });

  const moduleHost = new ModuleHostManager({
    hostVersion: opts.hostVersion,
    capabilities,
  });

  const moduleRegistry = opts.moduleRegistry ?? new ModuleRegistry();
  moduleRegistry.registerBuiltIn(devSpaceManifest);
  moduleRegistry.registerBuiltIn(lintTestManifest);
  moduleRegistry.registerBuiltIn(settingsManifest);
  registerMarketplaceBuiltIn({ moduleRegistry, capabilities });

  return { capabilities, moduleHost, moduleRegistry };
}
