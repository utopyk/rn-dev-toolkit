// Test-only session boot. Gated by `RN_DEV_DAEMON_BOOT_MODE=fake` in the
// daemon entrypoint — never selected in production paths.
//
// Returns a SessionServices-shaped stub whose `metro` / `devtools` /
// `builder` / `watcher` / `moduleHost` are EventEmitters enriched with
// the minimal method surface the daemon's client RPCs delegate into.
// The stubs are deterministic (no real sockets, no real subprocesses) so
// Phase 13 integration tests can assert RPC shape + event fan-out
// without spawning Metro.
//
// Shape rationale: we attach real methods to EventEmitter instances and
// then cast through a narrow structural interface matching the managers
// the supervisor / client-rpcs consume. That keeps the "what does fake
// expose" explicit at the cast site — anything the supervisor starts
// calling without a corresponding fake method surfaces as a type error,
// not a runtime crash.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { MetroLogsStore } from "../core/metro-logs/buffer.js";
import { CapabilityRegistry } from "../core/module-host/capabilities.js";
import { registerModulesIpc } from "../app/modules-ipc.js";
import { ModuleConfigStore } from "../modules/config-store.js";
import {
  devSpaceManifest,
  lintTestManifest,
  settingsManifest,
} from "../modules/built-in/manifests.js";
import { registerMarketplaceBuiltIn } from "../modules/built-in/marketplace.js";
import type {
  BootSessionServicesOptions,
  SessionServices,
} from "../core/session/boot.js";
import type { MetroManager } from "../core/metro.js";
import type { DevToolsManager } from "../core/devtools.js";
import type { Builder, BuildOptions } from "../core/builder.js";
import type { FileWatcher } from "../core/watcher.js";
import type { ModuleHostManager } from "../core/module-host/manager.js";
import type { MetroInstance } from "../core/types.js";

interface FakeMetroSurface {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  reload(worktreeKey: string): boolean;
  devMenu(worktreeKey: string): boolean;
  getInstance(worktreeKey: string): MetroInstance | null;
  stopAll(): void;
}

interface FakeDevtoolsSurface {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  listNetwork(worktreeKey: string): {
    entries: readonly unknown[];
    cursorDropped: boolean;
    meta: Record<string, unknown>;
  };
  status(worktreeKey: string): Record<string, unknown>;
  clear(worktreeKey: string): void;
  selectTarget(worktreeKey: string, targetId: string): Promise<void>;
  dispose(): Promise<void>;
}

interface FakeBuilderSurface {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  build(opts: BuildOptions): void;
}

interface FakeModuleHostSurface {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
  // Methods the modules-ipc dispatcher calls at request time. Stubs
  // raise early rather than land as silent no-ops so a test that
  // exercises a path beyond the current wire-contract coverage gets a
  // readable failure. Kieran P1-3 on PR #20 — the previous cast chain
  // silently typed a 3-method fake as a 15-method manager, so the
  // first acquire/inspect/shutdown call would crash at runtime with
  // "is not a function".
  readonly capabilities: CapabilityRegistry;
  readonly configStore: ModuleConfigStore;
  inspect(moduleId: string, scopeUnit: string): null;
  acquire(): Promise<never>;
  release(): Promise<void>;
  shutdown(moduleId: string, scopeUnit: string): Promise<void>;
  shutdownAll(): Promise<void>;
  notifyConfigChanged(
    moduleId: string,
    scopeUnit: string,
    config: Record<string, unknown>,
  ): void;
}

export async function fakeBootSessionServices(
  opts: BootSessionServicesOptions,
): Promise<SessionServices> {
  const worktreeKey = opts.artifactStore.worktreeHash(opts.profile.worktree);
  const metro = makeFakeMetro(worktreeKey);
  const devtools = makeFakeDevtools();
  const builder = makeFakeBuilder();
  const capabilities = new CapabilityRegistry();
  const moduleHost = makeFakeModuleHost(capabilities);
  const metroLogsStore = new MetroLogsStore();
  const moduleRegistry = opts.moduleRegistry;

  // Register the four built-in modules so `modules/list` returns them
  // under fake boot — same parity the real `createModuleSystem` gives
  // production. Without this, the smoke suite's Marketplace assertion
  // (and any test that opens the Settings tab) would see an empty
  // module list. Phase 13.4.1 follow-up — the previous fake-boot
  // skipped registration because pre-flip the in-process bootstrap
  // handled it Electron-side.
  moduleRegistry.registerBuiltIn(devSpaceManifest);
  moduleRegistry.registerBuiltIn(lintTestManifest);
  moduleRegistry.registerBuiltIn(settingsManifest);
  registerMarketplaceBuiltIn({ moduleRegistry, capabilities });

  // Phase 13.4.1 — register the modules IPC dispatcher on the daemon's
  // shared socket so integration tests that exercise `modules/*` RPCs
  // (host-call, list-panels, resolve-panel, install/uninstall,
  // config/get|set, ...) can run against the fake boot path. The real
  // `bootSessionServices` does this at step 12; the stub mirrored every
  // other surface but skipped this one because pre-13.4.1 fake tests
  // never exercised modules IPC.
  const modulesIpc = registerModulesIpc(opts.ipc, {
    manager: moduleHost as FakeModuleHostSurface as unknown as ModuleHostManager,
    registry: moduleRegistry,
  });
  const moduleEvents = modulesIpc.moduleEvents;

  // Emit "starting" on the next macrotask — supervisor wires event
  // listeners AFTER bootFn resolves, so a microtask-scheduled emit
  // fires too early. setTimeout(0) pushes past the await continuation
  // and lets the listener attach first. "running" follows shortly
  // after so the integration test's `waitForEvent` completes.
  setTimeout(() => {
    metro.emit("status", { worktreeKey, status: "starting" });
  }, 5);
  setTimeout(() => {
    metro.emit("status", { worktreeKey, status: "running" });
  }, 25);

  const dispose = async (): Promise<void> => {
    modulesIpc.unregister();
    metro.emit("status", { worktreeKey, status: "stopped" });
  };

  return {
    metro: metro as FakeMetroSurface as unknown as MetroManager,
    devtools: devtools as FakeDevtoolsSurface as unknown as DevToolsManager,
    watcher: null as FileWatcher | null,
    builder: builder as FakeBuilderSurface as unknown as Builder,
    moduleHost: moduleHost as FakeModuleHostSurface as unknown as ModuleHostManager,
    moduleRegistry,
    worktreeKey,
    metroLogsStore,
    capabilities,
    moduleEvents,
    dispose,
  };
}

function makeFakeMetro(worktreeKey: string): EventEmitter & FakeMetroSurface {
  const emitter = new EventEmitter() as EventEmitter & FakeMetroSurface;
  emitter.reload = (_wt: string): boolean => {
    emitter.emit("log", { worktreeKey, line: "[fake] reload", stream: "stdout" });
    return true;
  };
  emitter.devMenu = (_wt: string): boolean => {
    emitter.emit("log", { worktreeKey, line: "[fake] devMenu", stream: "stdout" });
    return true;
  };
  emitter.getInstance = (_wt: string): MetroInstance | null => ({
    worktree: "/fake",
    port: 8081,
    pid: 0,
    status: "running",
    startedAt: new Date(0),
    projectRoot: "/fake",
  });
  emitter.stopAll = (): void => {
    /* no-op in fake */
  };
  return emitter;
}

function makeFakeDevtools(): EventEmitter & FakeDevtoolsSurface {
  const emitter = new EventEmitter() as EventEmitter & FakeDevtoolsSurface;
  emitter.listNetwork = (worktreeKey: string) => ({
    entries: [] as readonly unknown[],
    cursorDropped: false,
    meta: { worktreeKey },
  });
  emitter.status = (worktreeKey: string): Record<string, unknown> => ({
    meta: { worktreeKey },
    targets: [],
    rnVersion: null,
    proxyPort: null,
    sessionNonce: null,
    bodyCaptureEnabled: false,
  });
  emitter.clear = (worktreeKey: string): void => {
    emitter.emit("status", { worktreeKey });
  };
  emitter.selectTarget = async (
    _worktreeKey: string,
    _targetId: string,
  ): Promise<void> => {
    /* no-op in fake */
  };
  emitter.dispose = async (): Promise<void> => {
    /* no-op in fake */
  };
  return emitter;
}

function makeFakeBuilder(): EventEmitter & FakeBuilderSurface {
  const emitter = new EventEmitter() as EventEmitter & FakeBuilderSurface;
  emitter.build = (opts: BuildOptions): void => {
    // Emit a deterministic sequence of line → progress → done. Each emit
    // is on a separate tick so subscribers observe the ordering the
    // real Builder produces.
    setImmediate(() => {
      emitter.emit("line", {
        text: `[fake] building ${opts.platform}`,
        stream: "stdout",
      });
    });
    setImmediate(() => {
      emitter.emit("progress", { phase: "compiling" });
    });
    setImmediate(() => {
      emitter.emit("done", { success: true, errors: [], platform: opts.platform });
    });
  };
  return emitter;
}

function makeFakeModuleHost(
  capabilities: CapabilityRegistry,
): EventEmitter & FakeModuleHostSurface {
  const emitter = new EventEmitter() as EventEmitter & FakeModuleHostSurface;
  Object.defineProperty(emitter, "capabilities", {
    value: capabilities,
    writable: false,
    enumerable: true,
  });
  // Real ModuleConfigStore writing to a per-test tmpdir so concurrent
  // smoke runs + integration tests don't fight over the same on-disk
  // config files. The store is throwaway — afterEach cleanup deletes
  // the worktree but not this dir; OS tmpdir gc handles it.
  const configDir = mkdtempSync(join(tmpdir(), "rn-dev-fake-cfg-"));
  Object.defineProperty(emitter, "configStore", {
    value: new ModuleConfigStore({ modulesDir: configDir }),
    writable: false,
    enumerable: true,
  });
  emitter.inspect = (): null => null;
  emitter.acquire = async (): Promise<never> => {
    throw new Error(
      "[fake] modules/call not supported under RN_DEV_DAEMON_BOOT_MODE=fake — acquire() unimplemented",
    );
  };
  emitter.release = async (): Promise<void> => {
    /* no-op in fake */
  };
  emitter.shutdown = async (): Promise<void> => {
    /* no-op in fake */
  };
  emitter.shutdownAll = async (): Promise<void> => {
    /* no-op in fake */
  };
  emitter.notifyConfigChanged = (): void => {
    /* no-op in fake — real manager pushes a config/changed RPC to the live
       subprocess; there is none here */
  };
  return emitter;
}
