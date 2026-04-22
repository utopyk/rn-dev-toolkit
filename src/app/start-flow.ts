import path from "path";
import React from "react";
import { createCliRenderer, VignetteEffect, applyScanlines } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { execShellAsync } from "../core/exec-async.js";
import { detectProjectRoot, getCurrentBranch } from "../core/project.js";
import { ProfileStore } from "../core/profile.js";
import { ArtifactStore } from "../core/artifact.js";
import { MetroManager } from "../core/metro.js";
import { DevToolsManager } from "../core/devtools.js";
import { CleanManager } from "../core/clean.js";
import { FileWatcher } from "../core/watcher.js";
import { IpcServer } from "../core/ipc.js";
import type { ModuleHostManager } from "../core/module-host/manager.js";
import { CapabilityRegistry } from "../core/module-host/capabilities.js";
import { registerModulesIpc } from "./modules-ipc.js";
import { loadTheme, getThemeEffects } from "../ui/theme-provider.js";
import { registerDevtoolsIpc } from "./devtools-ipc.js";
import {
  ModuleRegistry,
  devSpaceModule,
  settingsModule,
  lintTestModule,
  metroLogsModule,
  devtoolsNetworkModule,
} from "../modules/index.js";
import {
  createModuleSystem,
  type LogCapability,
} from "../modules/create-module-system.js";
import { firstRunSetup } from "./first-run.js";
import { App } from "./App.js";
import { serviceBus } from "./service-bus.js";
import type { Profile, Platform, RunMode } from "../core/types.js";

// ---------------------------------------------------------------------------
// StartOptions
// ---------------------------------------------------------------------------

export interface StartOptions {
  interactive?: boolean;
  profile?: string;
  worktree?: string;
  platform?: string;
  mode?: string;
  port?: number;
  theme?: string;
}

// ---------------------------------------------------------------------------
// startFlow — the main orchestrator for `rn-dev start`
// ---------------------------------------------------------------------------

export async function startFlow(options: StartOptions): Promise<void> {
  // 1. Detect project root
  const projectRoot = detectProjectRoot(process.cwd());
  if (!projectRoot) {
    console.error("Not inside a React Native project");
    process.exit(1);
  }

  // 2. First-run check
  await firstRunSetup(projectRoot);

  // 3. Initialize stores
  const profileStore = new ProfileStore(
    path.join(projectRoot, ".rn-dev", "profiles")
  );
  const artifactStore = new ArtifactStore(
    path.join(projectRoot, ".rn-dev", "artifacts")
  );

  // 4. Load theme
  const themeName = options.theme ?? "midnight";
  const theme = loadTheme(themeName);
  const effects = getThemeEffects(themeName);

  // 5. Register legacy Ink-style modules onto a registry the TUI renders from.
  //    Manifest-shape built-ins + Marketplace + user-global 3p modules are
  //    layered on later inside `startServicesAsync` via `createModuleSystem`,
  //    once the capability registry + host version are resolved.
  const registry = new ModuleRegistry();
  registry.register(devSpaceModule);
  registry.register(lintTestModule);
  registry.register(metroLogsModule);
  registry.register(devtoolsNetworkModule);
  registry.register(settingsModule);

  // 6. Determine if we need the wizard
  let profile: Profile | undefined;
  let needsWizard = false;

  if (options.interactive) {
    needsWizard = true;
  } else if (options.profile) {
    const loaded = profileStore.load(options.profile);
    if (!loaded) {
      console.error(`Profile "${options.profile}" not found`);
      process.exit(1);
    }
    profile = loaded;
  } else {
    // Try to find default profile for current worktree+branch
    const branch = (await getCurrentBranch(projectRoot)) ?? "main";
    const worktree: string | null = null;
    const defaultProfile = profileStore.findDefault(worktree, branch);
    if (defaultProfile) {
      profile = defaultProfile;
    } else {
      // No profile found — need wizard
      needsWizard = true;
    }
  }

  // Apply CLI overrides if we already have a profile
  if (profile) {
    if (options.platform) profile.platform = options.platform as Platform;
    if (options.mode) profile.mode = options.mode as RunMode;
    if (options.port) profile.metroPort = options.port;
  }

  // 7. Declare service references (populated after initial render)
  let metro: MetroManager | undefined;
  let devtools: DevToolsManager | undefined;
  let watcher: FileWatcher | null = null;
  let ipc: IpcServer | undefined;
  let worktreeKey: string | undefined;
  let startupLog: string[] = [];
  let builder: import("../core/builder.js").Builder | undefined;

  // 8. Create OpenTUI renderer FIRST so TUI appears immediately
  const vignetteEffect = new VignetteEffect(effects.vignetteStrength);

  const renderer = await createCliRenderer({
    backgroundColor: theme.colors.bg,
    useMouse: true,
    exitOnCtrlC: true,
    targetFps: 60,
    postProcessFns: [
      (buffer: any) => vignetteEffect.apply(buffer),
      (buffer: any) => applyScanlines(buffer, effects.scanlineOpacity, effects.scanlineSpacing),
    ],
  });

  const root = createRoot(renderer);

  // Helper to render the app with given props
  function renderApp(appProps: Record<string, unknown>): void {
    root.render(React.createElement(App, appProps));
  }

  // 9. Render single OpenTUI instance — either wizard or TUI
  renderApp({
    theme,
    registry,
    wizardMode: needsWizard,
    projectRoot,
    profile,
    metro,
    watcher,
    worktreeKey,
    startupLog,
    builder,
    onWizardComplete: async (wizardProfile: Profile) => {
      // Save the profile
      const fullProfile: Profile = {
        name: wizardProfile.name ?? `profile-${Date.now()}`,
        isDefault: wizardProfile.isDefault ?? true,
        worktree: wizardProfile.worktree ?? null,
        branch:
          wizardProfile.branch ??
          ((await getCurrentBranch(projectRoot)) ?? "main"),
        platform: wizardProfile.platform ?? "both",
        mode: wizardProfile.mode ?? "clean",
        metroPort: wizardProfile.metroPort ?? 8081,
        devices: wizardProfile.devices ?? {},
        buildVariant: wizardProfile.buildVariant ?? "debug",
        preflight: wizardProfile.preflight ?? {
          checks: [],
          frequency: "once",
        },
        onSave: wizardProfile.onSave ?? [],
        env: wizardProfile.env ?? {},
        projectRoot,
      };

      // Apply CLI overrides
      if (options.platform)
        fullProfile.platform = options.platform as Platform;
      if (options.mode) fullProfile.mode = options.mode as RunMode;
      if (options.port) fullProfile.metroPort = options.port;

      profileStore.save(fullProfile);

      // Start services with the new profile
      const result = await startServices(
        fullProfile,
        projectRoot,
        artifactStore,
        registry,
      );

      // Re-render with profile and services
      renderApp({
        theme,
        registry,
        wizardMode: false,
        profile: fullProfile,
        metro: result.metro,
        watcher: result.watcher,
        worktreeKey: result.worktreeKey,
        startupLog: result.startupLog,
        builder: result.builder,
      });

      // Trigger build after re-render (quick mode skips this — the already-
      // installed app connects to Metro directly).
      if (fullProfile.mode !== "quick") {
        const platformsToBuild: Array<"ios" | "android"> =
          fullProfile.platform === "both" ? ["ios", "android"] : [fullProfile.platform];

        for (const plat of platformsToBuild) {
          const devId = plat === "ios" ? fullProfile.devices?.ios : fullProfile.devices?.android;
          result.builder.build({
            projectRoot: fullProfile.worktree ?? projectRoot,
            platform: plat,
            deviceId: devId ?? undefined,
            port: fullProfile.metroPort,
            variant: fullProfile.buildVariant,
            env: fullProfile.env,
          });
        }
      }
    },
    onWizardCancel: () => {
      process.exit(0);
    },
  });

  // 10. Start services async on the main thread (all shell calls use Bun.spawn, never blocks)
  if (profile && !needsWizard) {
    startServicesAsync(profile, projectRoot, artifactStore, registry).then((result) => {
      metro = result.metro;
      devtools = result.devtools;
      watcher = result.watcher;
      ipc = result.ipc;
      worktreeKey = result.worktreeKey;
      builder = result.builder;

      // Trigger build after a short delay so React's useEffect has time
      // to subscribe to builder events before they start firing. Quick
      // mode skips this entirely — the existing installed app connects
      // to Metro directly.
      if (profile.mode !== "quick") {
        setTimeout(() => {
          const platformsToBuild: Array<"ios" | "android"> =
            profile.platform === "both" ? ["ios", "android"] : [profile.platform];

          for (const plat of platformsToBuild) {
            const devId = plat === "ios" ? profile.devices?.ios : profile.devices?.android;
            result.builder.build({
              projectRoot: profile.worktree ?? projectRoot,
              platform: plat,
              deviceId: devId ?? undefined,
              port: profile.metroPort,
              variant: profile.buildVariant,
              env: profile.env,
            });
          }
        }, 200);
      }
    }).catch((err) => {
      serviceBus.log(`\u2716 Service startup error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // 11. Handle cleanup on exit — must destroy renderer to restore terminal
  const cleanup = (): void => {
    // Dispose devtools BEFORE metro so its metro.on('status') listener is
    // released cleanly (see DevToolsManager.dispose).
    devtools?.dispose().catch(() => { /* best-effort on shutdown */ });
    metro?.stopAll();
    watcher?.stop();
    ipc?.stop();
    try {
      root.unmount();
      renderer.destroy();
    } catch {
      // renderer may already be destroyed
    }
    // Explicitly disable mouse reporting and restore terminal
    process.stdout.write("\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l");
    process.stdout.write("\x1b[?25h");  // show cursor
    process.stdout.write("\x1b[?1049l"); // exit alternate screen
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  // Also handle the 'q' key quit from AppContext
  process.on("exit", () => {
    cleanup();
  });
}

// ---------------------------------------------------------------------------
// Helper: start all services async (runs on main thread, never blocks)
// ---------------------------------------------------------------------------

async function startServicesAsync(
  profile: Profile,
  projectRoot: string,
  artifactStore: ArtifactStore,
  moduleRegistry: ModuleRegistry,
): Promise<{
  metro: MetroManager;
  devtools: DevToolsManager;
  watcher: FileWatcher | null;
  ipc: IpcServer;
  worktreeKey: string;
  builder: import("../core/builder.js").Builder;
  moduleHost: ModuleHostManager;
  moduleRegistry: ModuleRegistry;
}> {
  const emit = (line: string) => serviceBus.log(line);

  // 1. Run preflights if configured
  if (profile.preflight.checks.length > 0) {
    const artifact = artifactStore.load(
      artifactStore.worktreeHash(profile.worktree)
    );
    const needsPreflight =
      profile.preflight.frequency === "always" || !artifact?.preflightPassed;

    if (needsPreflight) {
      emit("\u23f3 Running preflight checks...");
      const { createDefaultPreflightEngine } = await import(
        "../core/preflight.js"
      );
      const engine = createDefaultPreflightEngine(projectRoot);
      const results = await engine.runAll(profile.platform, profile.preflight);

      let hasErrors = false;
      for (const [id, result] of results) {
        const icon = result.passed ? "\u2714" : "\u2716";
        emit(`  ${icon} ${id}: ${result.message}`);
        if (!result.passed) hasErrors = true;
      }

      if (hasErrors) {
        emit(`  \u26a0 Some preflight checks failed. Continuing anyway...`);
      } else {
        emit(`  \u2714 All preflight checks passed`);
      }
      emit("");

      const wKey = artifactStore.worktreeHash(profile.worktree);
      artifactStore.save(wKey, { preflightPassed: !hasErrors });
    }
  }

  // 2. Check node_modules — auto-install if missing
  const effectiveRoot = profile.worktree ?? projectRoot;
  const { existsSync: exists } = await import("fs");
  if (!exists(path.join(effectiveRoot, "node_modules"))) {
    emit("\u26a0 node_modules not found \u2014 auto-installing dependencies...");

    const hasPackageLock = exists(path.join(effectiveRoot, "package-lock.json"));
    const hasBunLock = exists(path.join(effectiveRoot, "bun.lock")) || exists(path.join(effectiveRoot, "bun.lockb"));
    const hasYarnLock = exists(path.join(effectiveRoot, "yarn.lock"));
    const installCmd = hasPackageLock ? "npm install" : hasBunLock ? "bun install" : hasYarnLock ? "yarn install" : "npm install";

    emit(`  \u23f3 ${installCmd}...`);
    try {
      await execShellAsync(installCmd, { cwd: effectiveRoot, timeout: 300000 });
      emit("  \u2714 Dependencies installed");
    } catch (err: any) {
      emit(`  \u2716 Install failed: ${(err.message ?? "").slice(0, 120)}`);
      emit("  \u26a0 Build will likely fail without node_modules");
    }
    emit("");

    // Install pods if iOS and Podfile exists
    if (profile.platform === "ios" || profile.platform === "both") {
      const podfilePath = path.join(effectiveRoot, "ios", "Podfile");
      if (exists(podfilePath)) {
        emit("  \u23f3 pod install...");
        try {
          await execShellAsync("pod install", {
            cwd: path.join(effectiveRoot, "ios"),
            timeout: 300000,
          });
          emit("  \u2714 Pods installed");
        } catch {
          emit("  \u26a0 pod install failed");
        }
        emit("");
      }
    }
  }

  // 3. Run clean if needed — skipped for dirty + quick modes.
  if (profile.mode !== "dirty" && profile.mode !== "quick") {
    const cleaner = new CleanManager(projectRoot);
    emit(`\u23f3 Running ${profile.mode} clean...`);
    await cleaner.execute(profile.mode, profile.platform, (step, status) => {
      const icon = status === "done" ? "\u2714" : status === "skip" ? "\u2139" : "\u26a0";
      emit(`  ${icon} ${step}`);
    });
    emit("");
  }

  // 4. Clear watchman for this project to prevent recrawl warnings
  emit("\u23f3 Clearing watchman...");
  try {
    await execShellAsync(`watchman watch-del '${effectiveRoot}'`, {
      timeout: 15000,
    });
    emit("\u2714 Watchman watch cleared for project");
  } catch {
    emit("\u2139 Watchman not available or timed out");
  }

  // 5. Check port and kill stale process if needed
  const metro = new MetroManager(artifactStore);
  const worktreeKey = artifactStore.worktreeHash(profile.worktree);
  const port = profile.metroPort;

  emit(`\u23f3 Checking port ${port}...`);
  const portFree = await metro.isPortFree(port);
  if (!portFree) {
    emit(`\u26a0 Port ${port} is in use. Killing stale process...`);
    const killed = await metro.killProcessOnPort(port);
    if (killed) {
      emit(`  \u2714 Killed process on port ${port}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } else {
      emit(`  \u2716 Could not kill process on port ${port}. Trying anyway...`);
    }
  } else {
    emit(`\u2714 Port ${port} is free`);
  }

  // 6. Boot simulator if needed
  if (profile.platform === "ios" || profile.platform === "both") {
    const deviceId = profile.devices?.ios;
    if (deviceId) {
      emit("\u23f3 Checking simulator status...");
      try {
        const { listDevices: listDev, bootDevice } = await import("../core/device.js");
        const devices = await listDev("ios");
        const device = devices.find((d) => d.id === deviceId);
        if (device && device.status === "shutdown") {
          emit(`\u23f3 Booting simulator ${device.name}...`);
          const booted = await bootDevice(device);
          if (booted) {
            emit("  \u2714 Simulator booted");
          } else {
            emit("  \u26a0 Could not boot simulator \u2014 may already be booting");
          }
        } else if (device && device.status === "booted") {
          emit(`  \u2714 Simulator ${device.name} already booted`);
        } else {
          emit(`  \u26a0 Device ${deviceId} not found in simulator list`);
        }
      } catch (err: any) {
        emit(`  \u26a0 Simulator check failed: ${(err.message ?? "").slice(0, 80)}`);
      }
    }
  }

  // 7. Start Metro
  emit(`\u23f3 Starting Metro on port ${port}...`);
  metro.start({
    worktreeKey,
    projectRoot: effectiveRoot,
    port: profile.metroPort,
    resetCache: profile.mode !== "dirty" && profile.mode !== "quick",
    verbose: true,
    env: profile.env,
  });
  serviceBus.setMetro(metro);
  serviceBus.setWorktreeKey(worktreeKey);

  // 8. File watcher — create but DON'T start yet (chokidar's initial scan
  // blocks the event loop for minutes on large projects). User can toggle
  // with 'w' shortcut when ready.
  let watcher: FileWatcher | null = null;
  if (profile.onSave.length > 0) {
    watcher = new FileWatcher({
      projectRoot,
      actions: profile.onSave,
    });
    serviceBus.setWatcher(watcher);
    emit("ℹ File watcher ready — press [w] to enable");
  }

  // 9. Start IPC server
  const ipc = new IpcServer(path.join(projectRoot, ".rn-dev", "sock"));
  await ipc.start();

  // 10. DevTools — Phase 3 Track A. Eager-start so MCP tools over unix
  // socket see a live proxy from the moment the session is up. Starting
  // may land in `no-target` posture if Metro isn't ready yet; that's
  // fine — the manager polls /json again on first activity and the
  // status envelope tells the agent what's going on.
  const devtools = new DevToolsManager(metro, {});
  try {
    await devtools.start(worktreeKey);
  } catch (err) {
    emit(`ℹ DevTools: deferred (${err instanceof Error ? err.message : String(err)})`);
  }
  serviceBus.setDevTools(devtools);
  registerDevtoolsIpc(ipc, { manager: devtools, defaultWorktreeKey: worktreeKey });

  // 11. Create builder
  const { Builder } = await import("../core/builder.js");
  const builder = new Builder();
  serviceBus.setBuilder(builder);

  // 12. Module host — Phase 2 + Phase 3a, refactored via `createModuleSystem`
  // (Phase 6 Arch P1-1).
  //
  // The factory stamps `appInfo` / `log` on the capability registry, registers
  // every built-in manifest, and wires the Marketplace built-in's capability.
  // `metro` / `artifacts` are TUI-path specific — they register before the
  // factory so modules activated during built-in manifest registration can
  // resolve them.
  const hostVersion = readHostVersion();
  const capabilities = new CapabilityRegistry();
  capabilities.register("metro", metro, {
    requiredPermission: "exec:react-native",
  });
  capabilities.register("artifacts", artifactStore, {
    requiredPermission: "fs:artifacts",
  });
  const { moduleHost } = createModuleSystem({
    hostVersion,
    worktreeKey,
    capabilities,
    moduleRegistry,
    logger: createScopedLogger(emit),
  });
  serviceBus.setHostVersion(hostVersion);
  serviceBus.setModuleHost(moduleHost);
  serviceBus.setModuleRegistry(moduleRegistry);

  const loadResult = moduleRegistry.loadUserGlobalModules({
    hostVersion,
    scopeUnit: worktreeKey,
  });
  if (loadResult.modules.length > 0) {
    emit(
      `ℹ Loaded ${loadResult.modules.length} module manifest${loadResult.modules.length === 1 ? "" : "s"} (${loadResult.modules.map((m) => m.manifest.id).join(", ")})`,
    );
  }
  for (const rejected of loadResult.rejected) {
    emit(
      `⚠ Module manifest rejected (${rejected.code}): ${rejected.manifestPath} — ${rejected.message}`,
    );
  }

  const modulesIpc = registerModulesIpc(ipc, {
    manager: moduleHost,
    registry: moduleRegistry,
  });
  // Simplicity #6 (Phase 5c) — the bus itself is the single fan-out point.
  // MCP `modules/subscribe`, Electron renderer forward, and Electron
  // `modules:config-set` each attach to this emitter directly. No relay
  // through a second serviceBus topic.
  serviceBus.setModuleEventsBus(modulesIpc.moduleEvents);

  emit("\u2714 All services started");
  emit("");

  return {
    metro,
    devtools,
    watcher,
    ipc,
    worktreeKey,
    builder,
    moduleHost,
    moduleRegistry,
  };
}

// ---------------------------------------------------------------------------
// Module-host capability helpers (Phase 2 daemon wiring)
// ---------------------------------------------------------------------------

function readHostVersion(): string {
  // Single source of truth: root package.json. Phase 2 handoff flags this
  // — if the daemon is ever split off, re-wire this to a build-stamped
  // constant instead of a runtime read.
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const pkg = JSON.parse(
      require("fs").readFileSync(pkgPath, "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function createScopedLogger(emit: (line: string) => void): LogCapability {
  const format = (
    level: string,
    msg: string,
    data?: Record<string, unknown>,
  ): string => {
    const suffix = data ? ` ${JSON.stringify(data)}` : "";
    return `[module/${level}] ${msg}${suffix}`;
  };
  return {
    debug: (msg, data) => emit(format("debug", msg, data)),
    info: (msg, data) => emit(format("info", msg, data)),
    warn: (msg, data) => emit(format("warn", msg, data)),
    error: (msg, data) => emit(format("error", msg, data)),
  };
}

// ---------------------------------------------------------------------------
// Helper: start services (used by wizard onComplete flow)
// ---------------------------------------------------------------------------

async function startServices(
  profile: Profile,
  projectRoot: string,
  artifactStore: ArtifactStore,
  moduleRegistry: ModuleRegistry,
): Promise<{
  metro: MetroManager;
  devtools: DevToolsManager;
  watcher: FileWatcher | null;
  ipc: IpcServer;
  worktreeKey: string;
  startupLog: string[];
  builder: import("../core/builder.js").Builder;
  moduleHost: ModuleHostManager;
  moduleRegistry: ModuleRegistry;
}> {
  const result = await startServicesAsync(
    profile,
    projectRoot,
    artifactStore,
    moduleRegistry,
  );
  return { ...result, startupLog: [] };
}
