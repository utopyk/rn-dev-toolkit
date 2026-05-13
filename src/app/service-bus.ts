/**
 * Global service bus — bridges the gap between start-flow (outside React)
 * and AppContext (inside React).
 *
 * start-flow emits events when services start/update.
 * AppContext subscribes via useEffect and updates React state.
 * This avoids calling root.render() multiple times.
 *
 * Phase D5 — every event payload now carries a `sessionId` so subscribers
 * can filter to the session they care about. The bus stays a flat
 * EventEmitter (the per-session Map lives on the supervisor side); D5
 * is a shape change only — single-session subscribers still ignore the
 * sessionId in v1, D6/D7 light up the multi-session path. See
 * `docs/plans/2026-05-13-next-session-prompt-d5-servicebus-per-session.md`.
 */

import { EventEmitter } from "events";
import type { SessionId } from "../core/identifiers.js";
import type { MetroClient } from "./client/metro-adapter.js";
import type { WatcherClient } from "./client/watcher-adapter.js";
import type { BuilderClient } from "./client/builder-adapter.js";
import type { DevToolsClient } from "./client/devtools-adapter.js";
import type { ModuleHostClient } from "./client/module-host-adapter.js";

/**
 * Carrier for events that may fire before any session is bound (cold-
 * daemon-connect errors, `clearModulesClient` on disconnect). The
 * per-session topics use the stricter required-SessionId form below.
 */
export interface SessionScopedEvent<T> {
  sessionId: SessionId;
  payload: T;
}

export interface MaybeSessionScopedEvent<T> {
  sessionId: SessionId | null;
  payload: T;
}

export interface ServiceBusEvents {
  /**
   * Free-form log line. `sessionId` is `null` when emitted before any
   * session is bound (cold-spawn error) and the session's SessionId
   * once the daemon has assigned one.
   */
  log: (payload: { sessionId: SessionId | null; text: string }) => void;
  metro: (payload: { sessionId: SessionId; metro: MetroClient }) => void;
  builder: (payload: { sessionId: SessionId; builder: BuilderClient }) => void;
  watcher: (payload: { sessionId: SessionId; watcher: WatcherClient }) => void;
  worktreeKey: (payload: { sessionId: SessionId; worktreeKey: string }) => void;
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
  devtools: (payload: { sessionId: SessionId; devtools: DevToolsClient }) => void;
  /**
   * Published after `connectElectronToDaemon` completes. Phase 13.4.1 —
   * every Electron `modules:*` ipcMain handler resolves its deps through
   * this one topic (install, uninstall, list, list-panels, resolve-panel,
   * host-call, call-tool, config-get, config-set, marketplace/list,
   * marketplace/info). Emitted again (with `client: null` + `sessionId:
   * null`) on daemon disconnect so handlers can invalidate their cached
   * adapter refs. Arch P0 on PR #20 — without clear-on-disconnect, a
   * daemon respawn mid-session leaves every handler holding a dead
   * client ref.
   */
  modulesClient: (payload: {
    sessionId: SessionId | null;
    client: ModuleHostClient | null;
  }) => void;
  /**
   * Fired when main knows the daemon-client will NEVER publish (e.g.
   * `startRealServices` returned null because no default profile is
   * configured, or `connectElectronToDaemon` rejected with an error
   * the user has to resolve manually). Handlers awaiting `modulesClient`
   * use this to fail fast with a meaningful message instead of timing
   * out 30 seconds later. Carries a human-readable reason that
   * surfaces verbatim in renderer error toasts. `sessionId` is `null`
   * when the abort fires before a session was minted (no-default-profile
   * path); otherwise it carries the session that failed.
   */
  modulesClientAborted: (payload: {
    sessionId: SessionId | null;
    reason: string;
  }) => void;
}

class ServiceBus extends EventEmitter {
  /**
   * Emit a free-form log line. `sessionId` is optional: cold-spawn
   * failures call `serviceBus.log(text)` before a session exists; the
   * second arg can be threaded in once one does.
   */
  log(text: string, sessionId: SessionId | null = null) {
    this.emit("log", { sessionId, text });
  }

  setMetro(sessionId: SessionId, metro: MetroClient) {
    this.emit("metro", { sessionId, metro });
  }

  setBuilder(sessionId: SessionId, builder: BuilderClient) {
    this.emit("builder", { sessionId, builder });
  }

  setWatcher(sessionId: SessionId, watcher: WatcherClient) {
    this.emit("watcher", { sessionId, watcher });
  }

  setWorktreeKey(sessionId: SessionId, worktreeKey: string) {
    this.emit("worktreeKey", { sessionId, worktreeKey });
  }

  setDevTools(sessionId: SessionId, devtools: DevToolsClient) {
    this.emit("devtools", { sessionId, devtools });
  }

  setModulesClient(sessionId: SessionId, client: ModuleHostClient) {
    this.emit("modulesClient", { sessionId, client });
  }

  /**
   * Invalidate cached handler references to the daemon client. Called
   * from `main.ts::wireDaemonDisconnectListener` on any adapter
   * disconnect so the next session's `setModulesClient(newClient)` can
   * re-populate deps. Without this, handlers hold a dead `ModuleHostClient`
   * post-reconnect. Arch P0 on PR #20.
   */
  clearModulesClient() {
    this.emit("modulesClient", { sessionId: null, client: null });
  }

  /**
   * Signal that the daemon-client will never publish for the current
   * session-attempt. Distinguishes "still booting" (renderer should
   * keep waiting) from "permanently won't connect" (renderer should
   * surface a fix-this message). Handlers that `awaitModulesClient`
   * reject with `reason` instead of waiting out the 30s timeout.
   */
  abortModulesClient(reason: string, sessionId: SessionId | null = null) {
    this.emit("modulesClientAborted", { sessionId, reason });
  }
}

// Singleton — shared between start-flow and AppContext
export const serviceBus = new ServiceBus();
