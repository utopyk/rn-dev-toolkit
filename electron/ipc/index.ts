import { BrowserWindow } from 'electron';
import path from 'node:path';
import { serviceBus } from '../../src/app/service-bus.js';
import type { ModuleHostClient } from '../../src/app/client/module-host-adapter.js';
import { getDefaultAuditLog, type AuditEntry } from '../../src/core/audit-log.js';
import { state, send } from './state.js';

// Phase 8 — AuditLog is a process-wide singleton so the four audit sinks
// below (panel-bridge, host-call, config-set, install/uninstall) can
// reach it without every registrar threading it in. The three
// `registerModule*Handlers` functions are invoked from inside
// `setupIpcBridge` but live at module scope, so they can't close over a
// local variable there — the previous attempt put `auditLog` inside
// `setupIpcBridge` and tripped the P0 caught in the Phase 8 review
// (`ReferenceError: auditLog is not defined` at every audit callback,
// silently swallowed by `void`). Module scope makes the closure chain
// explicit + visible to every reader.
const auditLog = getDefaultAuditLog();
import { registerInstanceHandlers } from './instance.js';
import { registerMetroHandlers } from './metro.js';
import { registerToolsHandlers } from './tools.js';
import { registerProfileHandlers } from './profile.js';
import { registerWizardHandlers } from './wizard.js';
import { registerDevtoolsHandlers } from './devtools.js';
import { installPanelBridge } from '../panel-bridge-electron.js';
import { PanelSenderRegistry } from '../panel-sender-registry.js';
import { createBoundsCache, type ModulesPanelsIpcDeps } from './modules-panels.js';
import { registerModulesPanelsIpc } from './modules-panels-register.js';
import type { ModulesConfigIpcDeps } from './modules-config.js';
import { registerModulesConfigIpc } from './modules-config-register.js';
import {
  registerModulesInstallIpc,
  type ModulesInstallIpcDeps,
} from './modules-install-register.js';

// Phase 5b hardening — one PanelSenderRegistry per Electron process.
// The main BrowserWindow's webContents is trusted as "host"; panel
// factory registers each new WebContentsView against its moduleId.
// ipcMain handlers consult this via _event.sender to reject spoofed
// moduleId payloads.
const senderRegistry = new PanelSenderRegistry();

// Shared "wait for daemon-client to publish" gate. Handlers that need a
// live `ModuleHostClient` (modules-config / modules-install /
// modules-panels) await this instead of synchronously checking
// `serviceBus.modulesClient`. Closes the boot-window race where a
// renderer panel mounts before `connectElectronToDaemon` resolves and
// the handler returns an empty/pending shape that the renderer can't
// distinguish from "really nothing here". Phase 13.4.1 follow-up.
//
// Resolves with the client once published; rejects after `MODULES_CLIENT_TIMEOUT_MS`
// so a daemon-spawn failure doesn't hang the renderer's invoke
// indefinitely. Resets on `modulesClient` null (daemon disconnect) so
// a reconnect re-arms the wait.
const MODULES_CLIENT_TIMEOUT_MS = 30_000;
let currentModulesClient: import('../../src/app/client/module-host-adapter.js').ModuleHostClient | null = null;
let pendingClientPromise: Promise<import('../../src/app/client/module-host-adapter.js').ModuleHostClient> | null = null;

export function awaitModulesClient(): Promise<import('../../src/app/client/module-host-adapter.js').ModuleHostClient> {
  if (currentModulesClient) return Promise.resolve(currentModulesClient);
  if (pendingClientPromise) return pendingClientPromise;
  pendingClientPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      serviceBus.off('modulesClient', onClient);
      pendingClientPromise = null;
      reject(
        new Error(
          `awaitModulesClient: daemon client did not publish within ${MODULES_CLIENT_TIMEOUT_MS}ms`,
        ),
      );
    }, MODULES_CLIENT_TIMEOUT_MS);
    const onClient = (client: import('../../src/app/client/module-host-adapter.js').ModuleHostClient | null): void => {
      if (!client) return;
      clearTimeout(timer);
      serviceBus.off('modulesClient', onClient);
      pendingClientPromise = null;
      resolve(client);
    };
    serviceBus.on('modulesClient', onClient);
  });
  return pendingClientPromise;
}

serviceBus.on('modulesClient', (client) => {
  currentModulesClient = client ?? null;
});

export { startRealServices } from './services.js';

/**
 * Register every ipcMain handler group for the rn-dev Electron host.
 * Split from the former monolithic electron/ipc-bridge.ts in Phase 0.5 of the
 * module-system work — each file under electron/ipc/ owns a single concern.
 */
export function setupIpcBridge(window: BrowserWindow, initialProjectRoot?: string) {
  state.mainWindow = window;
  if (initialProjectRoot) {
    state.projectRoot = initialProjectRoot;
  }

  // Trust the main BrowserWindow's webContents as the host UI. READ
  // access is wildcard (Marketplace panel enumerates every module; the
  // modules:list surface needs cross-module reads). WRITE access is an
  // explicit allowlist — Phase 6 Security P1-1 caps renderer-XSS blast
  // radius. `settings` is the only host-writable module today; add more
  // here when a new host-native panel legitimately edits another
  // module's config.
  senderRegistry.trustHostSender(window.webContents);
  senderRegistry.allowHostWrite('settings');

  // Forward service bus events to renderer (legacy, for global logs)
  serviceBus.on('log', (text: string) => send('service:log', text));

  // Phase 8 — every privileged host action funnels through the
  // HMAC-chained AuditLog. The service-log pane UX is preserved via a
  // single subscription that renders each audit entry as a human-
  // readable line; the structured record persists at `~/.rn-dev/audit.log`
  // and survives across daemon restarts (chain verifies post-hoc).
  //
  // The `appended` listener attaches HERE rather than at module load
  // because `send()` requires `state.mainWindow` to be set. Any audit
  // entry logged before `setupIpcBridge` runs (unusual — it runs before
  // any module-related IPC could fire) lands on disk but not in the
  // service-log pane. Not a correctness hazard; it's a late-subscriber
  // UX note the architecture reviewer flagged.
  auditLog.on('appended', (entry: AuditEntry) => {
    send('service:log', formatAuditEntry(entry));
  });

  // Phase 13.4.1 — forward module-system events to the renderer so the
  // sidebar rebuilds when a 3p module installs / crashes / toggles and
  // Settings + Marketplace panels live-update on `config-changed`. Pre-
  // flip this subscribed to `serviceBus.moduleEventsBus` which the
  // deleted `module-system-bootstrap.ts` used to publish; now we
  // subscribe to the `ModuleHostClient.on('modules-event', ...)` surface
  // the daemon client exposes. Kieran P0-1 on PR #20 — without this,
  // `modules:event` never fires post-flip and Settings + Marketplace
  // regress to empty states.
  //
  // The adapter's built-in `dispatch()` only covers the 3 supervisor-
  // level events (state-changed/crashed/failed) that ride the session's
  // events/subscribe stream. `subscribeToEvents()` opens a second
  // daemon subscription against `modules/subscribe` which carries the
  // full breadth (install/uninstall/enabled/disabled/restarted/
  // config-changed) that the renderer's Marketplace + Settings panels
  // rely on. Kieran P0-2.
  serviceBus.on('modulesClient', (client: ModuleHostClient | null) => {
    if (!client) return;
    client.on('modules-event', (event) => send('modules:event', event));
    void client.subscribeToEvents().catch((err: unknown) => {
      // Best-effort — if the subscribe fails (daemon tears down the
      // socket mid-handshake, transient FS fault), renderer regresses
      // to state-changed/crashed/failed only until reconnect.
      console.error('[electron] modules/subscribe failed:', err);
    });
  });

  registerInstanceHandlers();
  registerMetroHandlers();
  registerToolsHandlers();
  registerProfileHandlers();
  registerWizardHandlers();
  registerDevtoolsHandlers();
  registerModulePanelsHandlers(window);
  registerModulesConfigHandlers();
  registerModulesInstallHandlers();
}

/**
 * Phase 4 (13.4.1 flipped) — install the module-panels bridge + its
 * ipcMain channels. Data-plane resolution (list, list-panels, host-call,
 * call-tool) routes through the daemon client; panel-lifecycle ops
 * (activate/deactivate/set-bounds) drive the local WebContentsView but
 * pre-fetch the manifest contribution + moduleRoot from the daemon via
 * `modules/resolve-panel`.
 *
 * The panel-bridge's `moduleRoot(id)` callback reads from a per-handler
 * cache (`moduleRoots`) populated by the `modules:activate-panel`
 * handler. The bridge's synchronous `register(moduleId, contribution)`
 * signature is preserved that way — the async RPC round-trip happens
 * upstream of the register call, never inside it.
 */
function registerModulePanelsHandlers(window: BrowserWindow): void {
  const boundsCache = createBoundsCache();
  const moduleRoots = new Map<string, string>();
  let deps: ModulesPanelsIpcDeps | null = null;

  const handle = registerModulesPanelsIpc(
    async () => {
      if (deps) return deps;
      // Wait for modulesClient to publish, then deps will populate via
      // the listener below; loop a tick to pick it up.
      await awaitModulesClient();
      // The listener that builds `deps` runs synchronously after the
      // serviceBus emit; by the time the awaitModulesClient promise
      // resolves, `deps` is populated.
      if (!deps) {
        throw new Error(
          'modules-panels: modulesClient published but deps were not initialized',
        );
      }
      return deps;
    },
    () => senderRegistry,
  );

  serviceBus.on('modulesClient', (client) => {
    if (!client) {
      // Daemon dropped — invalidate. The panel-bridge stays installed
      // (its BrowserWindow hook owns the lifecycle); a fresh `deps` will
      // land on the next `setModulesClient` after reconnect.
      deps = null;
      moduleRoots.clear();
      return;
    }
    if (deps) return;

    const preloadPath = path.join(__dirname, '..', 'preload-module.js');
    const bridge = installPanelBridge({
      window,
      preloadPath,
      moduleRoot: (id: string) => moduleRoots.get(id) ?? '',
      getBounds: () =>
        handle.getActiveBounds() ?? { x: 0, y: 0, width: 0, height: 0 },
      auditLog: (event) => {
        void auditLog.append({
          kind: 'panel-bridge',
          moduleId: event.moduleId,
          outcome: 'ok',
          action: event.kind,
          panelId: event.panelId,
        });
      },
      senderRegistry,
    });

    deps = {
      bridge,
      modulesClient: client,
      bounds: boundsCache,
      moduleRoots,
    };

    // Re-notify the renderer so sidebar re-fetches panel list now that
    // deps are live. Renderer subscribes to `modules:event` and refetches
    // `modules:list-panels` on any kind — `ready` is a synthetic marker
    // for "deps just transitioned to non-null". Same semantics as before
    // the flip; the trigger is now serviceBus.modulesClient arrival.
    send('modules:event', { kind: 'ready', moduleId: '', scopeUnit: '' });
  });

  // Clear moduleRoots on uninstall / state-changed (module left `active`)
  // so the panel-bridge's `moduleRoot(id)` callback never hands out a
  // stale path after uninstall-then-reinstall. Sec P1-1 + Arch P1 on
  // PR #20. Attached once per `setupIpcBridge` call; the subscription
  // reads live `deps` via closure so it works across disconnect cycles.
  const moduleRootsInvalidator = (event: { kind?: string; moduleId?: string }) => {
    if (!event.moduleId) return;
    if (event.kind === 'uninstall' || event.kind === 'crashed' || event.kind === 'failed') {
      moduleRoots.delete(event.moduleId);
    }
  };
  serviceBus.on('modulesClient', (client) => {
    if (!client) return;
    client.on('modules-event', moduleRootsInvalidator);
  });
}

/**
 * Phase 5a (13.4.1 flipped) — install the module-config ipcMain channels.
 * Handlers register eagerly; deps fill in once `connectElectronToDaemon`
 * publishes `modulesClient` (the daemon-client RPC surface). The
 * in-process `moduleHost` / `moduleRegistry` / `moduleEventsBus` topics
 * are no longer consulted here — reads + writes both go through the
 * client's `configGet` / `configSet` round-trip. The service:log audit
 * sink stays Electron-side so the renderer's log pane keeps showing
 * config-set outcomes; the daemon runs its own HMAC-chained audit log.
 */
function registerModulesConfigHandlers(): void {
  let deps: ModulesConfigIpcDeps | null = null;

  registerModulesConfigIpc(
    async () => {
      if (deps) return deps;
      await awaitModulesClient();
      if (!deps) {
        throw new Error(
          'modules-config: modulesClient published but deps were not initialized',
        );
      }
      return deps;
    },
    () => senderRegistry,
  );

  serviceBus.on('modulesClient', (client) => {
    if (!client) {
      deps = null;
      return;
    }
    if (deps) return;
    deps = {
      modulesClient: client,
      auditConfigSet: (event) => {
        void auditLog.append({
          kind: 'config-set',
          moduleId: event.moduleId,
          outcome: event.outcome === 'ok' ? 'ok' : 'error',
          patchKeys: event.patchKeys,
          ...(event.code ? { code: event.code } : {}),
          ...(event.scopeUnit ? { scopeUnit: event.scopeUnit } : {}),
        });
      },
    };
  });
}

/**
 * Phase 6 (13.4.1 flipped) — install/uninstall/marketplace ipcMain
 * handlers. Deps resolve to the daemon-client RPC surface (`modulesClient`)
 * published by `connectElectronToDaemon`. Kieran + Security P1 sender-
 * identity gate unchanged: a sandboxed panel still can't trigger
 * pacote-backed installs on the user's behalf — the marketplace write
 * principal is only granted to the host UI's webContents.
 */
function registerModulesInstallHandlers(): void {
  let deps: ModulesInstallIpcDeps | null = null;

  senderRegistry.allowHostWrite('marketplace');
  registerModulesInstallIpc(
    async () => {
      if (deps) return deps;
      await awaitModulesClient();
      if (!deps) {
        throw new Error(
          'modules-install: modulesClient published but deps were not initialized',
        );
      }
      return deps;
    },
    () => senderRegistry,
  );

  serviceBus.on('modulesClient', (client) => {
    if (!client) {
      deps = null;
      return;
    }
    if (deps) return;
    deps = {
      modulesClient: client,
      auditInstall: (event) => {
        void auditLog.append({
          kind: event.kind,
          moduleId: event.moduleId,
          outcome: event.outcome === 'ok' ? 'ok' : 'error',
          ...(event.code ? { code: event.code } : {}),
          ...(event.version ? { version: event.version } : {}),
        });
      },
    };
  });
}

/**
 * Render a structured audit entry as a service-log line so the existing
 * log pane UX doesn't regress. Phase 13.4.1 — host-call entries now
 * originate from the daemon (Sec P1-2 on PR #20 dropped the duplicate
 * Electron-side append); since the renderer doesn't subscribe to the
 * daemon's audit-log stream, `host-call` entries visible to this
 * formatter are legacy pre-flip entries on the HMAC chain. Keep the
 * branch so `verify()`-style tooling doesn't choke.
 */
function formatAuditEntry(entry: AuditEntry): string {
  const id = entry.moduleId || '(host)';
  const tag = `[${entry.kind}]`;
  const codeSuffix = 'code' in entry && entry.code ? ` (${entry.code})` : '';
  switch (entry.kind) {
    case 'install':
    case 'uninstall': {
      const v = 'version' in entry && entry.version ? ` v${entry.version}` : '';
      return `${tag} ${id}${v} ${entry.outcome}${codeSuffix}`;
    }
    case 'host-call':
      return `${tag} ${id}/${entry.capabilityId}.${entry.method} ${entry.outcome}`;
    case 'config-set': {
      const scope = entry.scopeUnit ? `:${entry.scopeUnit}` : '';
      return `${tag} ${id}${scope} keys=[${entry.patchKeys.join(',')}] ${entry.outcome}${codeSuffix}`;
    }
    case 'panel-bridge':
      return `${tag} ${entry.action} ${id}:${entry.panelId} ${entry.outcome}`;
  }
}
