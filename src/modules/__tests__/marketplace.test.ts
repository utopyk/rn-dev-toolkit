import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../../core/module-host/capabilities.js";
import {
  MARKETPLACE_CAPABILITY_ID,
  createMarketplaceCapability,
  marketplaceManifest,
  registerMarketplaceBuiltIn,
} from "../built-in/marketplace.js";
import {
  devSpaceManifest,
  metroLogsManifest,
} from "../built-in/manifests.js";
import { ModuleRegistry } from "../registry.js";
import type { MarketplaceCapability } from "../built-in/marketplace.js";

describe("marketplace — createMarketplaceCapability", () => {
  it("list() mirrors the module registry — built-ins surface with kind built-in-privileged", () => {
    const registry = new ModuleRegistry();
    registry.registerBuiltIn(devSpaceManifest);
    registry.registerBuiltIn(metroLogsManifest);

    const cap = createMarketplaceCapability(registry);
    const list = cap.list();

    expect(list.map((e) => e.id).sort()).toEqual(["dev-space", "metro-logs"]);
    expect(list.every((e) => e.kind === "built-in-privileged")).toBe(true);
    expect(list.every((e) => e.isBuiltIn)).toBe(true);
    expect(list.every((e) => e.state === "active")).toBe(true);
  });

  it("list() reflects 3p modules as kind subprocess", () => {
    const registry = new ModuleRegistry();
    registry.registerManifest({
      manifest: {
        id: "tp",
        version: "0.1.0",
        hostRange: ">=0.1.0",
        scope: "per-worktree",
      },
      modulePath: "/fake/tp",
      scopeUnit: "wt-1",
      state: "inert",
      isBuiltIn: false,
    });

    const cap = createMarketplaceCapability(registry);
    const entry = cap.list().find((e) => e.id === "tp");
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("subprocess");
    expect(entry!.isBuiltIn).toBe(false);
    expect(entry!.state).toBe("inert");
  });

  it("exposes only list() in Phase 5b — install/uninstall land in Phase 6", () => {
    const cap: MarketplaceCapability = createMarketplaceCapability(
      new ModuleRegistry(),
    );
    // Guards against accidentally re-introducing stubs before the real
    // Phase 6 implementation exists. A grep-for-NOT_IMPLEMENTED helper
    // is the compound-engineering-friendly replacement.
    expect(Object.keys(cap)).toEqual(["list"]);
  });
});

describe("marketplace — registerMarketplaceBuiltIn", () => {
  it("registers the manifest AND installs the 'modules' capability", () => {
    const moduleRegistry = new ModuleRegistry();
    const capabilities = new CapabilityRegistry();

    const { manifest, capability } = registerMarketplaceBuiltIn({
      moduleRegistry,
      capabilities,
    });

    expect(manifest.manifest.id).toBe("marketplace");
    expect(manifest.kind).toBe("built-in-privileged");
    expect(
      moduleRegistry.getManifest("marketplace", "global")?.manifest.id,
    ).toBe("marketplace");

    // The capability is resolvable with no permissions — no requiredPermission
    // is set on the registration (the Marketplace capability is public).
    const resolved = capabilities.resolve<MarketplaceCapability>(
      MARKETPLACE_CAPABILITY_ID,
      [],
    );
    expect(resolved).toBeTruthy();
    expect(resolved).toBe(capability);
  });

  it("is idempotent within a single registry — a second call throws duplicate", () => {
    const moduleRegistry = new ModuleRegistry();
    const capabilities = new CapabilityRegistry();
    registerMarketplaceBuiltIn({ moduleRegistry, capabilities });
    expect(() =>
      registerMarketplaceBuiltIn({ moduleRegistry, capabilities }),
    ).toThrow(/already registered/);
  });

  it("manifest schema is valid", () => {
    // Smoke test — if the schema drifts and someone forgets to update the
    // manifest here, `registerBuiltIn` throws.
    const moduleRegistry = new ModuleRegistry();
    expect(() => moduleRegistry.registerBuiltIn(marketplaceManifest)).not.toThrow();
  });
});
