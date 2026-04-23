import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../../src/core/module-host/capabilities.js";
import { ModuleHostManager } from "../../src/core/module-host/manager.js";
import { ModuleRegistry } from "../../src/modules/registry.js";
import {
  activatePanel,
  createBoundsCache,
  deactivatePanel,
  listPanels,
  resolveCallTool,
  resolveHostCall,
  setPanelBounds,
} from "../ipc/modules-panels.js";
import type { PanelBridge, PanelRegistration } from "../panel-bridge.js";
import type { ModuleManifest } from "@rn-dev/module-sdk";
import type { RegisteredModule } from "../../src/modules/registry.js";

// ---------------------------------------------------------------------------
// Fixtures / fakes
// ---------------------------------------------------------------------------

function manifest(
  id: string,
  opts: {
    permissions?: string[];
    panels?: Array<{
      id: string;
      title: string;
      hostApi?: string[];
      webviewEntry?: string;
    }>;
  } = {},
): ModuleManifest {
  return {
    id,
    version: "0.1.0",
    hostRange: ">=0.1.0",
    scope: "per-worktree",
    permissions: opts.permissions,
    contributes: opts.panels
      ? {
          electron: {
            panels: opts.panels.map((p) => ({
              id: p.id,
              title: p.title,
              hostApi: p.hostApi ?? [],
              webviewEntry: p.webviewEntry ?? "panel.html",
            })),
          },
        }
      : undefined,
  };
}

function registryWith(...modules: RegisteredModule[]): ModuleRegistry {
  const reg = new ModuleRegistry();
  for (const m of modules) reg.registerManifest(m);
  return reg;
}

function registeredWith(m: ModuleManifest, scopeUnit = "wt-1"): RegisteredModule {
  return {
    manifest: m,
    modulePath: `/modules/${m.id}`,
    scopeUnit,
    state: "inert",
    isBuiltIn: false,
  };
}

function fakeBridge(): {
  bridge: PanelBridge;
  calls: Array<string>;
  shown: string | null;
} {
  let shown: string | null = null;
  const calls: string[] = [];
  const registered = new Set<string>();
  const bridge: PanelBridge = {
    register(moduleId, contribution): PanelRegistration {
      const k = `${moduleId}:${contribution.id}`;
      calls.push(`register:${k}`);
      registered.add(k);
      return {
        moduleId,
        panelId: contribution.id,
        title: contribution.title,
        view: {
          id: k,
          setBounds: () => {},
          focus: () => {},
          async close() {},
        },
      };
    },
    show(moduleId, panelId) {
      const k = `${moduleId}:${panelId}`;
      calls.push(`show:${k}`);
      shown = k;
    },
    hide(moduleId, panelId) {
      const k = `${moduleId}:${panelId}`;
      calls.push(`hide:${k}`);
      if (shown === k) shown = null;
    },
    async unregister(moduleId, panelId) {
      calls.push(`unregister:${moduleId}:${panelId}`);
      registered.delete(`${moduleId}:${panelId}`);
    },
    list: () => [],
    applyBounds() {
      calls.push("applyBounds");
    },
  };
  return {
    bridge,
    calls,
    get shown() {
      return shown;
    },
  } as { bridge: PanelBridge; calls: string[]; shown: string | null };
}

// ---------------------------------------------------------------------------
// listPanels
// ---------------------------------------------------------------------------

describe("listPanels", () => {
  it("returns panel contributions keyed by moduleId", () => {
    const registry = registryWith(
      registeredWith(
        manifest("dev-ctl", {
          panels: [
            { id: "main", title: "Device Control", hostApi: ["adb.shell"] },
          ],
        }),
      ),
      registeredWith(manifest("no-panels", {})),
    );
    const result = listPanels(registry);
    expect(result.modules).toEqual([
      {
        moduleId: "dev-ctl",
        title: "dev-ctl",
        panels: [
          {
            id: "main",
            title: "Device Control",
            icon: undefined,
            hostApi: ["adb.shell"],
          },
        ],
      },
    ]);
  });

  it("skips modules without panel contributions entirely", () => {
    const registry = registryWith(
      registeredWith(manifest("no-panels", {})),
    );
    expect(listPanels(registry).modules).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveHostCall
// ---------------------------------------------------------------------------

describe("resolveHostCall", () => {
  function managerWith(
    capabilities: (r: CapabilityRegistry) => void,
  ): ModuleHostManager {
    const reg = new CapabilityRegistry();
    capabilities(reg);
    return new ModuleHostManager({
      hostVersion: "0.1.0",
      capabilities: reg,
    });
  }

  it("resolves a granted capability + method against the capability registry", async () => {
    const manager = managerWith((reg) =>
      reg.register("math", { add: (a: number, b: number) => a + b }),
    );
    const registry = registryWith(registeredWith(manifest("dev-ctl")));

    const reply = await resolveHostCall(manager, registry, {
      moduleId: "dev-ctl",
      capabilityId: "math",
      method: "add",
      args: [4, 5],
    });
    expect(reply).toEqual({ kind: "ok", result: 9 });
  });

  it("returns MODULE_UNAVAILABLE when the moduleId is unknown", async () => {
    const manager = managerWith(() => {});
    const registry = registryWith();
    const reply = await resolveHostCall(manager, registry, {
      moduleId: "ghost",
      capabilityId: "x",
      method: "y",
      args: [],
    });
    expect(reply.kind).toBe("error");
    if (reply.kind === "error") expect(reply.code).toBe("MODULE_UNAVAILABLE");
  });

  it("returns HOST_CAPABILITY_NOT_FOUND_OR_DENIED when the module lacks the required permission", async () => {
    const manager = managerWith((reg) =>
      reg.register(
        "secret",
        { read: () => "classified" },
        { requiredPermission: "secret:read" },
      ),
    );
    const registry = registryWith(
      registeredWith(manifest("dev-ctl", { permissions: [] })),
    );
    const reply = await resolveHostCall(manager, registry, {
      moduleId: "dev-ctl",
      capabilityId: "secret",
      method: "read",
      args: [],
    });
    expect(reply.kind).toBe("error");
    if (reply.kind === "error") {
      expect(reply.code).toBe("HOST_CAPABILITY_NOT_FOUND_OR_DENIED");
    }
  });

  it("returns HOST_METHOD_NOT_FOUND for an unknown method on a granted capability", async () => {
    const manager = managerWith((reg) =>
      reg.register("math", { add: (a: number, b: number) => a + b }),
    );
    const registry = registryWith(registeredWith(manifest("dev-ctl")));
    const reply = await resolveHostCall(manager, registry, {
      moduleId: "dev-ctl",
      capabilityId: "math",
      method: "subtract",
      args: [],
    });
    expect(reply.kind).toBe("error");
    if (reply.kind === "error") expect(reply.code).toBe("HOST_METHOD_NOT_FOUND");
  });

  it("emits an audit event for every host-call outcome (ok + denied)", async () => {
    const manager = managerWith((reg) => {
      reg.register("math", { add: (a: number, b: number) => a + b });
      reg.register(
        "secret",
        { read: () => "classified" },
        { requiredPermission: "secret:read" },
      );
    });
    const registry = registryWith(
      registeredWith(manifest("dev-ctl", { permissions: [] })),
    );
    const audit: Array<{ outcome: string; capabilityId: string }> = [];

    await resolveHostCall(
      manager,
      registry,
      {
        moduleId: "dev-ctl",
        capabilityId: "math",
        method: "add",
        args: [2, 3],
      },
      (e) => audit.push({ outcome: e.outcome, capabilityId: e.capabilityId }),
    );
    await resolveHostCall(
      manager,
      registry,
      {
        moduleId: "dev-ctl",
        capabilityId: "secret",
        method: "read",
        args: [],
      },
      (e) => audit.push({ outcome: e.outcome, capabilityId: e.capabilityId }),
    );

    expect(audit).toEqual([
      { outcome: "ok", capabilityId: "math" },
      { outcome: "denied", capabilityId: "secret" },
    ]);
  });

  it("wraps thrown errors as HOST_CALL_FAILED with the error message", async () => {
    const manager = managerWith((reg) =>
      reg.register("broken", {
        explode: () => {
          throw new Error("kaboom");
        },
      }),
    );
    const registry = registryWith(registeredWith(manifest("dev-ctl")));
    const reply = await resolveHostCall(manager, registry, {
      moduleId: "dev-ctl",
      capabilityId: "broken",
      method: "explode",
      args: [],
    });
    expect(reply.kind).toBe("error");
    if (reply.kind === "error") {
      expect(reply.code).toBe("HOST_CALL_FAILED");
      expect(reply.message).toContain("kaboom");
    }
  });
});

// ---------------------------------------------------------------------------
// activatePanel / deactivatePanel / setPanelBounds
// ---------------------------------------------------------------------------

describe("activatePanel", () => {
  it("registers + shows the panel and caches bounds", () => {
    const fb = fakeBridge();
    const registry = registryWith(
      registeredWith(
        manifest("dev-ctl", {
          panels: [{ id: "main", title: "Device Control" }],
        }),
      ),
    );
    const bounds = createBoundsCache();
    const result = activatePanel(
      { bridge: fb.bridge, registry, bounds },
      {
        moduleId: "dev-ctl",
        panelId: "main",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
      },
    );
    expect(result).toEqual({ ok: true });
    expect(fb.calls).toEqual(["register:dev-ctl:main", "show:dev-ctl:main"]);
    expect(bounds.get("dev-ctl:main")).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it("returns an error when the module has no matching panel contribution", () => {
    const fb = fakeBridge();
    const registry = registryWith(
      registeredWith(
        manifest("dev-ctl", {
          panels: [{ id: "main", title: "Main" }],
        }),
      ),
    );
    const result = activatePanel(
      {
        bridge: fb.bridge,
        registry,
        bounds: createBoundsCache(),
      },
      {
        moduleId: "dev-ctl",
        panelId: "ghost",
        bounds: { x: 0, y: 0, width: 100, height: 100 },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('panel "ghost"');
    expect(fb.calls).toHaveLength(0);
  });
});

describe("deactivatePanel", () => {
  it("delegates to bridge.hide", () => {
    const fb = fakeBridge();
    const result = deactivatePanel(
      { bridge: fb.bridge },
      { moduleId: "a", panelId: "p" },
    );
    expect(result).toEqual({ ok: true });
    expect(fb.calls).toEqual(["hide:a:p"]);
  });
});

describe("setPanelBounds", () => {
  it("updates the cache and triggers bridge.applyBounds", () => {
    const fb = fakeBridge();
    const bounds = createBoundsCache();
    setPanelBounds(
      { bridge: fb.bridge, bounds },
      {
        moduleId: "a",
        panelId: "p",
        bounds: { x: 10, y: 20, width: 300, height: 400 },
      },
    );
    expect(bounds.get("a:p")).toEqual({ x: 10, y: 20, width: 300, height: 400 });
    expect(fb.calls).toEqual(["applyBounds"]);
  });
});

// ---------------------------------------------------------------------------
// resolveCallTool — destructive gate (Phase 7 P0)
// ---------------------------------------------------------------------------

describe("resolveCallTool", () => {
  function mgrOnly(): ModuleHostManager {
    return new ModuleHostManager({
      hostVersion: "0.1.0",
      capabilities: new CapabilityRegistry(),
    });
  }

  function manifestWithTools(
    tools: Array<{ name: string; destructiveHint?: boolean }>,
  ): ModuleManifest {
    return {
      id: "dev-ctl",
      version: "0.1.0",
      hostRange: ">=0.1.0",
      scope: "global",
      contributes: {
        mcp: {
          tools: tools.map((t) => ({
            name: t.name,
            description: "",
            inputSchema: { type: "object" },
            ...(t.destructiveHint ? { destructiveHint: true } : {}),
          })),
        },
      },
    };
  }

  it("rejects destructiveHint tools without { confirmed: true }", async () => {
    const registry = registryWith(
      registeredWith(
        manifestWithTools([
          { name: "dev-ctl__uninstall-app", destructiveHint: true },
        ]),
        "global",
      ),
    );
    const reply = await resolveCallTool(mgrOnly(), registry, "dev-ctl", {
      tool: "uninstall-app",
      args: {},
    });
    expect(reply.kind).toBe("error");
    if (reply.kind === "error") {
      expect(reply.code).toBe("E_DESTRUCTIVE_REQUIRES_CONFIRM");
    }
  });

  it("accepts destructiveHint tools with { confirmed: true } (falls through to call)", async () => {
    // We don't have a live subprocess, so the call itself will fail —
    // but with MODULE_UNAVAILABLE, not E_DESTRUCTIVE_REQUIRES_CONFIRM.
    // That's the proof that the destructive gate let us through.
    const registry = registryWith(
      registeredWith(
        manifestWithTools([
          { name: "dev-ctl__uninstall-app", destructiveHint: true },
        ]),
        "global",
      ),
    );
    const reply = await resolveCallTool(mgrOnly(), registry, "dev-ctl", {
      tool: "uninstall-app",
      args: {},
      confirmed: true,
    });
    expect(reply.kind).toBe("error");
    if (reply.kind === "error") {
      expect(reply.code).not.toBe("E_DESTRUCTIVE_REQUIRES_CONFIRM");
    }
  });

  it("non-destructive tools don't require confirmation", async () => {
    const registry = registryWith(
      registeredWith(manifestWithTools([{ name: "dev-ctl__list" }]), "global"),
    );
    const reply = await resolveCallTool(mgrOnly(), registry, "dev-ctl", {
      tool: "list",
      args: {},
    });
    expect(reply.kind).toBe("error");
    if (reply.kind === "error") {
      expect(reply.code).not.toBe("E_DESTRUCTIVE_REQUIRES_CONFIRM");
    }
  });

  it("rejects empty payload with E_MODULE_CALL_FAILED", async () => {
    const registry = registryWith();
    const reply = await resolveCallTool(mgrOnly(), registry, "dev-ctl", null);
    expect(reply.kind).toBe("error");
    if (reply.kind === "error") {
      expect(reply.code).toBe("E_MODULE_CALL_FAILED");
    }
  });
});
