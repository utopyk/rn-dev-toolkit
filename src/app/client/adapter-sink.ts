// Contract every client-side adapter implements for receiving events +
// lifecycle signals from a dispatcher. Phase 13.4 prereq #2.
//
// The 13.3 adapters exposed `_dispatch(kind, data)` — underscore prefix
// by convention to signal "only the session orchestrator calls this".
// That convention breaks down in Phase 13.4: Electron's main-process
// orchestrator AND its renderer-side mirror (future phase work) both
// need to push events into the adapters, and a method that reads as
// public is clearer than a two-site "internal" convention.
//
// Interface, not a class, so adapters keep their EventEmitter base
// and method shape. A future `BaseAdapter` helper could codify the
// rename further if adapters grow enough to warrant it — today the
// interface is load-bearing by itself.

// No default on K — a bare `AdapterSink` (no generic argument)
// would accept any string for `dispatch` and silently erase the
// per-adapter narrowing. Every call site passes the literal union;
// Kieran P1 on PR #18.
export interface AdapterSink<K extends string> {
  /**
   * Fan a daemon event into the adapter's internal emitter. Called by
   * the session orchestrator from `events/subscribe`; later Electron
   * main will call it directly when forwarding events between main
   * and renderer processes.
   */
  dispatch(kind: K, data: unknown): void;

  /**
   * Signal that the underlying daemon socket dropped unexpectedly
   * (crash / SIGKILL / host loss). Voluntary `disconnect()` / `stop()`
   * on DaemonSession do NOT invoke this — only involuntary drops.
   * Each adapter re-emits it as a `'disconnected'` event so React /
   * other consumers can react without coupling to the orchestrator.
   */
  notifyDisconnected(err?: Error): void;
}

/**
 * Narrow string-literal kinds the Metro adapter receives.
 */
export type MetroEventKind = "metro/status" | "metro/log";

/**
 * Narrow string-literal kinds the DevTools adapter receives.
 */
export type DevToolsEventKind = "devtools/status" | "devtools/delta";

/**
 * Narrow string-literal kinds the Builder adapter receives.
 */
export type BuilderEventKind = "builder/line" | "builder/progress" | "builder/done";

/**
 * Narrow string-literal kinds the Watcher adapter receives.
 */
export type WatcherEventKind = "watcher/action-complete";

/**
 * Narrow string-literal kinds the ModuleHost adapter receives. Phase
 * 13.4 prereq #3 closed the `modules/*` gap in `routeEventToAdapters`.
 */
export type ModuleHostEventKind =
  | "modules/state-changed"
  | "modules/crashed"
  | "modules/failed";

/**
 * Narrow string-literal kinds the Session adapter receives. Bug 6 — the
 * daemon emits these for every step of `bootSessionServices` and on
 * every state-machine transition; pre-fix they fell into
 * `routeEventToAdapters`'s default arm and disappeared.
 */
export type SessionEventKind = "session/log" | "session/status";
