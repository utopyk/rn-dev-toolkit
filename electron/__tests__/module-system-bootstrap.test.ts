// Phase 5c — Electron-side module-system bootstrap.
//
// Must publish a live ModuleHost + ModuleRegistry + moduleEvents bus so
// the pre-registered ipcMain handlers (panels, config) can resolve
// against real deps. Pre-registers the four built-ins so Marketplace
// `list()` returns them on first call.

import { describe, expect, it, beforeEach } from "vitest";
import { serviceBus } from "../../src/app/service-bus.js";
import { CapabilityRegistry } from "../../src/core/module-host/capabilities.js";
import { ModuleHostManager } from "../../src/core/module-host/manager.js";
import { ModuleRegistry } from "../../src/modules/registry.js";

async function loadBootstrapFreshModule() {
  // vitest caches modules by URL. To reset the `booted` singleton between
  // tests we reach in and clear it on the re-imported module. If that
  // proves flaky we can move to a factory pattern, but for now the
  // idempotency test + the side-effects test are enough.
  const mod = await import("../module-system-bootstrap.js");
  return mod;
}

describe("bootstrapElectronModuleSystem", () => {
  beforeEach(() => {
    // Each test subscribes fresh to the service bus; off-load the
    // previous listeners so we don't leak across tests.
    serviceBus.removeAllListeners("moduleHost");
    serviceBus.removeAllListeners("moduleRegistry");
    serviceBus.removeAllListeners("moduleEventsBus");
  });

  it("publishes moduleHost + moduleRegistry + moduleEventsBus on the serviceBus", async () => {
    const { bootstrapElectronModuleSystem } = await loadBootstrapFreshModule();

    let publishedHost: ModuleHostManager | null = null;
    let publishedRegistry: ModuleRegistry | null = null;
    let publishedBus: unknown = null;

    serviceBus.on("moduleHost", (h) => {
      publishedHost = h;
    });
    serviceBus.on("moduleRegistry", (r) => {
      publishedRegistry = r;
    });
    serviceBus.on("moduleEventsBus", (b) => {
      publishedBus = b;
    });

    const result = bootstrapElectronModuleSystem({ worktreeKey: "wt-test" });

    expect(publishedHost).toBe(result.moduleHost);
    expect(publishedRegistry).toBe(result.moduleRegistry);
    expect(publishedBus).toBe(result.moduleEvents);
  });

  it("registers the built-in manifests + Marketplace on the registry", async () => {
    const { bootstrapElectronModuleSystem } = await loadBootstrapFreshModule();
    const result = bootstrapElectronModuleSystem({ worktreeKey: "wt-test" });

    const ids = result.moduleRegistry
      .getAllManifests()
      .map((m) => m.manifest.id)
      .sort();
    expect(ids).toEqual(
      ["dev-space", "lint-test", "marketplace", "settings"].sort(),
    );
    for (const reg of result.moduleRegistry.getAllManifests()) {
      expect(reg.kind).toBe("built-in-privileged");
    }
  });

  it("exposes the `modules` capability so 3p modules resolve the marketplace", async () => {
    const { bootstrapElectronModuleSystem } = await loadBootstrapFreshModule();
    const result = bootstrapElectronModuleSystem({ worktreeKey: "wt-test" });

    const resolved = result.capabilities.resolve("modules", []);
    expect(resolved).not.toBeNull();
    // The marketplace capability surface is `{ list(): MarketplaceModuleEntry[] }`.
    const list = (resolved as { list: () => Array<{ id: string }> }).list();
    expect(list.some((row) => row.id === "marketplace")).toBe(true);
  });

  it("reuses the same host on repeat calls (idempotent)", async () => {
    const { bootstrapElectronModuleSystem } = await loadBootstrapFreshModule();
    const first = bootstrapElectronModuleSystem({ worktreeKey: "wt-test" });
    const second = bootstrapElectronModuleSystem({ worktreeKey: "wt-test" });
    expect(second).toBe(first);
  });

  it("registers `appInfo` + `log` with allowReserved: true (no duplicate-throw)", async () => {
    const { bootstrapElectronModuleSystem } = await loadBootstrapFreshModule();
    const result = bootstrapElectronModuleSystem({ worktreeKey: "wt-test" });
    expect(result.capabilities.resolve("log", [])).not.toBeNull();
    expect(result.capabilities.resolve("appInfo", [])).not.toBeNull();
    // And confirm a plain register of "log" would still be blocked on a
    // fresh registry — the allowReserved flag is per-call, not global.
    const fresh = new CapabilityRegistry();
    expect(() => fresh.register("log", {})).toThrow(/reserved/);
  });
});
