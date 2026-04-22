// Electron-mode module-system bootstrap.
//
// Phase 5c NEW work — before this existed, `modules:list-panels` returned
// `{modules: []}` and `modules:config-*` returned `E_CONFIG_SERVICES_PENDING`
// in Electron mode. `startRealServices` didn't initialize the module
// system; the TUI path (`src/app/start-flow.ts`) did it for the daemon
// but the Electron host had its own bootstrap that never got the equivalent.

import { EventEmitter } from "node:events";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CapabilityRegistry } from "../src/core/module-host/capabilities.js";
import { ModuleHostManager } from "../src/core/module-host/manager.js";
import { ModuleRegistry } from "../src/modules/registry.js";
import {
  devSpaceManifest,
  metroLogsManifest,
  lintTestManifest,
  settingsManifest,
} from "../src/modules/built-in/manifests.js";
import { registerMarketplaceBuiltIn } from "../src/modules/built-in/marketplace.js";
import { serviceBus } from "../src/app/service-bus.js";

export interface BootstrapResult {
  capabilities: CapabilityRegistry;
  moduleHost: ModuleHostManager;
  moduleRegistry: ModuleRegistry;
  moduleEvents: EventEmitter;
}

/**
 * Call once from `startRealServices` right after `state.artifactStore` +
 * `state.projectRoot` are populated. Idempotent by virtue of the
 * serviceBus publish — re-running would double-register capabilities so
 * we guard with a module-scoped flag.
 */
let booted: BootstrapResult | null = null;

export function bootstrapElectronModuleSystem(args: {
  worktreeKey: string | null;
}): BootstrapResult {
  if (booted) return booted;

  const hostVersion = readHostVersion();
  const capabilities = new CapabilityRegistry();
  capabilities.register(
    "appInfo",
    {
      hostVersion,
      platform: process.platform,
      worktreeKey: args.worktreeKey,
    },
    { allowReserved: true },
  );
  capabilities.register(
    "log",
    {
      debug: (msg: string) => console.log(`[mod debug] ${msg}`),
      info: (msg: string) => console.log(`[mod info] ${msg}`),
      warn: (msg: string) => console.warn(`[mod warn] ${msg}`),
      error: (msg: string) => console.error(`[mod error] ${msg}`),
    },
    { allowReserved: true },
  );

  const moduleHost = new ModuleHostManager({ hostVersion, capabilities });

  const moduleRegistry = new ModuleRegistry();
  moduleRegistry.registerBuiltIn(devSpaceManifest);
  moduleRegistry.registerBuiltIn(metroLogsManifest);
  moduleRegistry.registerBuiltIn(lintTestManifest);
  moduleRegistry.registerBuiltIn(settingsManifest);
  registerMarketplaceBuiltIn({ moduleRegistry, capabilities });

  // Load user-global 3p manifests — best-effort; a broken 3p module
  // shouldn't break the Electron boot. Rejections surface through the
  // serviceBus log channel so they reach the renderer's service:log
  // pane (parity with the TUI path which emits via `serviceBus.log`).
  const loaded = moduleRegistry.loadUserGlobalModules({
    hostVersion,
    scopeUnit: args.worktreeKey ?? "global",
  });
  for (const r of loaded.rejected) {
    serviceBus.log(
      `⚠ Module manifest rejected (${r.code}): ${r.manifestPath} — ${r.message}`,
    );
  }
  if (loaded.modules.length > 0) {
    serviceBus.log(
      `ℹ Loaded ${loaded.modules.length} module manifest${loaded.modules.length === 1 ? "" : "s"} (${loaded.modules.map((m) => m.manifest.id).join(", ")})`,
    );
  }

  const moduleEvents = new EventEmitter();

  serviceBus.setModuleHost(moduleHost);
  serviceBus.setModuleRegistry(moduleRegistry);
  serviceBus.setModuleEventsBus(moduleEvents);

  booted = { capabilities, moduleHost, moduleRegistry, moduleEvents };
  return booted;
}

// Resolve the host's package.json relative to this file, NOT process.cwd().
// When Electron is launched with the CWD pointed at a user's React Native
// project, `process.cwd()/package.json` is the project's manifest, and a
// hostile project could spoof the host version to bypass `hostRange`
// gating. The tsx launcher loads this file from the source tree in dev,
// and from the packaged asar in production — both have a resolvable
// parent containing the host `package.json`.
function readHostVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.join(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
    version?: string;
  };
  if (!pkg.version) {
    throw new Error(`host package.json at ${pkgPath} has no version field`);
  }
  return pkg.version;
}
