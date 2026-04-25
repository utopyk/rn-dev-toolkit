// Shared session-boot factory. Phase 13.2 extraction — the body that used
// to live inside `src/app/start-flow.ts::startServicesAsync` is now callable
// from both the TUI path (unchanged behavior) and the daemon supervisor.
//
// The TUI-specific `serviceBus` fan-out stays in the caller — `bootSessionServices`
// returns the raw services so the caller can wire them into whatever
// propagation layer fits (ServiceBus for React in the TUI, an EventEmitter
// in the daemon).

import path from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

import { execShellAsync } from "../exec-async.js";
import type { ArtifactStore } from "../artifact.js";
import type { ModuleRegistry } from "../../modules/registry.js";
import { isSensitivePermission } from "../../modules/index.js";
import { MetroManager } from "../metro.js";
import { DevToolsManager } from "../devtools.js";
import { MetroLogsStore } from "../metro-logs/buffer.js";
import {
  METRO_LOGS_CAPABILITY_ID,
  METRO_LOGS_CAPABILITY_READ_PERMISSION,
  METRO_LOGS_METHOD_PERMISSIONS,
  createMetroLogsHostCapability,
} from "../metro-logs/host-capability.js";
import { CleanManager } from "../clean.js";
import { FileWatcher } from "../watcher.js";
import { IpcServer } from "../ipc.js";
import type { ModuleHostManager } from "../module-host/manager.js";
import { CapabilityRegistry } from "../module-host/capabilities.js";
import {
  createDevtoolsHostCapability,
  DEVTOOLS_CAPABILITY_ID,
  DEVTOOLS_CAPABILITY_READ_PERMISSION,
  DEVTOOLS_METHOD_PERMISSIONS,
} from "../devtools/host-capability.js";
import {
  createModuleSystem,
  type LogCapability,
} from "../../modules/create-module-system.js";
import type { Builder } from "../builder.js";
import type { Profile } from "../types.js";

export interface BootSessionServicesOptions {
  profile: Profile;
  projectRoot: string;
  artifactStore: ArtifactStore;
  /**
   * Module registry — the TUI path seeds it with legacy Ink-style modules
   * BEFORE calling bootSessionServices so the factory can layer manifest
   * built-ins + user-global 3p modules on top of them without collision.
   * The daemon path passes a fresh registry — no legacy Ink surface.
   */
  moduleRegistry: ModuleRegistry;
  /** Log callback. Receives user-facing lines from the boot sequence. */
  emit: (line: string) => void;
  /** Host version string exposed as the `appInfo` capability. */
  hostVersion: string;
  /**
   * Pre-constructed IpcServer for request/response surfaces like
   * `registerModulesIpc`. The TUI creates this at
   * `<projectRoot>/.rn-dev/sock`. The daemon owns its own socket at
   * `<worktree>/.rn-dev/sock` and passes it in so `modules/*` RPCs land
   * on the same wire the daemon already listens on.
   */
  ipc: IpcServer;
  /**
   * Phase 13.6 PR-C P0-1 — bidirectional-gate enforcement. The daemon
   * passes its `SubscribeRegistry` here so `registerModulesIpc` can
   * guard `modules/host-call` and `modules/bind-sender` against
   * non-bidirectional subscribe-socket senders. The TUI path omits it
   * (the TUI socket is not multiplexed — every send is a fresh RPC
   * socket, not a subscribe socket, so there is nothing to gate).
   */
  subscribeRegistry?: import("../../daemon/subscribe-registry.js").SubscribeRegistry;
}

export interface SessionServices {
  metro: MetroManager;
  devtools: DevToolsManager;
  watcher: FileWatcher | null;
  builder: Builder;
  moduleHost: ModuleHostManager;
  moduleRegistry: ModuleRegistry;
  worktreeKey: string;
  metroLogsStore: MetroLogsStore;
  capabilities: CapabilityRegistry;
  /**
   * Bus that fans out module lifecycle events (state-changed / crashed /
   * failed). Registered via `registerModulesIpc`; kept on the struct so
   * daemon-side event subscribers can attach without re-wiring IPC.
   */
  moduleEvents: ReturnType<typeof import("../../app/modules-ipc.js").registerModulesIpc>["moduleEvents"];
  /** Release resources. Daemon calls this on session/stop. */
  dispose: () => Promise<void>;
}

export async function bootSessionServices(
  opts: BootSessionServicesOptions,
): Promise<SessionServices> {
  const { profile, projectRoot, artifactStore, moduleRegistry, emit, hostVersion, ipc } = opts;

  // 1. Preflight checks (optional — profile-configured).
  if (profile.preflight.checks.length > 0) {
    const artifact = artifactStore.load(
      artifactStore.worktreeHash(profile.worktree),
    );
    const needsPreflight =
      profile.preflight.frequency === "always" || !artifact?.preflightPassed;
    if (needsPreflight) {
      emit("\u23f3 Running preflight checks...");
      const { createDefaultPreflightEngine } = await import("../preflight.js");
      const engine = createDefaultPreflightEngine(projectRoot);
      const results = await engine.runAll(profile.platform, profile.preflight);
      let hasErrors = false;
      for (const [id, result] of results) {
        const icon = result.passed ? "\u2714" : "\u2716";
        emit(`  ${icon} ${id}: ${result.message}`);
        if (!result.passed) hasErrors = true;
      }
      emit(
        hasErrors
          ? "  \u26a0 Some preflight checks failed. Continuing anyway..."
          : "  \u2714 All preflight checks passed",
      );
      emit("");
      const wKey = artifactStore.worktreeHash(profile.worktree);
      artifactStore.save(wKey, { preflightPassed: !hasErrors });
    }
  }

  // 2. node_modules auto-install.
  const effectiveRoot = profile.worktree ?? projectRoot;
  if (!existsSync(path.join(effectiveRoot, "node_modules"))) {
    emit("\u26a0 node_modules not found \u2014 auto-installing dependencies...");
    const hasPackageLock = existsSync(path.join(effectiveRoot, "package-lock.json"));
    const hasBunLock =
      existsSync(path.join(effectiveRoot, "bun.lock")) ||
      existsSync(path.join(effectiveRoot, "bun.lockb"));
    const hasYarnLock = existsSync(path.join(effectiveRoot, "yarn.lock"));
    const installCmd = hasPackageLock
      ? "npm install"
      : hasBunLock
        ? "bun install"
        : hasYarnLock
          ? "yarn install"
          : "npm install";
    emit(`  \u23f3 ${installCmd}...`);
    try {
      await execShellAsync(installCmd, { cwd: effectiveRoot, timeout: 300000 });
      emit("  \u2714 Dependencies installed");
    } catch (err) {
      emit(
        `  \u2716 Install failed: ${
          err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)
        }`,
      );
      emit("  \u26a0 Build will likely fail without node_modules");
    }
    emit("");
    if (profile.platform === "ios" || profile.platform === "both") {
      const podfilePath = path.join(effectiveRoot, "ios", "Podfile");
      if (existsSync(podfilePath)) {
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

  // 3. Clean.
  if (profile.mode !== "dirty" && profile.mode !== "quick") {
    const cleaner = new CleanManager(projectRoot);
    emit(`\u23f3 Running ${profile.mode} clean...`);
    await cleaner.execute(profile.mode, profile.platform, (step, status) => {
      const icon = status === "done" ? "\u2714" : status === "skip" ? "\u2139" : "\u26a0";
      emit(`  ${icon} ${step}`);
    });
    emit("");
  }

  // 4. Watchman clear. Argv-form spawn (not `sh -c`) so a crafted
  // `effectiveRoot` from an untrusted profile can't escape quoting —
  // Security reviewer P0 on shell injection closed at this call site.
  emit("\u23f3 Clearing watchman...");
  await spawnWatchmanWatchDel(effectiveRoot, emit);

  // 5. Port check + kill stale.
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

  // 6. Simulator boot (iOS only).
  if (profile.platform === "ios" || profile.platform === "both") {
    const deviceId = profile.devices?.ios;
    if (deviceId) {
      emit("\u23f3 Checking simulator status...");
      try {
        const { listDevices: listDev, bootDevice } = await import("../device.js");
        const devices = await listDev("ios");
        const device = devices.find((d) => d.id === deviceId);
        if (device && device.status === "shutdown") {
          emit(`\u23f3 Booting simulator ${device.name}...`);
          const booted = await bootDevice(device);
          emit(
            booted
              ? "  \u2714 Simulator booted"
              : "  \u26a0 Could not boot simulator \u2014 may already be booting",
          );
        } else if (device && device.status === "booted") {
          emit(`  \u2714 Simulator ${device.name} already booted`);
        } else {
          emit(`  \u26a0 Device ${deviceId} not found in simulator list`);
        }
      } catch (err) {
        emit(
          `  \u26a0 Simulator check failed: ${
            err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80)
          }`,
        );
      }
    }
  }

  // 7. Metro.
  emit(`\u23f3 Starting Metro on port ${port}...`);
  const metroLogsStore = new MetroLogsStore();
  metro.on("log", (event: { worktreeKey: string; line: string; stream: "stdout" | "stderr" }) => {
    metroLogsStore.append(event.worktreeKey, event.stream, event.line);
  });
  metro.on("status", (event: { worktreeKey: string; status: string }) => {
    metroLogsStore.setMetroStatus(event.worktreeKey, event.status);
  });
  metro.start({
    worktreeKey,
    projectRoot: effectiveRoot,
    port: profile.metroPort,
    resetCache: profile.mode !== "dirty" && profile.mode !== "quick",
    verbose: true,
    env: profile.env,
  });

  // 8. File watcher (created but not started).
  let watcher: FileWatcher | null = null;
  if (profile.onSave.length > 0) {
    watcher = new FileWatcher({
      projectRoot,
      actions: profile.onSave,
    });
    emit("\u2139 File watcher ready \u2014 press [w] to enable");
  }

  // 9. DevTools.
  const devtools = new DevToolsManager(metro, {});
  try {
    await devtools.start(worktreeKey);
  } catch (err) {
    emit(
      `\u2139 DevTools: deferred (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // 10. Builder.
  const { Builder } = await import("../builder.js");
  const builder = new Builder();

  // 11. Module system (host capabilities registered first so built-in
  //     manifest activation resolves the TUI/daemon-provided metro +
  //     artifacts + devtools + metro-logs).
  const capabilities = registerHostCapabilities({
    metro,
    artifactStore,
    devtools,
    metroLogsStore,
    worktreeKey,
  });
  const { moduleHost } = createModuleSystem({
    hostVersion,
    worktreeKey,
    capabilities,
    moduleRegistry,
    logger: createScopedLogger(emit),
  });

  const loadResult = moduleRegistry.loadUserGlobalModules({
    hostVersion,
    scopeUnit: worktreeKey,
  });
  if (loadResult.modules.length > 0) {
    emit(
      `\u2139 Loaded ${loadResult.modules.length} module manifest${loadResult.modules.length === 1 ? "" : "s"} (${loadResult.modules.map((m) => m.manifest.id).join(", ")})`,
    );
  }
  for (const mod of loadResult.modules) {
    const sensitive = (mod.manifest.permissions ?? []).filter(isSensitivePermission);
    if (sensitive.length > 0) {
      emit(
        `\u26a0 Module "${mod.manifest.id}" holds sensitive permission${sensitive.length === 1 ? "" : "s"}: ${sensitive.join(", ")} \u2014 untrusted external content (network traffic, device output, Metro log lines) may be exposed over MCP.`,
      );
    }
  }
  for (const rejected of loadResult.rejected) {
    emit(
      `\u26a0 Module manifest rejected (${rejected.code}): ${rejected.manifestPath} \u2014 ${rejected.message}`,
    );
  }

  // 12. Register modules IPC. `moduleEvents` is the daemon's single
  //     fan-out point for module lifecycle events — attached to
  //     events/subscribe.
  const { registerModulesIpc } = await import("../../app/modules-ipc.js");
  const modulesIpc = registerModulesIpc(ipc, {
    manager: moduleHost,
    registry: moduleRegistry,
    subscribeRegistry: opts.subscribeRegistry,
  });

  emit("\u2714 All services started");
  emit("");

  const dispose = async (): Promise<void> => {
    try {
      modulesIpc.unregister();
    } catch {
      /* best-effort */
    }
    try {
      await devtools.dispose();
    } catch {
      /* best-effort */
    }
    try {
      metro.stopAll();
    } catch {
      /* best-effort */
    }
    try {
      watcher?.stop();
    } catch {
      /* best-effort */
    }
  };

  return {
    metro,
    devtools,
    watcher,
    builder,
    moduleHost,
    moduleRegistry,
    worktreeKey,
    metroLogsStore,
    capabilities,
    moduleEvents: modulesIpc.moduleEvents,
    dispose,
  };
}

interface HostCapabilityDeps {
  metro: MetroManager;
  artifactStore: ArtifactStore;
  devtools: DevToolsManager;
  metroLogsStore: MetroLogsStore;
  worktreeKey: string;
}

function registerHostCapabilities(deps: HostCapabilityDeps): CapabilityRegistry {
  const capabilities = new CapabilityRegistry();
  capabilities.register("metro", deps.metro, {
    requiredPermission: "exec:react-native",
  });
  capabilities.register("artifacts", deps.artifactStore, {
    requiredPermission: "fs:artifacts",
  });
  capabilities.register(
    DEVTOOLS_CAPABILITY_ID,
    createDevtoolsHostCapability(deps.devtools, deps.worktreeKey),
    {
      requiredPermission: DEVTOOLS_CAPABILITY_READ_PERMISSION,
      methodPermissions: DEVTOOLS_METHOD_PERMISSIONS,
    },
  );
  capabilities.register(
    METRO_LOGS_CAPABILITY_ID,
    createMetroLogsHostCapability(deps.metroLogsStore, deps.worktreeKey),
    {
      requiredPermission: METRO_LOGS_CAPABILITY_READ_PERMISSION,
      methodPermissions: METRO_LOGS_METHOD_PERMISSIONS,
    },
  );
  return capabilities;
}

function spawnWatchmanWatchDel(
  root: string,
  emit: (line: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn("watchman", ["watch-del", root], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    let settled = false;
    const finish = (outcome: "ok" | "err"): void => {
      if (settled) return;
      settled = true;
      if (outcome === "ok") emit("\u2714 Watchman watch cleared for project");
      else emit("\u2139 Watchman not available or timed out");
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* best-effort */
      }
      finish("err");
    }, 15_000);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      finish(code === 0 ? "ok" : "err");
    });
    proc.on("error", () => {
      clearTimeout(timer);
      finish("err");
    });
  });
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
