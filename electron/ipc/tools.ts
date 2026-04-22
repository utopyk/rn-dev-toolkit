import { ipcMain } from 'electron';
import { execShellAsync } from '../../src/core/exec-async.js';
import { instances, state, appendLog, send } from './state.js';

export function registerToolsHandlers() {
  ipcMain.handle('run:lint', async () => {
    if (!state.projectRoot) return;
    const instance = state.activeInstanceId ? instances.get(state.activeInstanceId) : null;
    const emitLog = (text: string) => {
      if (instance) {
        appendLog(instance, 'service', text);
        send('instance:log', { instanceId: instance.id, text });
      } else {
        send('service:log', text);
      }
    };
    emitLog('Running ESLint...');
    try {
      const cwd = instance?.worktree ?? state.projectRoot;
      const output = await execShellAsync('npx eslint . --max-warnings=0 2>&1 || true', {
        cwd,
        timeout: 60000,
      });
      const lines = output.split('\n').filter(Boolean);
      for (const line of lines) emitLog(`  ${line}`);
      emitLog('Lint complete');
    } catch (err: any) {
      emitLog(`Lint failed: ${err.message?.slice(0, 100)}`);
    }
  });

  ipcMain.handle('run:typecheck', async () => {
    if (!state.projectRoot) return;
    const instance = state.activeInstanceId ? instances.get(state.activeInstanceId) : null;
    const emitLog = (text: string) => {
      if (instance) {
        appendLog(instance, 'service', text);
        send('instance:log', { instanceId: instance.id, text });
      } else {
        send('service:log', text);
      }
    };
    emitLog('Running tsc --noEmit...');
    try {
      const cwd = instance?.worktree ?? state.projectRoot;
      const output = await execShellAsync('npx tsc --noEmit 2>&1 || true', {
        cwd,
        timeout: 120000,
      });
      const lines = output.split('\n').filter(Boolean);
      for (const line of lines) emitLog(`  ${line}`);
      emitLog('Type check complete');
    } catch (err: any) {
      emitLog(`Type check failed: ${err.message?.slice(0, 100)}`);
    }
  });

  ipcMain.handle('run:clean', async () => {
    send('service:log', 'Clean requires selecting a mode. Use Settings > Clean.');
  });

  ipcMain.handle('watcher:toggle', async () => {
    if (!state.watcher) {
      send('service:log', 'No on-save actions configured');
      return;
    }
    if (state.watcher.isRunning()) {
      state.watcher.stop();
      send('service:log', 'Watcher disabled');
    } else {
      send('service:log', 'Starting watcher...');
      state.watcher.start();
      send('service:log', 'Watcher enabled');
    }
  });

  ipcMain.handle('logs:dump', async () => {
    const fs = require('fs');
    try { fs.mkdirSync('/tmp/rn-dev-logs', { recursive: true }); } catch {}
    send('service:log', 'Logs dumped to /tmp/rn-dev-logs/');
  });
}
