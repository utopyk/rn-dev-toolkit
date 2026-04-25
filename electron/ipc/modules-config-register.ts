// Electron-bound registrar for module-config IPC. Separated from
// `modules-config.ts` so the pure logic there can be imported in vitest
// without triggering `import { ipcMain } from "electron"` at module load.
//
// Handlers `await getDeps()` instead of synchronously checking — the
// returned promise resolves immediately if the daemon-client adapter
// has already published, or pends until it does. Closes the boot-
// window race where a renderer panel mounts before
// `connectElectronToDaemon` resolves; the previous "return E_CONFIG_SERVICES_PENDING
// + retry on modules:event ready" path lost events when the renderer
// subscribed AFTER the synthetic ping fired.

import { ipcMain } from "electron";
import {
  handleConfigGet,
  handleConfigSet,
  type ConfigGetPayload,
  type ConfigSetPayload,
  type ModulesConfigIpcDeps,
} from "./modules-config.js";
import type { PanelSenderRegistry } from "../panel-sender-registry.js";

export interface ModulesConfigIpcHandle {
  dispose: () => void;
}

const FAILED_DEPS_REPLY = (msg: string) => ({
  kind: "error" as const,
  code: "E_CONFIG_SERVICES_PENDING" as const,
  message: msg,
});

export function registerModulesConfigIpc(
  getDeps: () => Promise<ModulesConfigIpcDeps>,
  getSenderRegistry?: () => PanelSenderRegistry | null,
): ModulesConfigIpcHandle {
  ipcMain.handle("modules:config-get", async (event, payload: ConfigGetPayload) => {
    let deps: ModulesConfigIpcDeps;
    try {
      deps = await getDeps();
    } catch (err) {
      return FAILED_DEPS_REPLY(err instanceof Error ? err.message : String(err));
    }
    // Read path — host UI can read any moduleId (Marketplace panel
    // enumerates all states; Settings reads its own + potentially peers).
    // Panel senders are still constrained to their own moduleId.
    const senderReg = getSenderRegistry?.();
    if (senderReg && !senderReg.canRead(event.sender, payload.moduleId)) {
      return {
        kind: "error" as const,
        code: "E_CONFIG_SENDER_MISMATCH" as const,
        message:
          "modules:config-get rejected: sender is not bound to the requested module",
      };
    }
    return handleConfigGet(deps, payload);
  });

  ipcMain.handle("modules:config-set", async (event, payload: ConfigSetPayload) => {
    let deps: ModulesConfigIpcDeps;
    try {
      deps = await getDeps();
    } catch (err) {
      return FAILED_DEPS_REPLY(err instanceof Error ? err.message : String(err));
    }
    // Write path — Phase 6 Security P1-1. Host UI can only write to
    // moduleIds in its allowlist (see allowHostWrite). A renderer XSS
    // on the host UI is capped at those modules instead of every
    // installed 3p module's config.
    const senderReg = getSenderRegistry?.();
    if (senderReg && !senderReg.canWrite(event.sender, payload.moduleId)) {
      return {
        kind: "error" as const,
        code: "E_CONFIG_SENDER_MISMATCH" as const,
        message:
          "modules:config-set rejected: sender is not permitted to write the requested module",
      };
    }
    return handleConfigSet(deps, payload);
  });

  return {
    dispose: () => {
      ipcMain.removeHandler("modules:config-get");
      ipcMain.removeHandler("modules:config-set");
    },
  };
}
