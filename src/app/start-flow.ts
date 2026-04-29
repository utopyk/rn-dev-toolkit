import path from "path";
import React from "react";
import { createCliRenderer, VignetteEffect, applyScanlines } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { detectProjectRoot, getCurrentBranch } from "../core/project.js";
import { ProfileStore } from "../core/profile.js";
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
import {
  connectToDaemonSession,
  type DaemonSession,
} from "./client/session.js";
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
//
// Phase 13.3 — the TUI is now a thin client of the per-worktree daemon.
// `connectToDaemonSession` auto-spawns the daemon if needed, runs
// session/start, and opens a single events/subscribe stream that feeds
// MetroClient / DevToolsClient / BuilderClient / WatcherClient adapters.
// Those adapters are what the React UI consumes via the serviceBus.
//
// The daemon holds Metro / DevTools / Builder / Watcher + module host.
// Quitting the TUI does NOT tear the session down (the merge-gate test
// in `src/app/__tests__/tui-client.test.ts` pins that).
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

  // 3. Initialize profile store. The artifact store + module registry
  //    now live in the daemon; the TUI only needs the profile store
  //    (and below, a TUI-local ModuleRegistry for rendering the
  //    Ink-style module tabs).
  const profileStore = new ProfileStore(
    path.join(projectRoot, ".rn-dev", "profiles")
  );

  // 4. Load theme
  const themeName = options.theme ?? "midnight";
  const theme = loadTheme(themeName);
  const effects = getThemeEffects(themeName);

  // 5. Register legacy Ink-style modules for TUI rendering. The daemon
  //    has its own manifest-shape module registry; this one is
  //    TUI-only and only carries the built-in Ink tabs. (Manifest-shape
  //    modules don't guarantee a TUI view per CLAUDE.md, so not
  //    mirroring the daemon's registry here is acceptable for 13.3.)
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
    const branch = (await getCurrentBranch(projectRoot)) ?? "main";
    const worktree: string | null = null;
    const defaultProfile = profileStore.findDefault(worktree, branch);
    if (defaultProfile) {
      profile = defaultProfile;
    } else {
      needsWizard = true;
    }
  }

  if (profile) applyCliOverrides(profile, options);

  // 7. Track the live DaemonSession so cleanup can stop it and avoid
  //    leaving the daemon pinned to a stopping → stopped edge.
  let session: DaemonSession | null = null;

  // 8. Create OpenTUI renderer FIRST so the TUI appears immediately.
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

  function renderApp(appProps: Record<string, unknown>): void {
    root.render(
      React.createElement(
        App,
        appProps as unknown as React.ComponentProps<typeof App>,
      ),
    );
  }

  // 9. Render the initial App — wizard or TUI scaffold.
  renderApp({
    theme,
    registry,
    wizardMode: needsWizard,
    projectRoot,
    profile,
    startupLog: [] as string[],
    onWizardComplete: async (wizardProfile: Profile) => {
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

      applyCliOverrides(fullProfile, options);

      profileStore.save(fullProfile);

      const ready = await connectAndWire(fullProfile, projectRoot);
      session = ready;

      renderApp({
        theme,
        registry,
        wizardMode: false,
        profile: fullProfile,
        metro: ready.metro,
        watcher: ready.watcher,
        worktreeKey: ready.worktreeKey,
        startupLog: [] as string[],
        builder: ready.builder,
      });

      triggerBuildsIfNeeded(ready, fullProfile, projectRoot);
    },
    onWizardCancel: () => {
      process.exit(0);
    },
  });

  // 10. Connect to the daemon as a client and wire the adapters into
  //     the serviceBus. React components update via serviceBus events
  //     — the initial render above is just the scaffolding.
  if (profile && !needsWizard) {
    connectAndWire(profile, projectRoot)
      .then((ready) => {
        session = ready;
        triggerBuildsIfNeeded(ready, profile!, projectRoot);
      })
      .catch((err) => {
        serviceBus.log(
          `\u2716 Daemon connect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  // 11. Cleanup on exit — stop the session so the daemon returns to
  //     the idle state cleanly. Session cleanup is best-effort: if
  //     the daemon is unreachable we still want to restore the
  //     terminal and exit.
  const cleanup = (): void => {
    session?.stop().catch(() => {
      /* daemon unreachable on shutdown — non-fatal */
    });
    try {
      root.unmount();
      renderer.destroy();
    } catch {
      /* renderer may already be destroyed */
    }
    process.stdout.write("\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l");
    process.stdout.write("\x1b[?25h");
    process.stdout.write("\x1b[?1049l");
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  process.on("exit", () => {
    cleanup();
  });
}

// ---------------------------------------------------------------------------
// Helper: connect to the daemon + publish adapter refs on the serviceBus
// ---------------------------------------------------------------------------

function applyCliOverrides(profile: Profile, options: StartOptions): void {
  if (options.platform) profile.platform = options.platform as Platform;
  if (options.mode) profile.mode = options.mode as RunMode;
  if (options.port) profile.metroPort = options.port;
}

async function connectAndWire(
  profile: Profile,
  projectRoot: string,
): Promise<DaemonSession> {
  const ready = await connectToDaemonSession(projectRoot, profile);
  serviceBus.setMetro(ready.metro);
  serviceBus.setDevTools(ready.devtools);
  serviceBus.setBuilder(ready.builder);
  serviceBus.setWatcher(ready.watcher);
  serviceBus.setWorktreeKey(ready.worktreeKey);

  // Bug 6 — surface daemon-emitted `session/log` lines in the TUI's
  // log pane via the existing `serviceBus.log` topic. See
  // `SessionClient` for why snapshot+subscribe is needed.
  const forward = (evt: { message: string }): void => {
    serviceBus.log(`[daemon] ${evt.message}`);
  };
  for (const evt of ready.lifecycle.recentLogs()) forward(evt);
  ready.lifecycle.on("log", forward);

  return ready;
}

function triggerBuildsIfNeeded(
  session: DaemonSession,
  profile: Profile,
  projectRoot: string,
): void {
  // Quick mode skips builds — the existing installed app connects to
  // Metro directly.
  if (profile.mode === "quick") return;

  const platformsToBuild: Array<"ios" | "android"> =
    profile.platform === "both"
      ? ["ios", "android"]
      : [profile.platform as "ios" | "android"];

  // Small delay so React's useEffect subscribes to builder events
  // before the daemon starts emitting them. Same rationale as the
  // pre-13.3 TUI path.
  setTimeout(() => {
    for (const plat of platformsToBuild) {
      const devId =
        plat === "ios" ? profile.devices?.ios : profile.devices?.android;
      void session.builder.build({
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
