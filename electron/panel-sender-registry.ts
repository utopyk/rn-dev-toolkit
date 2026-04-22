// Phase 5b hardening — sender binding for `modules:*` ipcMain channels.
// Phase 6 Security P1-1 — split host trust into read vs. write tiers.
//
// Before this file existed, `modules:host-call` / `modules:config-get` /
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
// Phase 6 adds a second tier: the host UI is trusted for READS to any
// module (marketplace:list, modules:list, modules:config-get — safe) but
// only allowed to WRITE to an explicit allowlist of module ids. Settings
// is the only host-writable module today; future host-native panels that
// need to write cross-module config register via `allowHostWrite(id)`.
// The previous "host can rewrite anything" behavior was a renderer-XSS
// compromise amplifier.
//
// This file imports `electron` types only — no runtime symbols — so it
// is still safe to import under vitest. The runtime `.webContents`
// references live in `panel-bridge-electron.ts` + `ipc/index.ts`.

import type { WebContents } from "electron";

/**
 * Identity of an IPC sender as resolved against the registry.
 *
 * - `kind: "host"` — the main BrowserWindow's webContents. Trusted for
 *   read-like operations against any moduleId; writes require the
 *   moduleId to be in the host-writable allowlist.
 * - `kind: "panel"` — a sandboxed module panel's webContents. Must only
 *   address its own moduleId, for both reads and writes.
 * - `null` — unknown webContents. Reject the call.
 */
export type SenderIdentity =
  | { kind: "host" }
  | { kind: "panel"; moduleId: string };

export class PanelSenderRegistry {
  private readonly trusted = new WeakSet<WebContents>();
  private readonly panels = new WeakMap<WebContents, string>();
  /**
   * Module ids the host UI is permitted to WRITE. Populated by
   * `allowHostWrite(moduleId)`. The host always retains wildcard READ
   * access — Marketplace needs to enumerate every module's config state.
   */
  private readonly hostWritableModules = new Set<string>();

  /**
   * Trust the host UI's webContents — typically the main BrowserWindow.
   * Called once during setupIpcBridge.
   */
  trustHostSender(wc: WebContents): void {
    this.trusted.add(wc);
  }

  /**
   * Declare that the host UI may write to `moduleId`'s config. Settings
   * is the only module in this set today. A renderer XSS on the host UI
   * is still limited to moduleIds here — the blast radius no longer
   * includes every installed 3p module.
   */
  allowHostWrite(moduleId: string): void {
    this.hostWritableModules.add(moduleId);
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
   * True when the sender is allowed to READ `claimedModuleId`. Host
   * senders can read anything; panel senders can only read their own
   * module. Unknown senders are always rejected.
   */
  canRead(wc: WebContents, claimedModuleId: string): boolean {
    const id = this.resolve(wc);
    if (!id) return false;
    if (id.kind === "host") return true;
    return id.moduleId === claimedModuleId;
  }

  /**
   * True when the sender is allowed to WRITE `claimedModuleId`. Host
   * senders are constrained to the `hostWritableModules` allowlist;
   * panel senders can only write their own module. Unknown senders are
   * rejected.
   */
  canWrite(wc: WebContents, claimedModuleId: string): boolean {
    const id = this.resolve(wc);
    if (!id) return false;
    if (id.kind === "host") return this.hostWritableModules.has(claimedModuleId);
    return id.moduleId === claimedModuleId;
  }

}
