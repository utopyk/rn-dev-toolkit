import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPanelBridge,
  type BrowserHost,
  type PanelView,
  type PanelViewFactory,
  type PanelAuditEvent,
} from "../panel-bridge.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakePanelView extends PanelView {
  readonly moduleId: string;
  readonly panelId: string;
  readonly hostApiAllowlist: string[];
  readonly entryPath: string;
  setBoundsCalls: Array<{ x: number; y: number; width: number; height: number }>;
  focusCalls: number;
  closeCalls: number;
}

function makeView(
  moduleId: string,
  panelId: string,
  hostApiAllowlist: string[],
  entryPath: string,
): FakePanelView {
  const view: FakePanelView = {
    id: `${moduleId}:${panelId}`,
    moduleId,
    panelId,
    hostApiAllowlist,
    entryPath,
    setBoundsCalls: [],
    focusCalls: 0,
    closeCalls: 0,
    setBounds(b) {
      view.setBoundsCalls.push(b);
    },
    focus() {
      view.focusCalls += 1;
    },
    async close() {
      view.closeCalls += 1;
    },
  };
  return view;
}

function makeFactory(): PanelViewFactory & {
  created: FakePanelView[];
} {
  const created: FakePanelView[] = [];
  return {
    created,
    create(opts) {
      const view = makeView(
        opts.moduleId,
        opts.panelId,
        opts.hostApiAllowlist,
        opts.entryPath,
      );
      created.push(view);
      return view;
    },
  };
}

interface FakeHost extends BrowserHost {
  childViews: PanelView[];
  resizeListeners: Array<() => void>;
  closeListeners: Array<() => void>;
  triggerResize(): void;
  triggerClose(): void;
}

function makeHost(): FakeHost {
  const host: FakeHost = {
    childViews: [],
    resizeListeners: [],
    closeListeners: [],
    addChildView(v) {
      host.childViews.push(v);
    },
    removeChildView(v) {
      host.childViews = host.childViews.filter((x) => x !== v);
    },
    onResize(listener) {
      host.resizeListeners.push(listener);
      return () => {
        host.resizeListeners = host.resizeListeners.filter(
          (l) => l !== listener,
        );
      };
    },
    onClose(listener) {
      host.closeListeners.push(listener);
      return () => {
        host.closeListeners = host.closeListeners.filter((l) => l !== listener);
      };
    },
    triggerResize() {
      for (const l of host.resizeListeners) l();
    },
    triggerClose() {
      for (const l of host.closeListeners) l();
    },
  };
  return host;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPanelBridge", () => {
  let host: FakeHost;
  let factory: ReturnType<typeof makeFactory>;
  let auditLog: PanelAuditEvent[];
  let bounds: { x: number; y: number; width: number; height: number };

  beforeEach(() => {
    host = makeHost();
    factory = makeFactory();
    auditLog = [];
    bounds = { x: 0, y: 0, width: 800, height: 600 };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeBridge() {
    return createPanelBridge({
      host,
      factory,
      getBounds: () => bounds,
      moduleRoot: (id: string) => `/modules/${id}`,
      auditLog: (e) => auditLog.push(e),
    });
  }

  it("register() creates a WebContentsView once per (moduleId, panelId) pair", () => {
    const bridge = makeBridge();
    const reg1 = bridge.register("dev-ctl", {
      id: "main",
      title: "Device Control",
      hostApi: ["adb.shell"],
      webviewEntry: "panel.html",
    });
    const reg2 = bridge.register("dev-ctl", {
      id: "main",
      title: "Device Control",
      hostApi: ["adb.shell"],
      webviewEntry: "panel.html",
    });
    expect(reg1).toBe(reg2);
    expect(factory.created).toHaveLength(1);
    const created = factory.created[0];
    expect(created.moduleId).toBe("dev-ctl");
    expect(created.panelId).toBe("main");
    expect(created.hostApiAllowlist).toEqual(["adb.shell"]);
    expect(created.entryPath).toBe("/modules/dev-ctl/panel.html");
  });

  it("show() mounts the view, applies current bounds, focuses, and hides any previously active panel", () => {
    const bridge = makeBridge();
    bridge.register("a", {
      id: "p",
      title: "A",
      hostApi: [],
      webviewEntry: "a.html",
    });
    bridge.register("b", {
      id: "p",
      title: "B",
      hostApi: [],
      webviewEntry: "b.html",
    });

    bridge.show("a", "p");
    expect(host.childViews).toHaveLength(1);
    const viewA = factory.created.find((v) => v.moduleId === "a")!;
    expect(host.childViews[0]).toBe(viewA);
    expect(viewA.setBoundsCalls).toEqual([{ x: 0, y: 0, width: 800, height: 600 }]);
    expect(viewA.focusCalls).toBe(1);

    bridge.show("b", "p");
    expect(host.childViews).toHaveLength(1);
    const viewB = factory.created.find((v) => v.moduleId === "b")!;
    expect(host.childViews[0]).toBe(viewB);
  });

  it("a resize event re-applies bounds to only the active panel (cross-module isolation)", () => {
    const bridge = makeBridge();
    bridge.register("a", {
      id: "p",
      title: "A",
      hostApi: [],
      webviewEntry: "a.html",
    });
    bridge.register("b", {
      id: "p",
      title: "B",
      hostApi: [],
      webviewEntry: "b.html",
    });
    bridge.show("a", "p");

    bounds = { x: 10, y: 20, width: 400, height: 300 };
    host.triggerResize();

    const viewA = factory.created.find((v) => v.moduleId === "a")!;
    const viewB = factory.created.find((v) => v.moduleId === "b")!;
    expect(viewA.setBoundsCalls).toHaveLength(2);
    expect(viewA.setBoundsCalls[1]).toEqual({
      x: 10,
      y: 20,
      width: 400,
      height: 300,
    });
    expect(viewB.setBoundsCalls).toHaveLength(0);
  });

  it("hide() removes the active view from the host and clears active state", () => {
    const bridge = makeBridge();
    bridge.register("a", {
      id: "p",
      title: "A",
      hostApi: [],
      webviewEntry: "a.html",
    });
    bridge.show("a", "p");

    bridge.hide("a", "p");
    expect(host.childViews).toHaveLength(0);
  });

  it("unregister() hides + closes the webContents + drops the registration", async () => {
    const bridge = makeBridge();
    bridge.register("a", {
      id: "p",
      title: "A",
      hostApi: [],
      webviewEntry: "a.html",
    });
    bridge.show("a", "p");

    await bridge.unregister("a", "p");
    const viewA = factory.created.find((v) => v.moduleId === "a")!;
    expect(viewA.closeCalls).toBe(1);
    expect(host.childViews).toHaveLength(0);
    expect(bridge.list()).toHaveLength(0);
  });

  it("destroyAll() closes every view — called automatically on window close", async () => {
    const bridge = makeBridge();
    bridge.register("a", {
      id: "p",
      title: "A",
      hostApi: [],
      webviewEntry: "a.html",
    });
    bridge.register("b", {
      id: "p",
      title: "B",
      hostApi: [],
      webviewEntry: "b.html",
    });

    host.triggerClose();
    // destroyAll is async internally; give it a tick
    await new Promise((r) => setTimeout(r, 0));

    expect(factory.created[0].closeCalls).toBe(1);
    expect(factory.created[1].closeCalls).toBe(1);
    expect(bridge.list()).toHaveLength(0);
  });

  it("audit-logs register / show / hide / unregister events", async () => {
    const bridge = makeBridge();
    bridge.register("a", {
      id: "p",
      title: "A",
      hostApi: ["foo"],
      webviewEntry: "a.html",
    });
    bridge.show("a", "p");
    bridge.hide("a", "p");
    await bridge.unregister("a", "p");

    const kinds = auditLog.map((e) => e.kind);
    expect(kinds).toEqual(["register", "show", "hide", "unregister"]);
    expect(auditLog[0]).toMatchObject({
      kind: "register",
      moduleId: "a",
      panelId: "p",
      hostApi: ["foo"],
    });
  });

  it("show() for an unknown (moduleId, panelId) is a no-op and emits no audit event", () => {
    const bridge = makeBridge();
    bridge.show("ghost", "p");
    expect(host.childViews).toHaveLength(0);
    expect(auditLog).toHaveLength(0);
  });

  it("show() cannot mount a second view into the content tree from a DIFFERENT module \u2014 the current active is removed first (S6: no cross-module delivery)", () => {
    const bridge = makeBridge();
    bridge.register("attacker", {
      id: "p",
      title: "Attacker",
      hostApi: [],
      webviewEntry: "atk.html",
    });
    bridge.register("victim", {
      id: "p",
      title: "Victim",
      hostApi: [],
      webviewEntry: "vic.html",
    });

    bridge.show("victim", "p");
    bridge.show("attacker", "p");

    // Attacker active; victim not in tree. Only one panel is addressable at a time.
    expect(host.childViews).toHaveLength(1);
    const active = host.childViews[0] as FakePanelView;
    expect(active.moduleId).toBe("attacker");
  });

  // Phase 5b hardening — webviewEntry path traversal guard.
  it("register() rejects webviewEntry with parent-directory traversal", () => {
    const bridge = makeBridge();
    expect(() =>
      bridge.register("evil", {
        id: "main",
        title: "Evil",
        hostApi: [],
        webviewEntry: "../../../etc/hosts",
      }),
    ).toThrow(/escapes the module root/);
  });

  it("register() rejects absolute webviewEntry paths", () => {
    const bridge = makeBridge();
    expect(() =>
      bridge.register("evil", {
        id: "main",
        title: "Evil",
        hostApi: [],
        webviewEntry: "/etc/hosts",
      }),
    ).toThrow(/escapes the module root/);
  });

  it("register() resolves nested webviewEntry paths inside the module root", () => {
    const bridge = makeBridge();
    const reg = bridge.register("well-behaved", {
      id: "main",
      title: "OK",
      hostApi: [],
      webviewEntry: "views/panel.html",
    });
    expect(reg.view.id).toBe("well-behaved:main");
    expect(factory.created[factory.created.length - 1].entryPath).toMatch(
      /\/modules\/well-behaved\/views\/panel\.html$/,
    );
  });
});
