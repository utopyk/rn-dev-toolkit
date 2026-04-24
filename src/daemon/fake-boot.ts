// Test-only session boot. Gated by `RN_DEV_DAEMON_BOOT_MODE=fake` in the
// daemon entrypoint — never selected in production paths.
//
// Returns a SessionServices-shaped stub whose `metro` / `devtools` /
// `moduleHost` are EventEmitters the supervisor wires listeners onto.
// A small wrapper gives each emitter the spec-minimum methods the
// supervisor touches (`on` / `off` / `emit`) with typed signatures —
// enough for the state-machine integration test to pass without the
// `as unknown as MetroManager` casts Kieran flagged in review.

import { EventEmitter } from "node:events";
import { MetroLogsStore } from "../core/metro-logs/buffer.js";
import { CapabilityRegistry } from "../core/module-host/capabilities.js";
import type {
  BootSessionServicesOptions,
  SessionServices,
} from "../core/session/boot.js";
import type { MetroManager } from "../core/metro.js";
import type { DevToolsManager } from "../core/devtools.js";
import type { Builder } from "../core/builder.js";
import type { FileWatcher } from "../core/watcher.js";
import type { ModuleHostManager } from "../core/module-host/manager.js";

/**
 * The slice of `MetroManager` / `DevToolsManager` / `ModuleHostManager`
 * the supervisor actually consumes: the EventEmitter surface. Casting
 * through this narrow interface is honest (the fake really does expose
 * those methods) whereas `as unknown as MetroManager` asserted the
 * fake had dozens of methods it did not, a crash-vector the TS
 * reviewer flagged.
 */
interface EventSourceOnly {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  emit(event: string, ...args: unknown[]): unknown;
}

export async function fakeBootSessionServices(
  opts: BootSessionServicesOptions,
): Promise<SessionServices> {
  const worktreeKey = opts.artifactStore.worktreeHash(opts.profile.worktree);
  const metro = new EventEmitter();
  const devtools = new EventEmitter();
  const moduleHost = new EventEmitter();
  const moduleEvents = new EventEmitter();
  const metroLogsStore = new MetroLogsStore();
  const capabilities = new CapabilityRegistry();
  const moduleRegistry = opts.moduleRegistry;

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
    metro.emit("status", { worktreeKey, status: "stopped" });
  };

  return {
    metro: metro as EventSourceOnly as MetroManager,
    devtools: devtools as EventSourceOnly as DevToolsManager,
    watcher: null as FileWatcher | null,
    builder: {} as Builder,
    moduleHost: moduleHost as EventSourceOnly as ModuleHostManager,
    moduleRegistry,
    worktreeKey,
    metroLogsStore,
    capabilities,
    moduleEvents,
    dispose,
  };
}
