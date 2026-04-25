// Client-side session orchestrator. One call from the TUI/Electron:
//   `await connectToDaemonSession(projectRoot, profile)`
// returns a live `DaemonSession` where every adapter already has its
// IpcClient reference, a shared event subscription is open, and events
// are routed to the matching adapter as they arrive.
//
// Lifecycle:
//   - `connectToDaemon` ensures a daemon is running at
//     <projectRoot>/.rn-dev/sock (auto-spawns if not).
//   - `events/subscribe { profile }` opens a single long-lived socket
//     that holds the daemon's session refcount. The daemon boots the
//     session if stopped, joins if running with matching profile,
//     rejects on profile mismatch.
//   - Callers await the "running" transition before treating the
//     session as usable — the daemon's attach response includes the
//     starting/running status edge so joiners short-circuit cleanly.
//   - `stop()` issues `session/stop` (kill-for-everyone) then closes.
//   - `release()` / `disconnect()` close the subscription socket; the
//     daemon's socket-close auto-release decrements the refcount, and
//     last-release triggers a session teardown.
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
   * Phase 13.5 trichotomy of session-end methods:
   *   - `disconnect()` / `release()` — close the subscribe socket. The
   *     daemon's socket-close auto-release decrements its session
   *     refcount; last-release triggers teardown. Today these are
   *     observably equivalent (no separate wire RPC); `release()` is
   *     kept as the semantic name shared-daemon callers should reach
   *     for, and is the call site where a future audit-log RPC will
   *     hook in.
   *   - `stop()` — kill-for-everyone. Sends `session/stop` regardless
   *     of refcount, tearing the session down for every attached
   *     client. The CLI's "quit the TUI" flow uses this when the user
   *     actually means "return the daemon to idle."
   *
   * All three are idempotent; safe to call after the daemon already
   * died.
   */
  disconnect: () => void;
  release: () => Promise<void>;
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
  let resolveRunning!: () => void;
  let rejectRunning!: (err: Error) => void;
  const runningPromise = new Promise<void>((res, rej) => {
    resolveRunning = res;
    rejectRunning = rej;
  });
  // The eager catch silences `runningPromise` rejections when the
  // function throws BEFORE `await runningPromise` runs (e.g. subscribe
  // rejected, or notifyDisconnected fires from the subscribe socket
  // close before we reach the await). Attaching here ensures Node's
  // unhandled-rejection detector always sees a handler. The await
  // chain below attaches its own handler when reached, so legitimate
  // rejections still surface to the caller.
  runningPromise.catch(() => {
    /* see comment above */
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
    rejectRunning(
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
        resolveRunning();
      } else if (status === "stopped" || status === "stopping") {
        rejectRunning(
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

  // Phase 13.5 — refcount lives on the events/subscribe socket. The
  // profile travels in the subscribe payload so the daemon boots or
  // joins the session in a single round-trip. `onClose` / `onError`
  // route into `notifyDisconnected` so an unexpected daemon death
  // surfaces as a 'disconnected' event on every adapter.
  const sub = await client.subscribe(
    {
      type: "command",
      action: "events/subscribe",
      id: idGen(),
      payload: { profile },
    },
    {
      onEvent: onIncomingEvent,
      onClose: () => notifyDisconnected(),
      onError: (err) => notifyDisconnected(err),
    },
  );

  const subPayload = parseSubscribeResponse(sub.initial.payload);
  if (!subPayload.subscribed) {
    sub.close();
    throw new Error(
      `connectToDaemonSession: events/subscribe rejected (${subPayload.code ?? "unknown"}): ${subPayload.message ?? ""}`,
    );
  }

  const readyTimer = setTimeout(() => {
    rejectRunning(
      new Error(
        `connectToDaemonSession: session did not reach "running" within ${sessionReadyTimeoutMs}ms`,
      ),
    );
  }, sessionReadyTimeoutMs);

  // Joiner: session was already running before we attached → no
  // "running" edge will recur, so resolve the gate now and backfill
  // worktreeKey via session/status.
  if (subPayload.status === "running" && subPayload.started === false) {
    if (!worktreeKey) {
      try {
        const statusResp = await client.send({
          type: "command",
          action: "session/status",
          id: idGen(),
        });
        const wk = parseStatusResponse(statusResp.payload).worktreeKey;
        if (wk) worktreeKey = wk;
      } catch {
        // Backfill is best-effort — the next event will populate it.
      }
    }
    resolveRunning();
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

  const release = async (): Promise<void> => {
    // Phase 13.5 — close the subscribe socket; the daemon's
    // socket-close auto-release decrements its session refcount and
    // tears the session down if we were the last attacher. Kept as a
    // distinct method (vs `disconnect()`) so a future audit-log RPC
    // can hook in here without callers having to migrate.
    disconnect();
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
    release,
    stop,
  };
}

/**
 * Phase 13.5 — runtime parser for the daemon's events/subscribe
 * response. The wire is `unknown` so type assertions would let a
 * malicious or buggy daemon return wrong-typed fields and have them
 * pass through to the joiner short-circuit unchecked. Mirrors the
 * existing `parseSessionEventEnvelope` discipline.
 */
interface SubscribeAck {
  subscribed: true;
  status?: "stopped" | "starting" | "running" | "stopping";
  started?: boolean;
  attached?: number;
}
interface SubscribeReject {
  subscribed: false;
  code?: string;
  message?: string;
}
function parseSubscribeResponse(
  payload: unknown,
): SubscribeAck | SubscribeReject {
  if (!payload || typeof payload !== "object") {
    return { subscribed: false };
  }
  const p = payload as Record<string, unknown>;
  if (p.subscribed !== true) {
    return {
      subscribed: false,
      code: typeof p.code === "string" ? p.code : undefined,
      message: typeof p.message === "string" ? p.message : undefined,
    };
  }
  return {
    subscribed: true,
    status:
      p.status === "stopped" ||
      p.status === "starting" ||
      p.status === "running" ||
      p.status === "stopping"
        ? p.status
        : undefined,
    started: typeof p.started === "boolean" ? p.started : undefined,
    attached: typeof p.attached === "number" ? p.attached : undefined,
  };
}

function parseStatusResponse(payload: unknown): { worktreeKey?: string } {
  if (!payload || typeof payload !== "object") return {};
  const p = payload as Record<string, unknown>;
  return {
    worktreeKey: typeof p.worktreeKey === "string" ? p.worktreeKey : undefined,
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
