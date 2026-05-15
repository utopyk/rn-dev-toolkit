import { ipcMain } from 'electron';
import { execShellAsync } from '../../src/core/exec-async.js';
import { serviceBus } from '../../src/app/service-bus.js';
import type { WatcherClient } from '../../src/app/client/watcher-adapter.js';
import type { SessionId } from '../../src/core/identifiers.js';
import {
  instances,
  state,
  appendLog,
  send,
  getActiveSessionRecord,
  getSessionRecordForInstance,
} from './state.js';

// Phase E2 — per-session WatcherClient map. The on-save watcher belongs
// to a session because its watched paths (the worktree + .rn-dev profile
// directory) are session-scoped. Singleton-by-coincidence pre-E.
const watcherClients = new Map<SessionId, WatcherClient>();

serviceBus.on('watcher', ({ sessionId, watcher }) => {
  watcherClients.set(sessionId, watcher);
});

function clientForInstance(instanceId?: string): WatcherClient | null {
  if (instanceId) {
    const record = getSessionRecordForInstance(instanceId);
    if (record) return watcherClients.get(record.sessionId) ?? null;
  }
  const active = getActiveSessionRecord();
  if (!active) return null;
  return watcherClients.get(active.sessionId) ?? null;
}

export function registerToolsHandlers() {
  ipcMain.handle('run:lint', async (_evt, instanceId?: string) => {
    if (!state.projectRoot) return;
    const id = instanceId ?? state.activeInstanceId;
    const instance = id ? instances.get(id) : null;
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

  ipcMain.handle('run:typecheck', async (_evt, instanceId?: string) => {
    if (!state.projectRoot) return;
    const id = instanceId ?? state.activeInstanceId;
    const instance = id ? instances.get(id) : null;
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

  ipcMain.handle('watcher:toggle', async (_evt, instanceId?: string) => {
    const client = clientForInstance(instanceId);
    if (!client) {
      send('service:log', 'No on-save actions configured');
      return;
    }
    const running = await client.isRunning();
    if (running) {
      await client.stop();
      send('service:log', 'Watcher disabled');
    } else {
      send('service:log', 'Starting watcher...');
      await client.start();
      send('service:log', 'Watcher enabled');
    }
  });

  ipcMain.handle('logs:dump', async () => {
    const fs = require('fs');
    try { fs.mkdirSync('/tmp/rn-dev-logs', { recursive: true }); } catch {}
    send('service:log', 'Logs dumped to /tmp/rn-dev-logs/');
  });
}
