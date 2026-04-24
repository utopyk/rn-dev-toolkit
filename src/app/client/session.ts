// Client-side session orchestrator. One call from the TUI:
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

export interface DaemonSession {
  client: IpcClient;
  metro: MetroClient;
  devtools: DevToolsClient;
  builder: BuilderClient;
  watcher: WatcherClient;
  worktreeKey: string;
  /** Stops the session on the daemon and closes the event subscription. */
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

  let worktreeKey: string | null = null;
  let resolveRunning: (() => void) | null = null;
  let rejectRunning: ((err: Error) => void) | null = null;
  const runningPromise = new Promise<void>((res, rej) => {
    resolveRunning = res;
    rejectRunning = rej;
  });

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
    });
  };

  // Subscribe BEFORE session/start so we don't miss the starting ->
  // running edge. The daemon publishes every event to every live
  // subscriber, so one subscription here covers every adapter.
  const sub = await client.subscribe(
    { type: "command", action: "events/subscribe", id: idGen() },
    { onEvent: onIncomingEvent },
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

  const stop = async (): Promise<void> => {
    try {
      await client.send({
        type: "command",
        action: "session/stop",
        id: idGen(),
      });
    } finally {
      sub.close();
    }
  };

  return {
    client,
    metro,
    devtools,
    builder,
    watcher,
    worktreeKey,
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
  },
): void {
  switch (kind) {
    case "metro/status":
    case "metro/log":
      adapters.metro._dispatch(kind, data);
      return;
    case "devtools/status":
    case "devtools/delta":
      adapters.devtools._dispatch(kind, data);
      return;
    case "builder/line":
    case "builder/progress":
    case "builder/done":
      adapters.builder._dispatch(kind, data);
      return;
    case "watcher/action-complete":
      adapters.watcher._dispatch(kind, data);
      return;
    default:
      // session/status, session/log, modules/* — not fanned to adapters.
      // Callers that want these subscribe through client.subscribe
      // directly. 13.3 TUI doesn't need them.
      return;
  }
}

function makeIdGenerator(): () => string {
  let n = 0;
  const base = Math.random().toString(36).slice(2, 8);
  return () => `rn-dev-tui-${base}-${n++}`;
}
