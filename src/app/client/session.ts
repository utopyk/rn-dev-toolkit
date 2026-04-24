// Client-side session orchestrator. One call from the TUI/Electron:
//   `await connectToDaemonSession(projectRoot, profile)`
// returns a live `DaemonSession` where every adapter already has its
// IpcClient reference, a shared event subscription is open, and events
// are routed to the matching adapter as they arrive.
//
// Lifecycle:
//   - `connectToDaemon` ensures a daemon is running at
//     <projectRoot>/.rn-dev/sock (auto-spawns if not).
//   - `events/subscribe` opens a single long-lived socket; every
//     adapter observes events through it.
//   - `session/start { profile }` kicks the daemon's supervisor.
//   - Callers await the "running" transition before treating the
//     session as usable — the daemon returns `starting` immediately.
//   - `stop()` issues `session/stop` then closes the subscription.
//   - `disconnect()` closes the subscription WITHOUT asking the daemon
//     to teardown. Electron's window-close goes through this; a
//     second client (MCP, another GUI instance) keeps the session
//     alive. Phase 13.4 prereq #1.
//
// The adapters are shaped for React (EventEmitter + async methods) but
// bear no direct dependency on React; MCP + Electron clients in 13.4
// / 13.5 reuse the same set.

import {
  connectToDaemon,
  type ConnectToDaemonOptions,
} from "../../daemon/spawn.js";
import type { IpcClient, IpcMessage } from "../../core/ipc.js";
import type { Profile } from "../../core/types.js";
import { MetroClient } from "./metro-adapter.js";
import { DevToolsClient } from "./devtools-adapter.js";
import { BuilderClient } from "./builder-adapter.js";
import { WatcherClient } from "./watcher-adapter.js";
import { ModuleHostClient } from "./module-host-adapter.js";

export interface DaemonSession {
  client: IpcClient;
  metro: MetroClient;
  devtools: DevToolsClient;
  builder: BuilderClient;
  watcher: WatcherClient;
  /**
   * Surfaces `modules/*` events (state-changed / crashed / failed)
   * from the daemon. Phase 13.4 prereq #3 added this adapter so
   * Electron's renderer-forwarding wiring has a stable source; the
   * TUI does not consume it but the field is present for uniformity
   * across clients.
   */
  modules: ModuleHostClient;
  worktreeKey: string;
  /**
   * Closes the event subscription + client without asking the daemon
   * to tear down the session. The daemon keeps the services alive for
   * any other connected client (another TUI, MCP, Electron renderer).
   * Idempotent — safe to call after the daemon already died.
   */
  disconnect: () => void;
  /**
   * Graceful session teardown: sends `session/stop` so the supervisor
   * drives its `running → stopping → stopped` transitions, then closes
   * the subscription. Used by the CLI path where the user quitting the
   * TUI legitimately means "return the daemon to idle". For shared-
   * daemon clients (Electron, MCP) prefer `disconnect()`.
   */
  stop: () => Promise<void>;
}

export interface ConnectToDaemonSessionOptions extends ConnectToDaemonOptions {
  /** Upper bound for waiting on the session to transition to "running". */
  sessionReadyTimeoutMs?: number;
}

export async function connectToDaemonSession(
  projectRoot: string,
  profile: Profile,
  opts: ConnectToDaemonSessionOptions = {},
): Promise<DaemonSession> {
  const { sessionReadyTimeoutMs = 30_000, ...connectOpts } = opts;

  const client = await connectToDaemon(projectRoot, connectOpts);
  const idGen = makeIdGenerator();
  const metro = new MetroClient(client, idGen);
  const devtools = new DevToolsClient(client, idGen);
  const builder = new BuilderClient(client, idGen);
  const watcher = new WatcherClient(client, idGen);
  const modules = new ModuleHostClient(client, idGen);

  let worktreeKey: string | null = null;
  let resolveRunning: (() => void) | null = null;
  let rejectRunning: ((err: Error) => void) | null = null;
  const runningPromise = new Promise<void>((res, rej) => {
    resolveRunning = res;
    rejectRunning = rej;
  });

  // Track whether the caller has asked us to close. A voluntary close
  // must not trigger the "daemon died" path — that's reserved for an
  // unexpected socket drop (daemon crashed, SIGKILLed, host lost).
  let voluntaryClose = false;
  let closed = false;

  const notifyDisconnected = (err?: Error): void => {
    if (closed) return;
    closed = true;
    if (voluntaryClose) return;
    // Unblock any caller still awaiting the running transition —
    // otherwise a daemon death mid-boot hangs `connectToDaemonSession`
    // for the full sessionReadyTimeoutMs.
    rejectRunning?.(
      err ?? new Error("connectToDaemonSession: daemon disconnected during boot"),
    );
    metro.notifyDisconnected(err);
    devtools.notifyDisconnected(err);
    builder.notifyDisconnected(err);
    watcher.notifyDisconnected(err);
    modules.notifyDisconnected(err);
  };

  const onIncomingEvent = (msg: IpcMessage): void => {
    const evt = parseSessionEventEnvelope(msg.payload);
    if (!evt) return;
    if (!worktreeKey) worktreeKey = evt.worktreeKey;
    // Pre-running session/status edges drive the runningPromise:
    //   starting → running   → resolve
    //   starting → stopped   → reject  (bootSessionServices failed)
    //   starting → stopping  → reject  (stop raced the boot)
    // Without this the caller waits the full sessionReadyTimeoutMs to
    // discover a failed boot — Kieran P0-1 on PR #17.
    if (evt.kind === "session/status") {
      const status = readStatus(evt.data);
      if (status === "running") {
        resolveRunning?.();
      } else if (status === "stopped" || status === "stopping") {
        rejectRunning?.(
          new Error(
            `connectToDaemonSession: session transitioned to "${status}" before reaching "running"`,
          ),
        );
      }
    }
    routeEventToAdapters(evt.kind, evt.data, {
      metro,
      devtools,
      builder,
      watcher,
      modules,
    });
  };

  // Subscribe BEFORE session/start so we don't miss the starting ->
  // running edge. The daemon publishes every event to every live
  // subscriber, so one subscription here covers every adapter.
  //
  // `onClose` / `onError` route into `notifyDisconnected` so an
  // unexpected daemon death surfaces as a 'disconnected' event on
  // every adapter (Phase 13.4 prereq #1). The 13.3 subscription had
  // no failure path — acceptable for the TUI (user can ctrl-C and
  // restart), not acceptable for Electron or long-lived MCP.
  const sub = await client.subscribe(
    { type: "command", action: "events/subscribe", id: idGen() },
    {
      onEvent: onIncomingEvent,
      onClose: () => notifyDisconnected(),
      onError: (err) => notifyDisconnected(err),
    },
  );

  const readyTimer = setTimeout(() => {
    rejectRunning?.(
      new Error(
        `connectToDaemonSession: session did not reach "running" within ${sessionReadyTimeoutMs}ms`,
      ),
    );
  }, sessionReadyTimeoutMs);

  let startPayload: { status?: string; code?: string; message?: string };
  try {
    const startResp = await client.send({
      type: "command",
      action: "session/start",
      id: idGen(),
      payload: { profile },
    });
    startPayload = startResp.payload as {
      status?: string;
      code?: string;
      message?: string;
    };
  } catch (err) {
    clearTimeout(readyTimer);
    sub.close();
    throw err;
  }

  if (startPayload.code) {
    clearTimeout(readyTimer);
    sub.close();
    throw new Error(
      `connectToDaemonSession: session/start rejected (${startPayload.code}): ${startPayload.message ?? ""}`,
    );
  }

  try {
    await runningPromise;
  } catch (err) {
    clearTimeout(readyTimer);
    sub.close();
    throw err;
  }
  clearTimeout(readyTimer);

  if (!worktreeKey) {
    sub.close();
    throw new Error(
      "connectToDaemonSession: session became running without emitting a worktreeKey",
    );
  }

  const disconnect = (): void => {
    if (closed) return;
    closed = true;
    voluntaryClose = true;
    sub.close();
  };

  const stop = async (): Promise<void> => {
    try {
      await client.send({
        type: "command",
        action: "session/stop",
        id: idGen(),
      });
    } finally {
      disconnect();
    }
  };

  return {
    client,
    metro,
    devtools,
    builder,
    watcher,
    modules,
    worktreeKey,
    disconnect,
    stop,
  };
}

/**
 * Runtime guard for the event envelopes the daemon pushes over
 * `events/subscribe`. Every variant of SessionEvent carries a string
 * `kind`, a string `worktreeKey`, and a `data` field. Anything else
 * is discarded rather than silently narrowed downstream (Kieran P1-3
 * on PR #17).
 */
function parseSessionEventEnvelope(
  payload: unknown,
): { kind: string; worktreeKey: string; data: unknown } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.kind !== "string" || typeof p.worktreeKey !== "string") {
    return null;
  }
  return { kind: p.kind, worktreeKey: p.worktreeKey, data: p.data };
}

function readStatus(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const v = (data as Record<string, unknown>).status;
  return typeof v === "string" ? v : null;
}

function routeEventToAdapters(
  kind: string | undefined,
  data: unknown,
  adapters: {
    metro: MetroClient;
    devtools: DevToolsClient;
    builder: BuilderClient;
    watcher: WatcherClient;
    modules: ModuleHostClient;
  },
): void {
  switch (kind) {
    case "metro/status":
    case "metro/log":
      adapters.metro.dispatch(kind, data);
      return;
    case "devtools/status":
    case "devtools/delta":
      adapters.devtools.dispatch(kind, data);
      return;
    case "builder/line":
    case "builder/progress":
    case "builder/done":
      adapters.builder.dispatch(kind, data);
      return;
    case "watcher/action-complete":
      adapters.watcher.dispatch(kind, data);
      return;
    case "modules/state-changed":
    case "modules/crashed":
    case "modules/failed":
      adapters.modules.dispatch(kind, data);
      return;
    default:
      // session/status + session/log stay in the subscribe stream's
      // raw form — callers that need them (Electron for status-bar
      // updates, MCP for log fan-out) subscribe via
      // `client.subscribe(...)` directly. Adding them here would
      // pull in a session-level adapter that no client consumes
      // uniformly today.
      return;
  }
}

function makeIdGenerator(): () => string {
  let n = 0;
  const base = Math.random().toString(36).slice(2, 8);
  return () => `rn-dev-tui-${base}-${n++}`;
}
