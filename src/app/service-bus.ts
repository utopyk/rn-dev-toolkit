/**
 * Global service bus — bridges the gap between start-flow (outside React)
 * and AppContext (inside React).
 *
 * start-flow emits events when services start/update.
 * AppContext subscribes via useEffect and updates React state.
 * This avoids calling root.render() multiple times.
 */

import { EventEmitter } from "events";
import type { MetroClient } from "./client/metro-adapter.js";
import type { WatcherClient } from "./client/watcher-adapter.js";
import type { BuilderClient } from "./client/builder-adapter.js";
import type { DevToolsClient } from "./client/devtools-adapter.js";
import type { ModuleHostClient } from "./client/module-host-adapter.js";

export interface ServiceBusEvents {
  log: (text: string) => void;
  metro: (metro: MetroClient) => void;
  builder: (builder: BuilderClient) => void;
  watcher: (watcher: WatcherClient) => void;
  worktreeKey: (key: string) => void;
  /**
   * DevTools is published once per session after Metro is up. The
   * emitted instance is the client-side adapter (Phase 13.3) —
   * consumers subscribe to its `delta` and `status` events which are
   * driven off the daemon's events/subscribe stream.
   *
   * Namespacing: the module-system brainstorm frames `devtools` as one of
   * several future built-in modules. When that lands, this topic will
   * become one of a family (`devtools-network`, `devtools-console`, ...).
   * Treat the name as provisional.
   */
  devtools: (manager: DevToolsClient) => void;
  /**
   * Published after `connectElectronToDaemon` completes. Phase 13.4.1 —
   * every Electron `modules:*` ipcMain handler resolves its deps through
   * this one topic (install, uninstall, list, list-panels, resolve-panel,
   * host-call, call-tool, config-get, config-set, marketplace/list,
   * marketplace/info). Emitted again (with `null`) on daemon disconnect
   * so handlers can invalidate their cached adapter refs. Arch P0 on
   * PR #20 — without clear-on-disconnect, a daemon respawn mid-session
   * leaves every handler holding a dead client ref.
   */
  modulesClient: (client: ModuleHostClient | null) => void;
}

class ServiceBus extends EventEmitter {
  log(text: string) {
    this.emit("log", text);
  }

  setMetro(metro: MetroClient) {
    this.emit("metro", metro);
  }

  setBuilder(builder: BuilderClient) {
    this.emit("builder", builder);
  }

  setWatcher(watcher: WatcherClient) {
    this.emit("watcher", watcher);
  }

  setWorktreeKey(key: string) {
    this.emit("worktreeKey", key);
  }

  setDevTools(manager: DevToolsClient) {
    this.emit("devtools", manager);
  }

  setModulesClient(client: ModuleHostClient) {
    this.emit("modulesClient", client);
  }

  /**
   * Invalidate cached handler references to the daemon client. Called
   * from `main.ts::wireDaemonDisconnectListener` on any adapter
   * disconnect so the next session's `setModulesClient(newClient)` can
   * re-populate deps. Without this, handlers hold a dead `ModuleHostClient`
   * post-reconnect. Arch P0 on PR #20.
   */
  clearModulesClient() {
    this.emit("modulesClient", null);
  }
}

// Singleton — shared between start-flow and AppContext
export const serviceBus = new ServiceBus();
