import { ipcMain } from 'electron';
import path from 'path';
import { ProfileStore } from '../../src/core/profile.js';
import { getCurrentBranch, getWorktrees } from '../../src/core/project.js';
import { listDevices } from '../../src/core/device.js';
import { execShellAsync } from '../../src/core/exec-async.js';
import { detectAllPackageManagers } from '../../src/core/clean.js';
import { state } from './state.js';

export function registerWizardHandlers() {
  ipcMain.handle('wizard:hasProfile', async () => {
    if (!state.projectRoot) return false;
    const profileStore = new ProfileStore(path.join(state.projectRoot, '.rn-dev', 'profiles'));
    const branch = await getCurrentBranch(state.projectRoot) ?? 'main';
    return profileStore.findDefault(null, branch) !== null;
  });

  ipcMain.handle('wizard:getWorktrees', async () => {
    if (!state.projectRoot) return [];
    const worktrees = await getWorktrees(state.projectRoot);
    return worktrees.map(wt => ({
      name: wt.isMain ? 'Default (root)' : path.basename(wt.path),
      path: wt.path,
      branch: wt.branch,
      isMain: wt.isMain,
    }));
  });

  ipcMain.handle('wizard:getBranches', async () => {
    if (!state.projectRoot) return [];
    try {
      const output = await execShellAsync(
        'git for-each-ref --sort=-committerdate --format="%(refname:short)" refs/heads/ | head -20',
        { cwd: state.projectRoot, timeout: 5000 }
      );
      return output.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  });

  ipcMain.handle('wizard:createWorktree', async (_, branchName: string) => {
    if (!state.projectRoot) return { ok: false, error: 'No project root' };
    try {
      const worktreePath = path.join(state.projectRoot, '.worktrees', branchName.replace(/\//g, '-'));
      await execShellAsync(`git worktree add "${worktreePath}" -b "${branchName}" 2>&1 || git worktree add "${worktreePath}" "${branchName}" 2>&1`, {
        cwd: state.projectRoot,
        timeout: 30000,
      });
      return {
        ok: true,
        worktree: {
          name: branchName.replace(/\//g, '-'),
          path: worktreePath,
          branch: branchName,
          isMain: false,
        },
      };
    } catch (err: any) {
      return { ok: false, error: err.message?.slice(0, 200) ?? 'Failed to create worktree' };
    }
  });

  ipcMain.handle('wizard:getDevices', async (_, platform: string) => {
    console.log(`[ipc] wizard:getDevices called with platform: ${platform}`);
    try {
      const devices = await listDevices((platform ?? 'both') as any);
      console.log(`[ipc] Found ${devices.length} devices`);
      return devices.map(d => ({
        id: d.id,
        name: d.name,
        type: d.type,
        status: d.status,
        runtime: d.runtime,
        isPhysical: d.isPhysical ?? false,
      }));
    } catch (err: any) {
      console.error(`[ipc] wizard:getDevices error:`, err.message);
      return [];
    }
  });

  ipcMain.handle('wizard:getTooling', async () => {
    if (!state.projectRoot) return [];
    try {
      const { detectTooling } = await import('../../src/core/tooling-detector.js');
      return detectTooling(state.projectRoot);
    } catch {
      return [];
    }
  });

  ipcMain.handle('wizard:getPackageManagers', async () => {
    if (!state.projectRoot) return [];
    return detectAllPackageManagers(state.projectRoot);
  });

  ipcMain.handle('wizard:getPreflightChecks', async () => {
    return [
      { id: 'node-version', label: 'Node.js version', platform: 'all' },
      { id: 'ruby-version', label: 'Ruby version', platform: 'all' },
      { id: 'xcode-cli-tools', label: 'Xcode CLI tools', platform: 'ios' },
      { id: 'cocoapods-installed', label: 'CocoaPods', platform: 'ios' },
      { id: 'podfile-lock-sync', label: 'Podfile.lock sync', platform: 'ios' },
      { id: 'watchman', label: 'Watchman', platform: 'all' },
      { id: 'node-modules-sync', label: 'node_modules sync', platform: 'all' },
      { id: 'metro-port', label: 'Metro port available', platform: 'all' },
      { id: 'env-file', label: '.env file', platform: 'all' },
      { id: 'patch-package', label: 'patch-package', platform: 'all' },
      { id: 'code-signing', label: 'Code signing (auto vs manual)', platform: 'ios' },
    ];
  });

  ipcMain.handle('wizard:saveProfile', async (_, profileData) => {
    if (!state.projectRoot) return { ok: false, error: 'No project root' };
    const profile = { ...profileData, projectRoot: state.projectRoot };
    const profileStore = new ProfileStore(path.join(state.projectRoot, '.rn-dev', 'profiles'));
    profileStore.save(profile);
    return { ok: true };
  });
}
