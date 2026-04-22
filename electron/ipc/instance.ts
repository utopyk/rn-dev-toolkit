import { ipcMain } from 'electron';
import path from 'path';
import { MetroManager } from '../../src/core/metro.js';
import { ProfileStore } from '../../src/core/profile.js';
import { Builder } from '../../src/core/builder.js';
import { getCurrentBranch } from '../../src/core/project.js';
import { listDevices } from '../../src/core/device.js';
import { createDefaultPreflightEngine } from '../../src/core/preflight.js';
import { execShellAsync } from '../../src/core/exec-async.js';
import { CleanManager } from '../../src/core/clean.js';
import {
  instances,
  state,
  send,
  appendLog,
  toSummary,
  findFreePort,
  type InstanceState,
} from './state.js';
import { startInstanceServices } from './services.js';

export function registerInstanceHandlers() {
  ipcMain.handle('instances:list', async () => {
    return Array.from(instances.values()).map(toSummary);
  });

  ipcMain.handle('instances:create', async (_, data) => {
    if (!state.projectRoot) return { ok: false, error: 'No project root' };

    let profileData;
    if (typeof data === 'string') {
      // data is a profile name — load it from disk
      const profileStore = new ProfileStore(path.join(state.projectRoot, '.rn-dev', 'profiles'));
      profileData = profileStore.load(data);
      if (!profileData) return { ok: false, error: `Profile "${data}" not found` };
    } else {
      // data is raw profile object (from wizard)
      profileData = data;
    }

    const worktreePath = profileData.worktree ?? null;
    const worktreeName = worktreePath ? path.basename(worktreePath) : 'main';
    // Always auto-allocate a free port to avoid conflicts between instances
    const port = findFreePort();
    const id = `${worktreeName}-${port}`;

    // Don't create duplicates
    if (instances.has(id)) {
      return { ok: false, error: `Instance ${id} already exists` };
    }

    const branch = profileData.branch ?? await getCurrentBranch(state.projectRoot) ?? 'main';

    // Determine device info
    let deviceName = 'No device';
    let deviceIcon = '💻';
    let deviceId: string | null = null;

    if (profileData.devices) {
      const iosDeviceId = profileData.devices.ios;
      const androidDeviceId = profileData.devices.android;
      deviceId = iosDeviceId ?? androidDeviceId ?? null;

      if (deviceId) {
        try {
          const platform = profileData.platform ?? 'ios';
          const deviceList = await listDevices(platform);
          const foundDevice = deviceList.find(d => d.id === deviceId);
          if (foundDevice) {
            deviceName = foundDevice.name;
            deviceIcon = foundDevice.isPhysical ? '📱' : '💻';
          }
        } catch {
          // Keep defaults
        }
      }
    }

    const instance: InstanceState = {
      id,
      worktree: worktreePath,
      worktreeName,
      branch,
      port,
      deviceId,
      deviceName,
      deviceIcon,
      platform: profileData.platform ?? 'ios',
      mode: profileData.mode ?? 'dirty',
      metro: null,
      devtools: null,
      devtoolsStarted: false,
      builder: null,
      serviceLog: [],
      metroLog: [],
      metroStatus: 'starting',
    };

    instances.set(id, instance);
    state.activeInstanceId = id;

    // Notify renderer of the new instance
    send('instance:created', toSummary(instance));

    // Start services for this instance in the background
    startInstanceServices(instance, profileData).catch(err => {
      const errMsg = `Failed to start services for ${id}: ${err.message}`;
      appendLog(instance, 'service', `ERROR ${errMsg}`);
      send('instance:log', { instanceId: id, text: errMsg });
    });

    return { ok: true, instance: toSummary(instance) };
  });

  ipcMain.handle('instances:remove', async (_, instanceId: string) => {
    const instance = instances.get(instanceId);
    if (!instance) return { ok: false, error: 'Instance not found' };

    // Tear down DevTools (releases proxy port + Metro listener) before Metro,
    // since DevToolsManager subscribes to Metro's status events.
    if (instance.devtools) {
      try {
        await instance.devtools.dispose();
      } catch {
        // Best effort
      }
      instance.devtools = null;
      instance.devtoolsStarted = false;
    }

    // Stop Metro
    if (instance.metro) {
      try {
        const worktreeKey = state.artifactStore?.worktreeHash(instance.worktree) ?? instanceId;
        instance.metro.stop(worktreeKey);
      } catch {
        // Best effort
      }
    }

    instances.delete(instanceId);

    // Switch active to another instance if needed
    if (state.activeInstanceId === instanceId) {
      const remaining = Array.from(instances.keys());
      state.activeInstanceId = remaining.length > 0 ? remaining[0] : null;
    }

    send('instance:removed', instanceId);
    return { ok: true, newActiveId: state.activeInstanceId };
  });

  ipcMain.handle('instances:setActive', async (_, instanceId: string) => {
    if (instances.has(instanceId)) {
      state.activeInstanceId = instanceId;
      return { ok: true };
    }
    return { ok: false, error: 'Instance not found' };
  });

  ipcMain.handle('instances:getActive', async () => {
    return state.activeInstanceId;
  });

  ipcMain.handle('instances:getLogs', async (_, instanceId: string) => {
    const instance = instances.get(instanceId);
    if (!instance) return { serviceLines: [], metroLines: [] };
    return {
      serviceLines: [...instance.serviceLog],
      metroLines: [...instance.metroLog],
    };
  });

  // ── Retry a specific step for an instance ──
  ipcMain.handle('instance:retryStep', async (_, data: { instanceId: string; stepId: string }) => {
    const { instanceId, stepId } = data;
    const instance = instances.get(instanceId);
    if (!instance) return { ok: false, error: 'Instance not found' };
    const { projectRoot, artifactStore } = state;
    if (!projectRoot || !artifactStore) return { ok: false, error: 'No project root' };

    const emit = (text: string) => {
      appendLog(instance, 'service', text);
      send('instance:log', { instanceId: instance.id, text });
    };

    const sectionTitles: Record<string, string> = {
      preflight: 'Preflight Checks',
      clean: `${instance.mode} Clean`,
      watchman: 'Watchman Clear',
      metro: 'Metro Start',
      build: `Build for ${instance.platform}`,
    };

    const title = sectionTitles[stepId] ?? stepId;
    send('instance:section:start', { instanceId: instance.id, id: stepId, title, icon: '\u23F3' });

    try {
      if (stepId === 'preflight') {
        const engine = createDefaultPreflightEngine(projectRoot);

        // Build minimal preflight config — run all checks for the instance's platform
        const preflightConfig = {
          checks: [
            'node-version', 'ruby-version', 'xcode-cli-tools', 'cocoapods-installed',
            'podfile-lock-sync', 'watchman', 'node-modules-sync', 'metro-port', 'env-file',
          ],
          frequency: 'always' as const,
        };

        emit('Running preflight checks...');
        const results = await engine.runAll(instance.platform, preflightConfig);
        let hasErrors = false;
        for (const [id, result] of results) {
          const icon = result.passed ? '  OK' : '  FAIL';
          emit(`${icon} ${id}: ${result.message}`);
          if (!result.passed) hasErrors = true;
        }
        if (hasErrors) {
          emit('  Some preflight checks failed.');
          send('instance:section:end', { instanceId: instance.id, id: stepId, status: 'warning' });
        } else {
          emit('  All preflight checks passed');
          send('instance:section:end', { instanceId: instance.id, id: stepId, status: 'ok' });
        }

      } else if (stepId === 'clean') {
        const effectiveRoot = instance.worktree ?? projectRoot;
        const cleaner = new CleanManager(effectiveRoot);
        const results = await cleaner.execute(instance.mode as any, instance.platform, (step, status) => {
          const icon = status === 'running' ? '\u23F3' : '\u2714';
          emit(`  ${icon} ${step}`);
        });
        const failed = results.filter((r: any) => !r.success);
        if (failed.length > 0) {
          emit(`  ⚠ ${failed.length} clean step(s) had issues`);
          send('instance:section:end', { instanceId: instance.id, id: stepId, status: 'warning' });
        } else {
          emit('Clean complete');
          send('instance:section:end', { instanceId: instance.id, id: stepId, status: 'ok' });
        }

      } else if (stepId === 'watchman') {
        emit('Clearing watchman...');
        await execShellAsync(`watchman watch-del '${projectRoot}'`, { timeout: 10000 }).catch(() => {});
        if (instance.worktree && instance.worktree !== projectRoot) {
          await execShellAsync(`watchman watch-del '${instance.worktree}'`, { timeout: 10000 }).catch(() => {});
        }
        await execShellAsync('watchman watch-del-all', { timeout: 10000 }).catch(() => {});
        emit('Watchman cleared');
        send('instance:section:end', { instanceId: instance.id, id: stepId, status: 'ok' });

      } else if (stepId === 'metro') {
        emit(`Restarting Metro on port ${instance.port}...`);
        // Tear down DevTools first — it holds the old Metro reference via a
        // status listener; rebuilding Metro without disposing would leave a
        // stale subscription.
        if (instance.devtools) {
          try { await instance.devtools.dispose(); } catch { /* best-effort */ }
          instance.devtools = null;
          instance.devtoolsStarted = false;
        }
        // Stop existing metro if running
        if (instance.metro) {
          const worktreeKey = artifactStore.worktreeHash(instance.worktree);
          instance.metro.stop(worktreeKey);
          instance.metro = null;
        }
        await new Promise(r => setTimeout(r, 500));

        const worktreeKey = artifactStore.worktreeHash(instance.worktree);
        const metroMgr = new MetroManager(artifactStore);
        // Kill anything on the port
        const portFree = await metroMgr.isPortFree(instance.port);
        if (!portFree) {
          emit(`Port ${instance.port} in use — killing stale process...`);
          await metroMgr.killProcessOnPort(instance.port);
          await new Promise(r => setTimeout(r, 1000));
        }

        metroMgr.start({
          worktreeKey,
          projectRoot: instance.worktree ?? projectRoot,
          port: instance.port,
          resetCache: false,
          env: {},
        });
        instance.metro = metroMgr;

        metroMgr.on('log', ({ line }: { worktreeKey: string; line: string }) => {
          appendLog(instance, 'metro', line);
          send('instance:metro', { instanceId: instance.id, text: line });
        });

        metroMgr.on('status', ({ status }: { worktreeKey: string; status: string }) => {
          instance.metroStatus = status;
          send('instance:status', { instanceId: instance.id, ...toSummary(instance) });
          if (status === 'running') {
            emit('Metro is running');
            send('instance:section:end', { instanceId: instance.id, id: stepId, status: 'ok' });
          }
        });

      } else if (stepId === 'build') {
        emit(`Rebuilding for ${instance.platform}...`);
        // Stop previous builder if any
        if (instance.builder) {
          instance.builder.removeAllListeners?.();
          instance.builder = null;
        }

        const b = new Builder();
        instance.builder = b;

        b.on('line', ({ text }: { text: string }) => {
          appendLog(instance, 'service', text);
          send('instance:build:line', { instanceId: instance.id, text });
        });

        b.on('done', ({ success, errors }: any) => {
          send('instance:build:done', { instanceId: instance.id, success, errors });
          if (success) {
            emit('Build complete!');
            send('instance:section:end', { instanceId: instance.id, id: stepId, status: 'ok' });
          } else {
            emit('Build failed');
            for (const err of errors ?? []) {
              emit(`  ${err.summary}`);
              if (err.suggestion) emit(`    Fix: ${err.suggestion}`);
            }
            send('instance:section:end', { instanceId: instance.id, id: stepId, status: 'error' });
          }
        });

        const platformsToBuild: Array<'ios' | 'android'> =
          instance.platform === 'both' ? ['ios', 'android'] : [instance.platform];

        for (const plat of platformsToBuild) {
          b.build({
            projectRoot: instance.worktree ?? projectRoot,
            platform: plat,
            deviceId: instance.deviceId ?? undefined,
            port: instance.port,
            variant: 'debug',
            env: {},
          });
        }

      } else {
        emit(`Unknown step: ${stepId}`);
        send('instance:section:end', { instanceId: instance.id, id: stepId, status: 'warning' });
      }

      return { ok: true };
    } catch (err: any) {
      const msg = err.message?.slice(0, 200) ?? 'Unknown error';
      emit(`ERROR ${msg}`);
      send('instance:section:end', { instanceId: instance.id, id: stepId, status: 'error' });
      return { ok: false, error: msg };
    }
  });
}
