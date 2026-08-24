import { ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import path from 'path';
import { ProfileStore } from '../../src/core/profile.js';
import { getCurrentBranch, getWorktrees } from '../../src/core/project.js';
import { listDevices } from '../../src/core/device.js';
import { execShellAsync } from '../../src/core/exec-async.js';
import { detectAllPackageManagers } from '../../src/core/clean.js';
import { discoverBundles } from '../../src/core/build-discovery.js';
import { state } from './state.js';

const PROJECT_CONFIG_BASENAMES = [
  'rn-dev.config.mjs',
  'rn-dev.config.mts',
  'rn-dev.config.ts',
  'rn-dev.config.js',
] as const;

const ENUMERATE_ENVS_TIMEOUT_MS = 5_000;

interface EnvOption {
  key: string;
  label: string;
  description?: string;
}

function findProjectConfigFile(projectRoot: string): string | null {
  for (const basename of PROJECT_CONFIG_BASENAMES) {
    const candidate = path.join(projectRoot, basename);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function coerceEnvOption(raw: unknown): EnvOption | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string' || r.key.length === 0) return null;
  if (typeof r.label !== 'string' || r.label.length === 0) return null;
  const out: EnvOption = { key: r.key, label: r.label };
  if (typeof r.description === 'string') out.description = r.description;
  return out;
}

/**
 * Exported for testing: the pure "load project config + call
 * enumerateEnvs + coerce output" pipeline, no ipcMain involved.
 */
export async function resolveEnvsForProject(
  projectRoot: string | null,
): Promise<EnvOption[]> {
  if (!projectRoot) return [];
  const configFile = findProjectConfigFile(projectRoot);
  if (!configFile) return [];
  try {
    const { loadConfig } = await import('@rn-dev/config');
    const cfg = await loadConfig(configFile, { projectRoot });
    const enumerate = cfg.enumerateEnvs;
    if (typeof enumerate !== 'function') return [];
    const result = await Promise.race([
      Promise.resolve(enumerate()),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('enumerateEnvs timed out')),
          ENUMERATE_ENVS_TIMEOUT_MS,
        ),
      ),
    ]);
    if (!Array.isArray(result)) return [];
    return result
      .map(coerceEnvOption)
      .filter((o): o is EnvOption => o !== null);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[wizard:getEnvs] ${msg.slice(0, 200)}`);
    return [];
  }
}

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

  ipcMain.handle('wizard:getBundles', async (_, platform: 'ios' | 'android') => {
    if (!state.projectRoot) return { bundles: [] };
    if (platform !== 'ios' && platform !== 'android') return { bundles: [] };
    try {
      return await discoverBundles({ projectRoot: state.projectRoot, platform });
    } catch (err: any) {
      console.error('[ipc] wizard:getBundles error:', err?.message);
      return { bundles: [] };
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

  // Project-declared app environments. When a project ships an
  // `rn-dev.config.{mjs,mts,ts,js}` that exports `enumerateEnvs`, the
  // wizard's Environment step shows a picker whose selection lands in
  // `profile.env.APP_ENV`. A `build/pre` hook in the project reads that
  // key and swaps `.env` / rebuilds Firebase configs / whatever the
  // project needs. Missing config, missing callback, callback that
  // throws, callback that times out → all resolve to `[]` so the
  // wizard transparently skips the step (design goal: rn-dev stays
  // project-agnostic; nothing acme-specific in the tool itself).
  ipcMain.handle(
    'wizard:getEnvs',
    async (): Promise<EnvOption[]> =>
      resolveEnvsForProject(state.projectRoot ?? null),
  );

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
