// Electron-mode module-system bootstrap.
//
// Delegates capability/registry/built-in wiring to the shared
// `createModuleSystem` factory (Phase 6 Arch P1-1). Keeps Electron-only
// behavior here: the moduleEvents EventEmitter (daemon path gets its bus from
// `registerModulesIpc`), the serviceBus publishes so pre-registered ipcMain
// handlers can resolve their deps, and the idempotency guard so re-entry via
// `app.activate` doesn't double-register.

import { EventEmitter } from "node:events";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CapabilityRegistry } from "../src/core/module-host/capabilities.js";
import type { ModuleHostManager } from "../src/core/module-host/manager.js";
import type { ModuleRegistry } from "../src/modules/registry.js";
import { createModuleSystem, type LogCapability } from "../src/modules/create-module-system.js";
import { serviceBus } from "../src/app/service-bus.js";

export interface BootstrapResult {
  capabilities: CapabilityRegistry;
  moduleHost: ModuleHostManager;
  moduleRegistry: ModuleRegistry;
  moduleEvents: EventEmitter;
  hostVersion: string;
}

let booted: BootstrapResult | null = null;

export function bootstrapElectronModuleSystem(args: {
  worktreeKey: string | null;
}): BootstrapResult {
  if (booted) return booted;

  const hostVersion = readHostVersion();
  const { capabilities, moduleHost, moduleRegistry } = createModuleSystem({
    hostVersion,
    worktreeKey: args.worktreeKey,
    logger: electronConsoleLogger(),
  });

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

  serviceBus.setHostVersion(hostVersion);
  serviceBus.setModuleHost(moduleHost);
  serviceBus.setModuleRegistry(moduleRegistry);
  serviceBus.setModuleEventsBus(moduleEvents);

  booted = { capabilities, moduleHost, moduleRegistry, moduleEvents, hostVersion };
  return booted;
}

function electronConsoleLogger(): LogCapability {
  const format = (
    msg: string,
    data?: Record<string, unknown>,
  ): string => (data ? `${msg} ${JSON.stringify(data)}` : msg);
  return {
    debug: (msg, data) => console.log(`[mod debug] ${format(msg, data)}`),
    info: (msg, data) => console.log(`[mod info] ${format(msg, data)}`),
    warn: (msg, data) => console.warn(`[mod warn] ${format(msg, data)}`),
    error: (msg, data) => console.error(`[mod error] ${format(msg, data)}`),
  };
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
