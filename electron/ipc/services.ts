import { ipcMain } from 'electron';
import path, { join } from 'path';
import { existsSync } from 'fs';
import { MetroManager } from '../../src/core/metro.js';
import { ArtifactStore } from '../../src/core/artifact.js';
import { ProfileStore } from '../../src/core/profile.js';
import { Builder } from '../../src/core/builder.js';
import { getCurrentBranch } from '../../src/core/project.js';
import { listDevices, bootDevice } from '../../src/core/device.js';
import { createDefaultPreflightEngine } from '../../src/core/preflight.js';
import { execShellAsync } from '../../src/core/exec-async.js';
import { CleanManager, detectAllPackageManagers, detectPackageManager } from '../../src/core/clean.js';
import type { Profile } from '../../src/core/types.js';
import { instances, state, send, appendLog, toSummary, findFreePort, type InstanceState } from './state.js';

// ── Start services for a single instance ──

export async function startInstanceServices(instance: InstanceState, profileData: any) {
  const { projectRoot, artifactStore } = state;
  if (!projectRoot || !artifactStore) return;

  const emit = (text: string) => {
    appendLog(instance, 'service', text);
    send('instance:log', { instanceId: instance.id, text });
  };

  const rnDevDir = path.join(projectRoot, '.rn-dev');
  const profileStore = new ProfileStore(path.join(rnDevDir, 'profiles'));

  // Build a profile object
  const profile: Profile = {
    name: profileData.name ?? instance.id,
    isDefault: profileData.isDefault ?? true,
    worktree: instance.worktree,
    branch: instance.branch,
    platform: instance.platform,
    mode: instance.mode,
    metroPort: instance.port,
    devices: profileData.devices ?? {},
    buildVariant: profileData.buildVariant ?? 'debug',
    preflight: profileData.preflight ?? { checks: [], frequency: 'once' },
    onSave: profileData.onSave ?? [],
    env: profileData.env ?? {},
    projectRoot,
  };

  const worktreeKey = artifactStore.worktreeHash(instance.worktree);

  // Run preflights
  if (profile.preflight.checks.length > 0) {
    send('instance:section:start', { instanceId: instance.id, id: 'preflight', title: 'Preflight Checks', icon: '\u23F3' });
    emit('Running preflight checks...');
    const engine = createDefaultPreflightEngine(projectRoot);
    const results = await engine.runAll(profile.platform, profile.preflight);

    let hasErrors = false;
    for (const [id, result] of results) {
      const icon = result.passed ? '  OK' : '  FAIL';
      emit(`${icon} ${id}: ${result.message}`);
      if (!result.passed) hasErrors = true;
    }

    if (hasErrors) {
      emit('  Some preflight checks failed. Continuing anyway...');
      send('instance:section:end', { instanceId: instance.id, id: 'preflight', status: 'warning' });
    } else {
      emit('  All preflight checks passed');
      send('instance:section:end', { instanceId: instance.id, id: 'preflight', status: 'ok' });
    }
    emit('');
  }

  // Run clean if not dirty mode
  if (instance.mode !== 'dirty') {
    send('instance:section:start', { instanceId: instance.id, id: 'clean', title: `${instance.mode} Clean`, icon: '\u23F3' });
    emit(`Running ${instance.mode} clean...`);
    // Use the worktree path if available, otherwise the main project root
    const effectiveRoot = instance.worktree ?? projectRoot;

    // Check for ambiguous package managers — ask user if needed
    let pm = profileData.packageManager;
    if (!pm) {
      const detected = detectAllPackageManagers(effectiveRoot);
      if (detected.filter(d => d.detected).length > 1) {
        // Multiple lockfiles found — ask the user
        emit(`⚠ Multiple package managers detected:`);
        for (const d of detected) {
          if (d.detected) emit(`    • ${d.name} (${d.reason})`);
        }

        // Send a prompt to the renderer and wait for response
        const response = await new Promise<string>((resolve) => {
          const promptId = `pm-${instance.id}-${Date.now()}`;
          send('instance:prompt', {
            instanceId: instance.id,
            promptId,
            title: 'Package Manager Conflict',
            message: 'Multiple package managers detected. Which one should be used?',
            options: detected.filter(d => d.detected).map(d => ({
              value: d.name,
              label: `${d.name} (${d.reason})`,
              cleanup: d.name === 'npm' ? 'Delete yarn.lock' :
                       d.name === 'yarn' ? 'Delete package-lock.json' :
                       d.name === 'pnpm' ? 'Delete package-lock.json & yarn.lock' : undefined,
            })),
          });

          // Listen for the response
          const handler = (_: any, data: { promptId: string; value: string }) => {
            if (data.promptId === promptId) {
              ipcMain.removeHandler(`prompt:respond:${promptId}`);
              resolve(data.value);
            }
          };
          ipcMain.handle(`prompt:respond:${promptId}`, async (_, data) => {
            resolve(data.value);
            return { ok: true };
          });

          // Timeout after 60 seconds — default to auto-detected
          setTimeout(() => {
            const autoDetected = detectPackageManager(effectiveRoot);
            emit(`  ⏳ No response — using auto-detected: ${autoDetected}`);
            resolve(autoDetected);
          }, 60000);
        });

        pm = response as "npm" | "yarn" | "pnpm";
        emit(`  ✔ Using ${pm}`);

        // Clean up the ambiguous lockfile
        const fs = require('fs');
        if (pm === 'npm' && existsSync(join(effectiveRoot, 'yarn.lock'))) {
          fs.unlinkSync(join(effectiveRoot, 'yarn.lock'));
          emit(`  🗑 Deleted yarn.lock`);
        } else if (pm === 'yarn' && existsSync(join(effectiveRoot, 'package-lock.json'))) {
          fs.unlinkSync(join(effectiveRoot, 'package-lock.json'));
          emit(`  🗑 Deleted package-lock.json`);
        } else if (pm === 'pnpm') {
          if (existsSync(join(effectiveRoot, 'yarn.lock'))) {
            fs.unlinkSync(join(effectiveRoot, 'yarn.lock'));
            emit(`  🗑 Deleted yarn.lock`);
          }
          if (existsSync(join(effectiveRoot, 'package-lock.json'))) {
            fs.unlinkSync(join(effectiveRoot, 'package-lock.json'));
            emit(`  🗑 Deleted package-lock.json`);
          }
        }

        // Save the choice to the profile
        profileData.packageManager = pm;
        const profileStore = new ProfileStore(join(projectRoot!, '.rn-dev', 'profiles'));
        if (profileData.name) {
          const existing = profileStore.load(profileData.name);
          if (existing) {
            existing.packageManager = pm;
            profileStore.save(existing);
          }
        }
      }
    }

    const cleaner = new CleanManager(effectiveRoot, pm);
    const results = await cleaner.execute(instance.mode as any, instance.platform, (step, status) => {
      const icon = status === 'running' ? '\u23F3' : '\u2714';
      emit(`  ${icon} ${step}`);
    });

    const failed = results.filter(r => !r.success);
    if (failed.length > 0) {
      emit(`  ⚠ ${failed.length} clean step(s) had issues:`);
      for (const f of failed) {
        emit(`    ✖ ${f.step}:`);
        // Filter noise from error output: curl progress, blank lines, percentage bars
        const errorLines = f.output.split('\n')
          .map((l: string) => l.trim())
          .filter((l: string) => {
            if (!l) return false;
            // Skip curl download progress
            if (l.startsWith('% Total') || l.startsWith('Dload') || /^\d+\s+[\d.]+[MKG]/.test(l)) return false;
            if (/^\d+\s+\d+\s+\d+\s+\d+/.test(l)) return false;
            if (l.includes('--:--:--')) return false;
            // Skip the command itself
            if (l.startsWith('Command failed')) return false;
            return true;
          });

        if (errorLines.length === 0) {
          emit(`      (no error details captured — check /tmp/rn-dev-logs/ for full output)`);
        } else {
          for (const line of errorLines.slice(-15)) { // Show LAST 15 lines (error is usually at the end)
            emit(`      ${line.slice(0, 200)}`);
          }
          if (errorLines.length > 15) {
            emit(`      ... (${errorLines.length - 15} earlier lines omitted)`);
          }
        }
      }
      // Check if critical steps failed (install-dependencies, pod-install)
      const criticalFailed = failed.filter(f =>
        f.step === 'install-dependencies' ||
        f.step === 'pod-install'
      );
      if (criticalFailed.length > 0) {
        emit('');
        emit('Critical clean steps failed. Cannot start Metro or build.');
        emit('  Fix the issues above and try again.');
        instance.metroStatus = 'error';
        send('instance:status', { instanceId: instance.id, ...toSummary(instance) });
        send('instance:section:end', { instanceId: instance.id, id: 'clean', status: 'error' });
        return; // Abort
      }
      send('instance:section:end', { instanceId: instance.id, id: 'clean', status: 'warning' });
    } else {
      emit(`${instance.mode} clean complete`);
      send('instance:section:end', { instanceId: instance.id, id: 'clean', status: 'ok' });
    }
    emit('');
  }

  // Clear watchman
  send('instance:section:start', { instanceId: instance.id, id: 'watchman', title: 'Watchman Clear', icon: '\u23F3' });
  emit('Clearing watchman...');
  try {
    await execShellAsync(`watchman watch-del '${projectRoot}'`, { timeout: 10000 }).catch(() => {});
    if (instance.worktree && instance.worktree !== projectRoot) {
      await execShellAsync(`watchman watch-del '${instance.worktree}'`, { timeout: 10000 }).catch(() => {});
    }
    await execShellAsync('watchman watch-del-all', { timeout: 10000 }).catch(() => {});
    emit('Watchman cleared');
    send('instance:section:end', { instanceId: instance.id, id: 'watchman', status: 'ok' });
  } catch {
    emit('Watchman not available or timed out');
    send('instance:section:end', { instanceId: instance.id, id: 'watchman', status: 'warning' });
  }

  // Check port & start Metro
  send('instance:section:start', { instanceId: instance.id, id: 'metro', title: 'Metro Start', icon: '\u23F3' });
  emit(`Checking port ${instance.port}...`);
  const metroMgr = new MetroManager(artifactStore);
  const portFree = await metroMgr.isPortFree(instance.port);
  if (!portFree) {
    emit(`Port ${instance.port} in use. Killing stale process...`);
    await metroMgr.killProcessOnPort(instance.port);
    await new Promise(r => setTimeout(r, 1000));
    emit(`  Killed process on port ${instance.port}`);
  } else {
    emit(`Port ${instance.port} is free`);
  }

  // Boot simulator if needed
  if (instance.platform === 'ios' || instance.platform === 'both') {
    emit('Checking simulator...');
    try {
      const devices = await listDevices('ios');
      if (devices.length > 0) {
        const deviceId = profile.devices?.ios;
        const device = deviceId
          ? devices.find(d => d.id === deviceId)
          : devices.find(d => d.status === 'booted') ?? devices[0];
        if (device) {
          if (device.status === 'shutdown') {
            emit(`Booting simulator ${device.name}...`);
            await bootDevice(device);
            emit('  Simulator booted');
          } else {
            emit(`  Simulator ${device.name} already booted`);
          }
          instance.deviceId = device.id;
          instance.deviceName = device.name;
          instance.deviceIcon = device.isPhysical ? '\uD83D\uDCF1' : '\uD83D\uDCBB';
          send('instance:status', { instanceId: instance.id, ...toSummary(instance) });
        }
      }
    } catch (err: any) {
      emit(`  Simulator check failed: ${err.message?.slice(0, 80)}`);
    }
  }

  emit(`Starting Metro on port ${instance.port}...`);
  instance.metroStatus = 'starting';
  send('instance:status', { instanceId: instance.id, ...toSummary(instance) });

  metroMgr.start({
    worktreeKey,
    projectRoot: instance.worktree ?? projectRoot,
    port: instance.port,
    resetCache: instance.mode !== 'dirty',
    env: profile.env,
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
      send('instance:section:end', { instanceId: instance.id, id: 'metro', status: 'ok' });
    }
  });

  emit('All services started');
  emit('');

  // Check code signing before building (for iOS with physical devices)
  if (instance.platform === 'ios' || instance.platform === 'both') {
    const effectiveRootForSigning = instance.worktree ?? projectRoot;
    const iosDir = join(effectiveRootForSigning, 'ios');
    try {
      const entries = require('fs').readdirSync(iosDir);
      for (const entry of entries) {
        if (entry.endsWith('.xcodeproj')) {
          const pbxproj = join(iosDir, entry, 'project.pbxproj');
          if (existsSync(pbxproj)) {
            const content = require('fs').readFileSync(pbxproj, 'utf8');
            const manualMatches = content.match(/CODE_SIGN_STYLE\s*=\s*Manual/g);
            if (manualMatches && manualMatches.length > 0) {
              emit(`⚠ Manual code signing detected (${manualMatches.length} targets)`);

              // Prompt user
              const signingResponse = await new Promise<string>((resolve) => {
                const promptId = `signing-${instance.id}-${Date.now()}`;
                send('instance:prompt', {
                  instanceId: instance.id,
                  promptId,
                  title: 'Code Signing Conflict',
                  message: `This project uses Manual code signing (set by CI/Fastlane). Local builds will fail without the CI certificates.\n\nSwitch to Automatic signing? This won't break CI — Fastlane overrides it at build time.`,
                  options: [
                    { value: 'fix', label: '✔ Switch to Automatic signing', cleanup: 'Safe — CI overrides this' },
                    { value: 'skip', label: 'Skip — I have the certificates' },
                  ],
                });
                ipcMain.handle(`prompt:respond:${promptId}`, async (_, data) => {
                  resolve(data.value);
                  return { ok: true };
                });
                setTimeout(() => resolve('skip'), 60000);
              });

              if (signingResponse === 'fix') {
                let fixed = content
                  // Switch to automatic signing
                  .replace(/CODE_SIGN_STYLE\s*=\s*Manual/g, 'CODE_SIGN_STYLE = Automatic')
                  // Reset CODE_SIGN_IDENTITY to generic "Apple Development" (not a specific cert)
                  .replace(/CODE_SIGN_IDENTITY\s*=\s*"[^"]*"/g, 'CODE_SIGN_IDENTITY = "Apple Development"')
                  .replace(/CODE_SIGN_IDENTITY\s*=\s*[^;]+;/g, 'CODE_SIGN_IDENTITY = "Apple Development";')
                  // Remove PROVISIONING_PROFILE_SPECIFIER (let Xcode auto-manage)
                  .replace(/PROVISIONING_PROFILE_SPECIFIER\s*=\s*"[^"]*"/g, 'PROVISIONING_PROFILE_SPECIFIER = ""')
                  .replace(/PROVISIONING_PROFILE_SPECIFIER\s*=\s*[^;]+;/g, 'PROVISIONING_PROFILE_SPECIFIER = "";')
                  // Remove specific DEVELOPMENT_TEAM if it's a Match/CI team
                  // (keep it if present — Automatic signing needs a team)
                ;
                require('fs').writeFileSync(pbxproj, fixed);
                emit(`  ✔ Switched to Automatic signing`);
                emit(`  ✔ Reset CODE_SIGN_IDENTITY to "Apple Development"`);
                emit(`  ✔ Cleared PROVISIONING_PROFILE_SPECIFIER`);
              } else {
                emit(`  ℹ Keeping Manual signing`);
              }
            }
          }
          break;
        }
      }
    } catch (err: any) {
      emit(`  ⚠ Could not check code signing: ${err.message?.slice(0, 80)}`);
    }
  }

  // Trigger build
  setTimeout(() => {
    const b = new Builder();
    instance.builder = b;

    send('instance:section:start', { instanceId: instance.id, id: 'build', title: `Build for ${instance.platform}`, icon: '\u23F3' });

    b.on('line', ({ text }: { text: string }) => {
      appendLog(instance, 'service', text);
      send('instance:build:line', { instanceId: instance.id, text });
    });

    b.on('progress', ({ phase }: { phase: string }) => {
      send('instance:build:progress', { instanceId: instance.id, phase });
    });

    b.on('done', ({ success, errors, platform }: any) => {
      send('instance:build:done', { instanceId: instance.id, success, errors, platform });
      if (success) {
        emit('Build complete!');
        send('instance:section:end', { instanceId: instance.id, id: 'build', status: 'ok' });
      } else {
        emit('Build failed');
        for (const err of errors ?? []) {
          emit(`  ${err.summary}`);
          if (err.suggestion) emit(`    Fix: ${err.suggestion}`);
        }
        send('instance:section:end', { instanceId: instance.id, id: 'build', status: 'error' });
      }
    });

    const platformsToBuild: Array<'ios' | 'android'> =
      profile.platform === 'both' ? ['ios', 'android'] : [profile.platform];

    for (const plat of platformsToBuild) {
      const devId = plat === 'ios' ? profile.devices?.ios : profile.devices?.android;
      b.build({
        projectRoot: instance.worktree ?? projectRoot!,
        platform: plat,
        deviceId: devId ?? undefined,
        port: instance.port,
        variant: profile.buildVariant,
        env: profile.env,
      });
    }
  }, 500);
}

/**
 * Start real core services for a project.
 * Called from main.ts after the window is ready.
 * Creates the first instance automatically from the default profile (or triggers wizard).
 */
export async function startRealServices(targetProjectRoot: string) {
  state.projectRoot = targetProjectRoot;

  const rnDevDir = path.join(targetProjectRoot, '.rn-dev');
  state.artifactStore = new ArtifactStore(path.join(rnDevDir, 'artifacts'));
  const profileStore = new ProfileStore(path.join(rnDevDir, 'profiles'));

  // Load the default profile
  const branch = await getCurrentBranch(targetProjectRoot) ?? 'main';
  const defaultProfile = profileStore.findDefault(null, branch);

  if (!defaultProfile) {
    // No profile — renderer will show the wizard / new-instance dialog
    return;
  }

  // Create the first instance from the default profile via its name
  // Reuse the same logic as instances:create by importing directly
  const worktreePath = defaultProfile.worktree ?? null;
  const worktreeName = worktreePath ? path.basename(worktreePath) : 'main';
  const port = findFreePort();
  const id = `${worktreeName}-${port}`;

  let deviceName = 'No device';
  let deviceIcon = '💻';
  let deviceId: string | null = null;

  if (defaultProfile.devices) {
    deviceId = defaultProfile.devices.ios ?? defaultProfile.devices.android ?? null;
    if (deviceId) {
      try {
        const deviceList = await listDevices(defaultProfile.platform);
        const foundDevice = deviceList.find(d => d.id === deviceId);
        if (foundDevice) {
          deviceName = foundDevice.name;
          deviceIcon = foundDevice.isPhysical ? '📱' : '💻';
        }
      } catch { /* keep defaults */ }
    }
  }

  const instance: InstanceState = {
    id,
    worktree: worktreePath,
    worktreeName,
    branch: defaultProfile.branch,
    port,
    deviceId,
    deviceName,
    deviceIcon,
    platform: defaultProfile.platform,
    mode: defaultProfile.mode,
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

  send('instance:created', toSummary(instance));

  // Start services
  await startInstanceServices(instance, {
    ...defaultProfile,
    devices: defaultProfile.devices,
  });
}
