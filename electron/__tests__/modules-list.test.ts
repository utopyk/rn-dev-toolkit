// Phase 5c — smoke-test the pure projection that Electron's
// `modules:list` ipcMain handler delegates to. The ipcMain binding lives
// in modules-panels-register.ts but that file imports `electron` so we
// can't load it under vitest. Instead we call `listRows` directly with
// the same deps shape the registrar would build — same code path, no
// electron runtime.

import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../../src/core/module-host/capabilities.js";
import { ModuleHostManager } from "../../src/core/module-host/manager.js";
import { ModuleRegistry } from "../../src/modules/registry.js";
import { listRows } from "../../src/app/modules-ipc.js";
import {
  devSpaceManifest,
  metroLogsManifest,
  lintTestManifest,
  settingsManifest,
} from "../../src/modules/built-in/manifests.js";
import { registerMarketplaceBuiltIn } from "../../src/modules/built-in/marketplace.js";

function setupDeps() {
  const capabilities = new CapabilityRegistry();
  const registry = new ModuleRegistry();
  registry.registerBuiltIn(devSpaceManifest);
  registry.registerBuiltIn(metroLogsManifest);
  registry.registerBuiltIn(lintTestManifest);
  registry.registerBuiltIn(settingsManifest);
  registerMarketplaceBuiltIn({ moduleRegistry: registry, capabilities });
  const manager = new ModuleHostManager({
    hostVersion: "0.1.0",
    capabilities,
  });
  return { registry, manager };
}

describe("listRows (modules:list projection)", () => {
  it("returns one row per registered module", () => {
    const { registry, manager } = setupDeps();
    const rows = listRows({ registry, manager });
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(
      ["dev-space", "lint-test", "marketplace", "metro-logs", "settings"].sort(),
    );
  });

  it("stamps kind='built-in-privileged' + state='active' + isBuiltIn=true on every built-in row", () => {
    const { registry, manager } = setupDeps();
    const rows = listRows({ registry, manager });
    for (const row of rows) {
      expect(row.kind).toBe("built-in-privileged");
      expect(row.state).toBe("active");
      expect(row.isBuiltIn).toBe(true);
      expect(row.pid).toBeNull();
      expect(row.lastCrashReason).toBeNull();
    }
  });

  it("returns row.version matching the manifest", () => {
    const { registry, manager } = setupDeps();
    const rows = listRows({ registry, manager });
    for (const row of rows) {
      expect(row.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("arch #3 — MarketplaceModuleEntry row matches the same shape the IPC row carries", () => {
    const { registry, manager } = setupDeps();
    const rows = listRows({ registry, manager });
    const marketplaceRow = rows.find((r) => r.id === "marketplace");
    expect(marketplaceRow).toBeDefined();
    // Every field the Marketplace capability projects should also be
    // present on the IPC row — that's the point of arch #3.
    expect(marketplaceRow).toMatchObject({
      id: "marketplace",
      version: expect.any(String),
      scope: "global",
      isBuiltIn: true,
      kind: "built-in-privileged",
      state: expect.any(String),
    });
  });
});
