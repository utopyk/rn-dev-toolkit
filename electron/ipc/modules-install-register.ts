// Electron ipcMain handlers for the Phase 6 install/uninstall flow.
//
// Wire protocol:
//   modules:install                → { moduleId, permissionsAccepted,
//                                        thirdPartyAcknowledged } → install reply
//   modules:uninstall              → { moduleId, keepData? }       → uninstall reply
//   marketplace:list               → ()                             → list reply
//   marketplace:info               → { moduleId }                   → info reply
//   modules:acknowledge-third-party → ()                            → { ok: true }
//
// Phase 13.4.1 — every action routes through the daemon client. The
// `getDeps()` closure now resolves a `ModuleHostClient` (published on
// serviceBus by `connectElectronToDaemon`) instead of in-process
// `ModuleHostManager` + `ModuleRegistry` refs. Kieran + Security P1
// (Phase 6) sender-identity gates stay — a sandboxed panel still can't
// trigger pacote-backed installs on the user's behalf.

import { ipcMain } from "electron";
import type { ModuleHostClient } from "../../src/app/client/module-host-adapter.js";
import type { ModuleInstallRequest } from "../../src/app/modules-ipc.js";
import {
  acknowledgeThirdParty,
  hasAcknowledgedThirdParty,
} from "../../src/modules/marketplace/installer.js";
import type { PanelSenderRegistry } from "../panel-sender-registry.js";

/**
 * Sentinel moduleId the host UI must be granted `allowHostWrite(...)` for
 * before install/uninstall channels accept its invocations. Not a real
 * module — it's the "marketplace authority" principal the consent-dialog
 * UX owns. Kieran P1-1 (Phase 6 review): the install channels were
 * missing the sender gate that modules:config-set got, so a sandboxed
 * panel could trigger pacote-backed install flows.
 */
const MARKETPLACE_WRITE_PRINCIPAL = "marketplace" as const;

export interface ModulesInstallIpcDeps {
  modulesClient: ModuleHostClient;
  /**
   * Called on every install/uninstall outcome. Electron registrar wires
   * this to `service:log` so the renderer's service-log pane sees what
   * happened — parity with modules-config's audit sink.
   */
  auditInstall?: (event: InstallAuditEvent) => void;
}

export interface InstallAuditEvent {
  kind: "install" | "uninstall";
  moduleId: string;
  outcome: "ok" | "error";
  code?: string;
  version?: string;
}

export interface ModulesInstallIpcHandle {
  dispose: () => void;
}

const FORBIDDEN_REPLY = {
  kind: "error" as const,
  code: "E_SENDER_FORBIDDEN" as const,
  message:
    "modules:install/uninstall rejected: sender is not permitted to drive the marketplace. " +
    "The host UI must be granted allowHostWrite(\"marketplace\") before it can invoke these channels.",
};

export function registerModulesInstallIpc(
  getDeps: () => Promise<ModulesInstallIpcDeps>,
  getSenderRegistry?: () => PanelSenderRegistry | null,
): ModulesInstallIpcHandle {
  const failedReply = (err: unknown) => ({
    kind: "error" as const,
    code: "E_INSTALL_SERVICES_PENDING" as const,
    message:
      "marketplace: " +
      (err instanceof Error ? err.message : String(err)),
  });

  ipcMain.handle(
    "modules:install",
    async (event, payload: ModuleInstallRequest) => {
      let deps: ModulesInstallIpcDeps;
      try {
        deps = await getDeps();
      } catch (err) {
        return failedReply(err);
      }
      const senderReg = getSenderRegistry?.();
      if (senderReg && !senderReg.canWrite(event.sender, MARKETPLACE_WRITE_PRINCIPAL)) {
        return FORBIDDEN_REPLY;
      }
      const result = await deps.modulesClient.install(payload);
      deps.auditInstall?.({
        kind: "install",
        moduleId: payload?.moduleId ?? "",
        outcome: result.kind,
        ...(result.kind === "error" ? { code: result.code } : { version: result.version }),
      });
      return result;
    },
  );

  ipcMain.handle(
    "modules:uninstall",
    async (
      event,
      payload: { moduleId: string; scopeUnit?: string; keepData?: boolean },
    ) => {
      let deps: ModulesInstallIpcDeps;
      try {
        deps = await getDeps();
      } catch (err) {
        return failedReply(err);
      }
      const senderReg = getSenderRegistry?.();
      if (senderReg && !senderReg.canWrite(event.sender, MARKETPLACE_WRITE_PRINCIPAL)) {
        return FORBIDDEN_REPLY;
      }
      const result = await deps.modulesClient.uninstall(payload);
      deps.auditInstall?.({
        kind: "uninstall",
        moduleId: payload?.moduleId ?? "",
        outcome: result.kind,
        ...(result.kind === "error" ? { code: result.code } : {}),
      });
      return result;
    },
  );

  ipcMain.handle("marketplace:list", async () => {
    try {
      const deps = await getDeps();
      return deps.modulesClient.marketplaceList();
    } catch (err) {
      return failedReply(err);
    }
  });

  ipcMain.handle(
    "marketplace:info",
    async (_event, payload: { moduleId: string }) => {
      try {
        const deps = await getDeps();
        return deps.modulesClient.marketplaceInfo(payload.moduleId);
      } catch (err) {
        return failedReply(err);
      }
    },
  );

  // Two accessor handlers so the renderer's consent dialog can show the
  // ack gate conditionally (first-ever install only) without needing its
  // own filesystem read. These stay Electron-side — the third-party ack
  // is a local UX gate persisted at `~/.rn-dev/third-party-ack` + read by
  // the installer on the daemon side. Moving them to the daemon would
  // cost a round-trip for a boolean the consent dialog needs synchronously.
  ipcMain.handle("modules:acknowledge-third-party", () => {
    acknowledgeThirdParty();
    return { ok: true };
  });

  ipcMain.handle("modules:has-third-party-ack", () => {
    return { acknowledged: hasAcknowledgedThirdParty() };
  });

  return {
    dispose: () => {
      ipcMain.removeHandler("modules:install");
      ipcMain.removeHandler("modules:uninstall");
      ipcMain.removeHandler("marketplace:list");
      ipcMain.removeHandler("marketplace:info");
      ipcMain.removeHandler("modules:acknowledge-third-party");
      ipcMain.removeHandler("modules:has-third-party-ack");
    },
  };
}
