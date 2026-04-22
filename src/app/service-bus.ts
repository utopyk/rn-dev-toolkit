/**
 * Global service bus — bridges the gap between start-flow (outside React)
 * and AppContext (inside React).
 *
 * start-flow emits events when services start/update.
 * AppContext subscribes via useEffect and updates React state.
 * This avoids calling root.render() multiple times.
 */

import { EventEmitter } from "events";
import type { MetroManager } from "../core/metro.js";
import type { FileWatcher } from "../core/watcher.js";
import type { DevToolsManager } from "../core/devtools.js";
import type { ModuleHostManager } from "../core/module-host/manager.js";
import type { ModuleRegistry } from "../modules/registry.js";

export interface ServiceBusEvents {
  log: (text: string) => void;
  metro: (metro: MetroManager) => void;
  builder: (builder: any) => void;
  watcher: (watcher: FileWatcher) => void;
  worktreeKey: (key: string) => void;
  /**
   * DevTools is published once per session after Metro is up. Consumers
   * subscribe to the manager's own 'delta' and 'status' events — the bus
   * only bridges the instance reference across the start-flow / React
   * boundary.
   *
   * Namespacing: the module-system brainstorm frames `devtools` as one of
   * several future built-in modules. When that lands, this topic will
   * become one of a family (`devtools-network`, `devtools-console`, ...).
   * Treat the name as provisional.
   */
  devtools: (manager: DevToolsManager) => void;
  /**
   * Published once when the daemon boots. The Phase 2 manager owns
   * module subprocess lifecycle — Phase 3 subscribes to expose modules/*
   * MCP tools; Phase 4 subscribes to render panels.
   */
  moduleHost: (manager: ModuleHostManager) => void;
  /**
   * Published once after `moduleHost` — the registry tracks loaded
   * manifests. Electron main subscribes so panel-bridge can resolve
   * module root paths + manifests by id.
   */
  moduleRegistry: (registry: ModuleRegistry) => void;
  /**
   * The shared `moduleEvents` EventEmitter owned by `registerModulesIpc`
   * (or created eagerly by the Electron-side module-system bootstrap).
   *
   * Published once; every subscriber (Electron renderer forward, MCP
   * `modules/subscribe`, Electron `modules:config-set`) attaches directly
   * to this emitter. Phase 5c — simplicity #6 removed the redundant
   * `moduleEvent` topic that used to relay through the serviceBus; having
   * one emitter means one fan-out point.
   */
  moduleEventsBus: (emitter: EventEmitter) => void;
}

class ServiceBus extends EventEmitter {
  log(text: string) {
    this.emit("log", text);
  }

  setMetro(metro: MetroManager) {
    this.emit("metro", metro);
  }

  setBuilder(builder: any) {
    this.emit("builder", builder);
  }

  setWatcher(watcher: FileWatcher) {
    this.emit("watcher", watcher);
  }

  setWorktreeKey(key: string) {
    this.emit("worktreeKey", key);
  }

  setDevTools(manager: DevToolsManager) {
    this.emit("devtools", manager);
  }

  setModuleHost(manager: ModuleHostManager) {
    this.emit("moduleHost", manager);
  }

  setModuleRegistry(registry: ModuleRegistry) {
    this.emit("moduleRegistry", registry);
  }

  setModuleEventsBus(emitter: EventEmitter) {
    this.emit("moduleEventsBus", emitter);
  }
}

// Singleton — shared between start-flow and AppContext
export const serviceBus = new ServiceBus();
