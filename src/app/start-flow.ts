import path from "path";
import React from "react";
import { createCliRenderer, VignetteEffect, applyScanlines } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { detectProjectRoot, getCurrentBranch } from "../core/project.js";
import { ProfileStore } from "../core/profile.js";
import { ArtifactStore } from "../core/artifact.js";
import { MetroManager } from "../core/metro.js";
import { DevToolsManager } from "../core/devtools.js";
import { FileWatcher } from "../core/watcher.js";
import { IpcServer } from "../core/ipc.js";
import type { ModuleHostManager } from "../core/module-host/manager.js";
import { bootSessionServices } from "../core/session/boot.js";
import { readHostVersion } from "../core/host-version.js";
import { loadTheme, getThemeEffects } from "../ui/theme-provider.js";
import {
  ModuleRegistry,
  devSpaceModule,
  settingsModule,
  lintTestModule,
} from "../modules/index.js";
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

  // IPC server — owned by the TUI caller so the `.rn-dev/sock` path is
  // derived from the TUI's project root, not the daemon's worktree.
  const ipc = new IpcServer(path.join(projectRoot, ".rn-dev", "sock"));
  await ipc.start();

  const hostVersion = readHostVersion();
  const services = await bootSessionServices({
    profile,
    projectRoot,
    artifactStore,
    moduleRegistry,
    emit,
    hostVersion,
    ipc,
  });

  // TUI-specific fan-out into the React-propagation service bus. The
  // daemon path does not use serviceBus; it emits events over
  // events/subscribe instead.
  serviceBus.setMetro(services.metro);
  serviceBus.setWorktreeKey(services.worktreeKey);
  if (services.watcher) serviceBus.setWatcher(services.watcher);
  serviceBus.setDevTools(services.devtools);
  serviceBus.setBuilder(services.builder);
  serviceBus.setHostVersion(hostVersion);
  serviceBus.setModuleHost(services.moduleHost);
  serviceBus.setModuleRegistry(services.moduleRegistry);
  serviceBus.setModuleEventsBus(services.moduleEvents);

  return {
    metro: services.metro,
    devtools: services.devtools,
    watcher: services.watcher,
    ipc,
    worktreeKey: services.worktreeKey,
    builder: services.builder,
    moduleHost: services.moduleHost,
    moduleRegistry: services.moduleRegistry,
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
