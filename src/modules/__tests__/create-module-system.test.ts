import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../../core/module-host/capabilities.js";
import { ModuleRegistry } from "../registry.js";
import {
  createModuleSystem,
  type LogCapability,
} from "../create-module-system.js";
import {
  MARKETPLACE_CAPABILITY_ID,
  type MarketplaceCapability,
} from "../built-in/marketplace.js";
import type { RnDevModule } from "../../core/types.js";

// Minimal RnDevModule stand-in — avoids importing the real `devSpaceModule`
// which pulls OpenTUI into the vitest process.
const stubInkModule: RnDevModule = {
  id: "stub-ink",
  name: "Stub",
  icon: "",
  order: 99,
};

const silentLogger: LogCapability = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("createModuleSystem", () => {
  it("stamps appInfo/log capabilities and registers the four built-in manifests", () => {
    const system = createModuleSystem({
      hostVersion: "1.0.0",
      worktreeKey: null,
      logger: silentLogger,
    });

    // appInfo / log / modules should all be resolvable with no required
    // permission check (the factory opts into reserved ids).
    const appInfo = system.capabilities.resolve<{ hostVersion: string }>(
      "appInfo",
      [],
    );
    expect(appInfo?.hostVersion).toBe("1.0.0");
    expect(system.capabilities.resolve("log", [])).toBeDefined();
    expect(
      system.capabilities.resolve<MarketplaceCapability>(
        MARKETPLACE_CAPABILITY_ID,
        [],
      ),
    ).toBeDefined();

    const ids = system.moduleRegistry
      .getAllManifests()
      .map((m) => m.manifest.id)
      .sort();
    expect(ids).toEqual([
      "dev-space",
      "lint-test",
      "marketplace",
      "metro-logs",
      "settings",
    ]);
  });

  it("accepts an injected ModuleRegistry and layers built-ins onto it without clobbering legacy Ink modules", () => {
    const registry = new ModuleRegistry();
    registry.register(stubInkModule);

    const system = createModuleSystem({
      hostVersion: "1.0.0",
      worktreeKey: null,
      logger: silentLogger,
      moduleRegistry: registry,
    });

    expect(system.moduleRegistry).toBe(registry);
    // Ink-map side preserved.
    expect(registry.get("stub-ink")).toBe(stubInkModule);
    // Manifest-map side populated by the factory.
    expect(registry.getManifest("dev-space", "global")).toBeDefined();
    expect(registry.getManifest("marketplace", "global")).toBeDefined();
  });

  it("accepts an injected CapabilityRegistry with pre-stamped entries", () => {
    const caps = new CapabilityRegistry();
    caps.register("metro", { mock: true });

    const system = createModuleSystem({
      hostVersion: "1.0.0",
      worktreeKey: null,
      logger: silentLogger,
      capabilities: caps,
    });

    expect(system.capabilities).toBe(caps);
    expect(caps.resolve("metro", [])).toEqual({ mock: true });
    expect(caps.resolve("appInfo", [])).toBeDefined();
    expect(caps.resolve(MARKETPLACE_CAPABILITY_ID, [])).toBeDefined();
  });

  it("exposes worktreeKey via the appInfo capability", () => {
    const system = createModuleSystem({
      hostVersion: "1.0.0",
      worktreeKey: "wt-abc",
      logger: silentLogger,
    });
    const appInfo = system.capabilities.resolve<{ worktreeKey: string | null }>(
      "appInfo",
      [],
    );
    expect(appInfo?.worktreeKey).toBe("wt-abc");
  });
});
