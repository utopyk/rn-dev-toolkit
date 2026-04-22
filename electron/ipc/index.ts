import { BrowserWindow } from 'electron';
import type { EventEmitter } from 'node:events';
import path from 'node:path';
import { serviceBus } from '../../src/app/service-bus.js';
import type { ModuleHostManager } from '../../src/core/module-host/manager.js';
import type { ModuleRegistry } from '../../src/modules/registry.js';
import { state, send } from './state.js';
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

// Phase 5b hardening — one PanelSenderRegistry per Electron process.
// The main BrowserWindow's webContents is trusted as "host"; panel
// factory registers each new WebContentsView against its moduleId.
// ipcMain handlers consult this via _event.sender to reject spoofed
// moduleId payloads.
const senderRegistry = new PanelSenderRegistry();

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

  // Trust the main BrowserWindow's webContents — it's the host UI and
  // may address any moduleId via modules:config-* (e.g. Settings panel
  // editing another module's config).
  senderRegistry.trustHostSender(window.webContents);

  // Forward service bus events to renderer (legacy, for global logs)
  serviceBus.on('log', (text: string) => send('service:log', text));

  // Forward module-system events to the renderer so the sidebar rebuilds
  // when a 3p module installs / crashes / toggles. Same payload the MCP
  // server consumes via `modules/subscribe` — one subscription path.
  serviceBus.on('moduleEvent', (event) => send('modules:event', event));

  registerInstanceHandlers();
  registerMetroHandlers();
  registerToolsHandlers();
  registerProfileHandlers();
  registerWizardHandlers();
  registerDevtoolsHandlers();
  registerModulePanelsHandlers(window);
  registerModulesConfigHandlers();
}

/**
 * Phase 4 — install the module-panels bridge + its ipcMain channels.
 * Channels are registered EAGERLY during `setupIpcBridge` with a
 * `getDeps()` closure so the renderer can safely invoke
 * `modules:list-panels` on mount, before `startRealServices` has
 * finished publishing `moduleHost` + `moduleRegistry`. Missing deps
 * return empty/no-op defaults rather than
 * "No handler registered for ..." errors.
 */
function registerModulePanelsHandlers(window: BrowserWindow): void {
  const boundsCache = createBoundsCache();
  let deps: ModulesPanelsIpcDeps | null = null;
  let handleGetActiveBounds: (() => ReturnType<typeof boundsCache.get>) | null = null;

  const handle = registerModulesPanelsIpc(
    () => deps,
    () => senderRegistry,
  );
  handleGetActiveBounds = handle.getActiveBounds;

  let latestManager: ModuleHostManager | null = null;
  let latestRegistry: ModuleRegistry | null = null;

  const tryInstall = () => {
    if (!latestManager || !latestRegistry || deps) return;
    const manager = latestManager;
    const registry = latestRegistry;

    const preloadPath = path.join(__dirname, '..', 'preload-module.js');
    const bridge = installPanelBridge({
      window,
      preloadPath,
      moduleRoot: (id: string) => {
        const reg = registry
          .getAllManifests()
          .find((m) => m.manifest.id === id);
        return reg?.modulePath ?? '';
      },
      getBounds: () =>
        handleGetActiveBounds?.() ?? { x: 0, y: 0, width: 0, height: 0 },
      auditLog: (event) => {
        send('service:log', `[panel-bridge] ${event.kind} ${event.moduleId}:${event.panelId}`);
      },
      senderRegistry,
    });

    deps = {
      bridge,
      manager,
      registry,
      bounds: boundsCache,
      auditHostCall: (event) => {
        send(
          'service:log',
          `[host-call] ${event.moduleId}/${event.capabilityId}.${event.method} ${event.outcome}`,
        );
      },
    };

    // Re-notify the renderer so sidebar re-fetches panel list now that deps are live.
    send('modules:event', { kind: 'ready', moduleId: '', scopeUnit: '' });
  };

  serviceBus.on('moduleHost', (m) => {
    latestManager = m;
    tryInstall();
  });
  serviceBus.on('moduleRegistry', (r) => {
    latestRegistry = r;
    tryInstall();
  });
}

/**
 * Phase 5a — install the module-config ipcMain channels. Same lazy-deps
 * pattern as the panel-bridge: handlers register eagerly, deps fill in
 * when `startRealServices` publishes moduleHost / moduleRegistry / the
 * shared module-events bus. Audit sink routes to `service:log` — parity
 * with the Phase 4 `modules:host-call` audit pattern. An HMAC-chained
 * `AuditLog.append()` sink will replace both when it lands.
 */
function registerModulesConfigHandlers(): void {
  let deps: ModulesConfigIpcDeps | null = null;

  registerModulesConfigIpc(
    () => deps,
    () => senderRegistry,
  );

  let latestManager: ModuleHostManager | null = null;
  let latestRegistry: ModuleRegistry | null = null;
  let latestEvents: EventEmitter | null = null;

  const tryInstall = (): void => {
    if (!latestManager || !latestRegistry || !latestEvents || deps) return;
    deps = {
      manager: latestManager,
      registry: latestRegistry,
      moduleEvents: latestEvents,
      auditConfigSet: (event) => {
        send(
          'service:log',
          `[modules-config] set ${event.moduleId}${event.scopeUnit ? `:${event.scopeUnit}` : ''} keys=[${event.patchKeys.join(',')}] ${event.outcome}${event.code ? ` (${event.code})` : ''}`,
        );
      },
    };
  };

  serviceBus.on('moduleHost', (m) => {
    latestManager = m;
    tryInstall();
  });
  serviceBus.on('moduleRegistry', (r) => {
    latestRegistry = r;
    tryInstall();
  });
  serviceBus.on('moduleEventsBus', (bus) => {
    latestEvents = bus;
    tryInstall();
  });
}
