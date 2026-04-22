// Electron-runtime binding for `panel-bridge.ts`.
//
// Wraps `BrowserWindow` + `WebContentsView` into the `BrowserHost` +
// `PanelViewFactory` seams that the pure-logic bridge consumes. This file
// imports `electron` and therefore only runs inside the Electron main
// process — it is NOT imported by vitest (tests use the fakes in
// `__tests__/panel-bridge.test.ts`).

import { BrowserWindow, WebContentsView } from "electron";
import path from "node:path";
import {
  createPanelBridge,
  type BrowserHost,
  type CreatePanelBridgeOptions,
  type PanelBridge,
  type PanelBounds,
  type PanelView,
  type PanelViewFactory,
  type PanelViewFactoryOptions,
} from "./panel-bridge.js";
import type { PanelSenderRegistry } from "./panel-sender-registry.js";

export interface InstallPanelBridgeOptions {
  window: BrowserWindow;
  preloadPath: string;
  moduleRoot: (moduleId: string) => string;
  getBounds: () => PanelBounds;
  auditLog?: CreatePanelBridgeOptions["auditLog"];
  /**
   * Phase 5b hardening — populated as new panel WebContentsViews are
   * created so the `modules:*` ipcMain handlers can bind `_event.sender`
   * to a moduleId and reject spoofed payloads. Optional for test code
   * that uses the pure panel-bridge without the Electron runtime.
   */
  senderRegistry?: PanelSenderRegistry;
}

export function installPanelBridge(
  opts: InstallPanelBridgeOptions,
): PanelBridge {
  const host = createElectronBrowserHost(opts.window);
  const factory = createElectronPanelViewFactory(
    opts.preloadPath,
    opts.senderRegistry,
  );
  return createPanelBridge({
    host,
    factory,
    getBounds: opts.getBounds,
    moduleRoot: opts.moduleRoot,
    auditLog: opts.auditLog,
  });
}

// ---------------------------------------------------------------------------
// BrowserHost — thin adapter over BrowserWindow.contentView + window events
// ---------------------------------------------------------------------------

export function createElectronBrowserHost(window: BrowserWindow): BrowserHost {
  return {
    addChildView(view) {
      const wcv = viewToWCV(view);
      // BrowserWindow inherits a `contentView` from BaseWindow in Electron
      // 30+; `addChildView` takes the inner WebContentsView.
      window.contentView.addChildView(wcv);
    },
    removeChildView(view) {
      const wcv = viewToWCV(view);
      window.contentView.removeChildView(wcv);
    },
    onResize(listener) {
      const h = () => listener();
      window.on("resize", h);
      return () => window.off("resize", h);
    },
    onClose(listener) {
      const h = () => listener();
      window.on("closed", h);
      return () => window.off("closed", h);
    },
  };
}

// ---------------------------------------------------------------------------
// PanelViewFactory — creates sandboxed WebContentsView per (moduleId, panelId)
// ---------------------------------------------------------------------------

interface WCVPanelView extends PanelView {
  _wcv: WebContentsView;
}

const wcvSymbol = Symbol("panel-bridge.wcv");

function attachWCV(view: PanelView, wcv: WebContentsView): WCVPanelView {
  (view as unknown as Record<symbol, WebContentsView>)[wcvSymbol] = wcv;
  (view as WCVPanelView)._wcv = wcv;
  return view as WCVPanelView;
}

function viewToWCV(view: PanelView): WebContentsView {
  const wcv = (view as unknown as Record<symbol, WebContentsView>)[wcvSymbol];
  if (!wcv) {
    throw new Error(
      `[panel-bridge] PanelView "${view.id}" is not an Electron-backed view`,
    );
  }
  return wcv;
}

export function createElectronPanelViewFactory(
  preloadPath: string,
  senderRegistry?: PanelSenderRegistry,
): PanelViewFactory {
  return {
    create(opts: PanelViewFactoryOptions): PanelView {
      const wcv = new WebContentsView({
        webPreferences: {
          partition: `persist:mod-${opts.moduleId}`,
          preload: preloadPath,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          // Preload reads these at startup to establish its bridge scope.
          additionalArguments: [
            `--rn-dev-module-id=${opts.moduleId}`,
            `--rn-dev-panel-id=${opts.panelId}`,
            `--rn-dev-host-api=${opts.hostApiAllowlist.join(",")}`,
          ],
        },
      });
      // Phase 5b hardening — bind this webContents to its moduleId so
      // ipcMain handlers can reject spoofed payloads via _event.sender.
      senderRegistry?.registerPanel(wcv.webContents, opts.moduleId);
      void wcv.webContents.loadFile(path.resolve(opts.entryPath));

      const view: PanelView = {
        id: `${opts.moduleId}:${opts.panelId}`,
        setBounds(b) {
          wcv.setBounds(b);
        },
        focus() {
          wcv.webContents.focus();
        },
        async close() {
          try {
            wcv.webContents.close();
          } catch {
            /* already closed */
          }
        },
      };
      return attachWCV(view, wcv);
    },
  };
}
