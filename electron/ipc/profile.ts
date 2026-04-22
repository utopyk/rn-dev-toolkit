import { ipcMain } from 'electron';
import path from 'path';
import { ProfileStore } from '../../src/core/profile.js';
import { getWorktrees } from '../../src/core/project.js';
import { instances, state } from './state.js';

export function registerProfileHandlers() {
  ipcMain.handle('profiles:list', async () => {
    if (!state.projectRoot) return [];
    const profileStore = new ProfileStore(path.join(state.projectRoot, '.rn-dev', 'profiles'));
    return profileStore.list().map(p => ({
      name: p.name,
      branch: p.branch,
      platform: p.platform,
      mode: p.mode,
      isDefault: p.isDefault,
      deviceId: p.devices?.ios ?? p.devices?.android ?? null,
    }));
  });

  ipcMain.handle('profiles:setDefault', async (_, name: string) => {
    if (!state.projectRoot) return { ok: false };
    const profileStore = new ProfileStore(path.join(state.projectRoot, '.rn-dev', 'profiles'));
    const profile = profileStore.load(name);
    if (!profile) return { ok: false };
    profileStore.setDefault(name, profile.worktree, profile.branch);
    return { ok: true };
  });

  ipcMain.handle('profiles:delete', async (_, name: string) => {
    if (!state.projectRoot) return { ok: false };
    const profileStore = new ProfileStore(path.join(state.projectRoot, '.rn-dev', 'profiles'));
    return { ok: profileStore.delete(name) };
  });

  ipcMain.handle('worktrees:list', async () => {
    if (!state.projectRoot) return [];
    return await getWorktrees(state.projectRoot);
  });

  ipcMain.handle('get:profile', async () => {
    const instance = state.activeInstanceId ? instances.get(state.activeInstanceId) : null;
    if (!instance) return null;
    return {
      name: instance.id,
      branch: instance.branch,
      platform: instance.platform,
      dirty: instance.mode === 'dirty',
      port: instance.port,
      buildType: 'debug',
    };
  });

  ipcMain.handle('get:themes', async () => {
    return ['midnight', 'ember', 'arctic', 'neon-drive'];
  });
}
