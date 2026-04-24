import { describe, expect, it } from "vitest";
import {
  activatePanel,
  createBoundsCache,
  deactivatePanel,
  setPanelBounds,
  type ResolvedPanelContribution,
} from "../ipc/modules-panels.js";
import type { PanelBridge, PanelRegistration } from "../panel-bridge.js";

// Phase 13.4.1 — the deep list/host-call/call-tool coverage moved to
// src/app/__tests__/modules-ipc.test.ts where the daemon dispatcher
// runs. This file pins the surviving Electron-local helpers:
// activatePanel/deactivatePanel/setPanelBounds + the bounds cache.
// Those are panel-bridge lifecycle ops that drive WebContentsView
// operations against the main window — they have to stay Electron-side.

function fakeBridge(): {
  bridge: PanelBridge;
  calls: string[];
  shown: string | null;
} {
  let shown: string | null = null;
  const calls: string[] = [];
  const bridge: PanelBridge = {
    register(moduleId, contribution): PanelRegistration {
      const k = `${moduleId}:${contribution.id}`;
      calls.push(`register:${k}`);
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

function resolvedPanel(
  overrides: Partial<ResolvedPanelContribution> = {},
): ResolvedPanelContribution {
  return {
    id: "main",
    title: "Main Panel",
    webviewEntry: "./panel.html",
    hostApi: [],
    ...overrides,
  };
}

describe("activatePanel", () => {
  it("registers and shows the panel with the resolved contribution", () => {
    const { bridge, calls } = fakeBridge();
    const bounds = createBoundsCache();

    const result = activatePanel(
      { bridge, bounds },
      {
        moduleId: "dev-ctl",
        panelId: "main",
        bounds: { x: 10, y: 20, width: 800, height: 600 },
      },
      resolvedPanel(),
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["register:dev-ctl:main", "show:dev-ctl:main"]);
    expect(bounds.get("dev-ctl:main")).toEqual({
      x: 10,
      y: 20,
      width: 800,
      height: 600,
    });
  });

  it("rejects when the resolved panel id doesn't match the requested one", () => {
    const { bridge } = fakeBridge();
    const bounds = createBoundsCache();

    const result = activatePanel(
      { bridge, bounds },
      {
        moduleId: "dev-ctl",
        panelId: "main",
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      },
      resolvedPanel({ id: "settings" }),
    );

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/Resolved panel id "settings"/),
    });
  });

  it("caches bounds keyed by moduleId:panelId", () => {
    const { bridge } = fakeBridge();
    const bounds = createBoundsCache();

    activatePanel(
      { bridge, bounds },
      {
        moduleId: "a",
        panelId: "p1",
        bounds: { x: 1, y: 2, width: 3, height: 4 },
      },
      resolvedPanel({ id: "p1" }),
    );
    activatePanel(
      { bridge, bounds },
      {
        moduleId: "b",
        panelId: "p2",
        bounds: { x: 10, y: 20, width: 30, height: 40 },
      },
      resolvedPanel({ id: "p2" }),
    );

    expect(bounds.get("a:p1")).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(bounds.get("b:p2")).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });
});

describe("deactivatePanel", () => {
  it("delegates to bridge.hide", () => {
    const { bridge, calls } = fakeBridge();
    const result = deactivatePanel(
      { bridge },
      { moduleId: "dev-ctl", panelId: "main" },
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["hide:dev-ctl:main"]);
  });
});

describe("setPanelBounds", () => {
  it("updates the cache and tells the bridge to reapply bounds", () => {
    const { bridge, calls } = fakeBridge();
    const bounds = createBoundsCache();

    const result = setPanelBounds(
      { bridge, bounds },
      {
        moduleId: "dev-ctl",
        panelId: "main",
        bounds: { x: 10, y: 20, width: 800, height: 600 },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(bounds.get("dev-ctl:main")).toEqual({
      x: 10,
      y: 20,
      width: 800,
      height: 600,
    });
    expect(calls).toEqual(["applyBounds"]);
  });
});

describe("createBoundsCache", () => {
  it("supports get/set/delete with the Map semantics panel-bridge depends on", () => {
    const bounds = createBoundsCache();
    expect(bounds.get("a:b")).toBeUndefined();
    bounds.set("a:b", { x: 1, y: 2, width: 3, height: 4 });
    expect(bounds.get("a:b")).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    bounds.delete("a:b");
    expect(bounds.get("a:b")).toBeUndefined();
  });
});
