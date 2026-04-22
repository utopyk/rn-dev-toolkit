// Phase 5b hardening — sender binding for `modules:*` ipcMain channels.
//
// Before this existed, `modules:host-call` / `modules:config-get` /
// `modules:config-set` handlers trusted the `moduleId` field on the
// renderer payload. A panel preload (or any webContents that reaches
// ipcRenderer) could invoke one of those channels with another module's
// id and defeat permission gating.
//
// The registry binds each sandboxed panel's `WebContents` to its
// moduleId at view-creation time and trusts the main BrowserWindow's
// `WebContents` as the host UI. Handlers consult the registry via
// `_event.sender` and reject mismatched moduleIds.
//
// This file imports `electron` types only — no runtime symbols — so it
// is still safe to import under vitest. The runtime `.webContents`
// references live in `panel-bridge-electron.ts` + `ipc/index.ts`.

import type { WebContents } from "electron";

/**
 * Identity of an IPC sender as resolved against the registry.
 *
 * - `kind: "host"` — the main BrowserWindow's webContents. Trusted; the
 *   host UI can address any moduleId (Settings panel editing another
 *   module's config, etc.).
 * - `kind: "panel"` — a sandboxed module panel's webContents. Must only
 *   address its own moduleId.
 * - `null` — unknown webContents. Reject the call.
 */
export type SenderIdentity =
  | { kind: "host" }
  | { kind: "panel"; moduleId: string };

export class PanelSenderRegistry {
  private readonly trusted = new WeakSet<WebContents>();
  private readonly panels = new WeakMap<WebContents, string>();

  /**
   * Trust the host UI's webContents — typically the main BrowserWindow.
   * Called once during setupIpcBridge.
   */
  trustHostSender(wc: WebContents): void {
    this.trusted.add(wc);
  }

  /**
   * Bind a panel's webContents to its moduleId. Called by the panel
   * factory when it creates a new WebContentsView.
   */
  registerPanel(wc: WebContents, moduleId: string): void {
    this.panels.set(wc, moduleId);
  }

  /**
   * Resolve an IPC sender. Returns `null` when the webContents is
   * unknown — the handler MUST reject the call in that case.
   */
  resolve(wc: WebContents): SenderIdentity | null {
    if (this.trusted.has(wc)) return { kind: "host" };
    const moduleId = this.panels.get(wc);
    return moduleId ? { kind: "panel", moduleId } : null;
  }

  /**
   * True when the sender is allowed to address `claimedModuleId`. Host
   * senders can address anything; panel senders can only address their
   * own module. Unknown senders are always rejected.
   */
  canAddress(wc: WebContents, claimedModuleId: string): boolean {
    const id = this.resolve(wc);
    if (!id) return false;
    if (id.kind === "host") return true;
    return id.moduleId === claimedModuleId;
  }
}
