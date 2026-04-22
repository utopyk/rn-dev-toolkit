// Panel bridge — host-side registry of module-contributed Electron panels.
//
// Pure TypeScript; does NOT import `electron` directly. The Electron runtime
// binding lives in `panel-bridge-electron.ts`, which implements the
// `BrowserHost` / `PanelViewFactory` seams this module takes as injected
// dependencies. Keeping the logic pure lets vitest exercise registration,
// show/hide, resize routing, and cross-module isolation without a live
// Electron runtime.
//
// Design rules (from the Phase 4 plan):
//   - One WebContentsView per `(moduleId, panelId)` pair.
//   - Per-module partition `persist:mod-<id>` (wired in the factory).
//   - Single preload (`preload-module.js`) receiving `moduleId` + `hostApi[]`
//     as additional-arguments (also wired in the factory).
//   - Only one panel attached to the window's contentView at a time —
//     switching panels removes the previous view before adding the next so
//     cross-module DOM delivery is structurally impossible (S6).
//   - Every register/show/hide/unregister is audit-logged.

import type { ElectronPanelContribution } from "@rn-dev/module-sdk";

import path from "node:path";

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

export interface PanelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelView {
  /** Stable identity — `<moduleId>:<panelId>`. Used in audit logs. */
  readonly id: string;
  setBounds(bounds: PanelBounds): void;
  focus(): void;
  /** Closes the underlying webContents. Required for BaseWindow children. */
  close(): Promise<void>;
}

export interface BrowserHost {
  addChildView(view: PanelView): void;
  removeChildView(view: PanelView): void;
  /** Returns a disposer. */
  onResize(listener: () => void): () => void;
  /** Returns a disposer. */
  onClose(listener: () => void): () => void;
}

export interface PanelViewFactoryOptions {
  moduleId: string;
  panelId: string;
  hostApiAllowlist: string[];
  entryPath: string;
}

export interface PanelViewFactory {
  create(opts: PanelViewFactoryOptions): PanelView;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type PanelAuditEventKind =
  | "register"
  | "show"
  | "hide"
  | "unregister"
  | "destroy-all";

export interface PanelAuditEvent {
  kind: PanelAuditEventKind;
  moduleId: string;
  panelId: string;
  hostApi?: string[];
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Bridge API
// ---------------------------------------------------------------------------

export interface PanelRegistration {
  moduleId: string;
  panelId: string;
  title: string;
  icon?: string;
  view: PanelView;
}

export interface CreatePanelBridgeOptions {
  host: BrowserHost;
  factory: PanelViewFactory;
  /** Returns the panel-region bounds (inside the renderer's content area). */
  getBounds: () => PanelBounds;
  /** Given a moduleId, returns the absolute on-disk directory for the module. */
  moduleRoot: (moduleId: string) => string;
  /** Optional audit-log sink. Called synchronously for register/show/hide. */
  auditLog?: (event: PanelAuditEvent) => void;
}

export interface PanelBridge {
  register(
    moduleId: string,
    contribution: ElectronPanelContribution,
  ): PanelRegistration;
  show(moduleId: string, panelId: string): void;
  hide(moduleId: string, panelId: string): void;
  unregister(moduleId: string, panelId: string): Promise<void>;
  list(): PanelRegistration[];
  /** Reapply bounds to the currently-shown panel. Tests call this directly. */
  applyBounds(): void;
}

export function createPanelBridge(opts: CreatePanelBridgeOptions): PanelBridge {
  const panels = new Map<string, PanelRegistration>();
  let activeKey: string | null = null;

  const key = (moduleId: string, panelId: string) => `${moduleId}:${panelId}`;

  const audit = (
    kind: PanelAuditEventKind,
    moduleId: string,
    panelId: string,
    hostApi?: string[],
  ): void => {
    opts.auditLog?.({
      kind,
      moduleId,
      panelId,
      hostApi,
      timestamp: Date.now(),
    });
  };

  const applyBoundsToActive = (): void => {
    if (!activeKey) return;
    const panel = panels.get(activeKey);
    panel?.view.setBounds(opts.getBounds());
  };

  const destroyAll = async (): Promise<void> => {
    for (const panel of panels.values()) {
      try {
        await panel.view.close();
      } catch {
        /* swallow — close errors during shutdown must not block others */
      }
    }
    panels.clear();
    activeKey = null;
  };

  opts.host.onResize(applyBoundsToActive);
  opts.host.onClose(() => {
    void destroyAll();
  });

  return {
    register(moduleId, contribution) {
      const k = key(moduleId, contribution.id);
      const existing = panels.get(k);
      if (existing) return existing;

      // Phase 5b hardening — reject webviewEntry values that escape the
      // module root. Manifest schema only guarantees minLength: 1; a
      // malicious manifest with `"../../../../etc/hosts"` would otherwise
      // resolve outside the module directory. Curated registry catches
      // this at install time; defense in depth catches it at load time.
      const moduleRoot = opts.moduleRoot(moduleId);
      const entryPath = path.resolve(moduleRoot, contribution.webviewEntry);
      const resolvedRoot = path.resolve(moduleRoot);
      if (
        path.isAbsolute(contribution.webviewEntry) ||
        !isPathInside(entryPath, resolvedRoot)
      ) {
        throw new Error(
          `[panel-bridge] webviewEntry "${contribution.webviewEntry}" for panel "${moduleId}:${contribution.id}" escapes the module root`,
        );
      }
      const view = opts.factory.create({
        moduleId,
        panelId: contribution.id,
        hostApiAllowlist: [...contribution.hostApi],
        entryPath,
      });
      const registration: PanelRegistration = {
        moduleId,
        panelId: contribution.id,
        title: contribution.title,
        icon: contribution.icon,
        view,
      };
      panels.set(k, registration);
      audit("register", moduleId, contribution.id, [...contribution.hostApi]);
      return registration;
    },

    show(moduleId, panelId) {
      const k = key(moduleId, panelId);
      const panel = panels.get(k);
      if (!panel) return;

      if (activeKey && activeKey !== k) {
        const prev = panels.get(activeKey);
        if (prev) opts.host.removeChildView(prev.view);
      }

      opts.host.addChildView(panel.view);
      activeKey = k;
      panel.view.setBounds(opts.getBounds());
      panel.view.focus();
      audit("show", moduleId, panelId);
    },

    hide(moduleId, panelId) {
      const k = key(moduleId, panelId);
      const panel = panels.get(k);
      if (!panel) return;
      if (activeKey === k) {
        opts.host.removeChildView(panel.view);
        activeKey = null;
      }
      audit("hide", moduleId, panelId);
    },

    async unregister(moduleId, panelId) {
      const k = key(moduleId, panelId);
      const panel = panels.get(k);
      if (!panel) return;
      if (activeKey === k) {
        opts.host.removeChildView(panel.view);
        activeKey = null;
      }
      await panel.view.close();
      panels.delete(k);
      audit("unregister", moduleId, panelId);
    },

    list() {
      return [...panels.values()];
    },

    applyBounds() {
      applyBoundsToActive();
    },
  };
}

function isPathInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

