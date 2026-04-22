import { ipcMain } from 'electron';
import { instances, state, appendLog, send } from './state.js';

export function registerMetroHandlers() {
  ipcMain.handle('metro:reload', async () => {
    const instance = state.activeInstanceId ? instances.get(state.activeInstanceId) : null;
    if (instance?.metro) {
      const worktreeKey = state.artifactStore?.worktreeHash(instance.worktree) ?? instance.id;
      instance.metro.reload(worktreeKey);
      const msg = 'Reload signal sent';
      appendLog(instance, 'service', msg);
      send('instance:log', { instanceId: instance.id, text: msg });
    } else {
      send('service:log', 'Metro not running');
    }
  });

  ipcMain.handle('metro:devMenu', async () => {
    const instance = state.activeInstanceId ? instances.get(state.activeInstanceId) : null;
    if (instance?.metro) {
      const worktreeKey = state.artifactStore?.worktreeHash(instance.worktree) ?? instance.id;
      instance.metro.devMenu(worktreeKey);
      const msg = 'Dev menu signal sent';
      appendLog(instance, 'service', msg);
      send('instance:log', { instanceId: instance.id, text: msg });
    } else {
      send('service:log', 'Metro not running');
    }
  });

  ipcMain.handle('metro:port', async () => {
    const instance = state.activeInstanceId ? instances.get(state.activeInstanceId) : null;
    return instance?.port ?? 8081;
  });
}
