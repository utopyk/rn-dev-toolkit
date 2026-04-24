import { ipcMain } from 'electron';
import { serviceBus } from '../../src/app/service-bus.js';
import type { MetroClient } from '../../src/app/client/metro-adapter.js';
import { instances, state, appendLog, send } from './state.js';

// Phase 13.4.1 — flipped to the daemon-client MetroClient. The in-process
// MetroManager on `instance.metro` is going away as services.ts collapses
// into a ~50-LOC Electron-UX wrapper; the instance shape still exists
// renderer-side (one visible "instance" per Electron session) but its
// runtime services now live in the daemon and are addressed through the
// serviceBus adapter that `connectElectronToDaemon` publishes.
let metroClient: MetroClient | null = null;
serviceBus.on('metro', (client: MetroClient) => {
  metroClient = client;
});

export function registerMetroHandlers() {
  ipcMain.handle('metro:reload', async () => {
    if (!metroClient) {
      send('service:log', 'Metro not running');
      return;
    }
    await metroClient.reload();
    const instance = state.activeInstanceId
      ? instances.get(state.activeInstanceId)
      : null;
    const msg = 'Reload signal sent';
    if (instance) {
      appendLog(instance, 'service', msg);
      send('instance:log', { instanceId: instance.id, text: msg });
    } else {
      send('service:log', msg);
    }
  });

  ipcMain.handle('metro:devMenu', async () => {
    if (!metroClient) {
      send('service:log', 'Metro not running');
      return;
    }
    await metroClient.devMenu();
    const instance = state.activeInstanceId
      ? instances.get(state.activeInstanceId)
      : null;
    const msg = 'Dev menu signal sent';
    if (instance) {
      appendLog(instance, 'service', msg);
      send('instance:log', { instanceId: instance.id, text: msg });
    } else {
      send('service:log', msg);
    }
  });

  ipcMain.handle('metro:port', async () => {
    // One daemon = one worktree = one session, so the port lives on the
    // daemon's Metro instance. Falls back to 8081 when the session hasn't
    // published a MetroInstance yet (renderer queries this on mount,
    // before the session's first `metro/status` → running transition).
    if (!metroClient) return state.activeInstanceId
      ? instances.get(state.activeInstanceId)?.port ?? 8081
      : 8081;
    try {
      const inst = await metroClient.getInstance();
      return inst?.port ?? 8081;
    } catch {
      return 8081;
    }
  });
}
