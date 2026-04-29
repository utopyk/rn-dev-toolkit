// Client-side Session adapter. The daemon publishes `session/log` and
// `session/status` over events/subscribe — these used to be silently
// dropped in `routeEventToAdapters`'s default arm because no client
// adapter consumed them, leaving the user/agent with no visibility into
// `bootSessionServices` progress (preflight, install, watchman setup,
// port-kill, simulator boot — every step the daemon emits as a
// `session/log` line at supervisor.ts:425).
//
// After Bug 6: this adapter is published as `DaemonSession.lifecycle`
// (the field name reflects what these events represent — state-machine
// transitions and the boot-progress narration that drives them) and
// every client (MCP, Electron renderer, TUI) subscribes to its
// `log`/`status` events to surface daemon-side progress at its own
// UI/agent surface.
//
// No RPCs — sessions are managed via `session/start` / `session/stop`
// on the raw `IpcSender`, plus the lifecycle methods on `DaemonSession`
// itself. This adapter is strictly an event dispatcher, parallel with
// metro/devtools/etc. but without the round-trip query API.

import { EventEmitter } from "node:events";
import type { AdapterSink, SessionEventKind } from "./adapter-sink.js";

/**
 * Shape of `data` on the daemon's wire `session/log` event. Mirrors
 * `SessionLogEvent['data']` from `src/daemon/session.ts:182-186` — kept
 * structurally compatible (don't widen the level union) so a future
 * shared-types refactor is mechanical. Includes a client-stamped
 * `ts` (ms-since-epoch) added on dispatch.
 *
 * `level` mirrors the daemon's literal union exactly. Truncation of
 * `message` happens at the dispatch boundary — see `MAX_MESSAGE_LENGTH`.
 */
export interface SessionLogEvent {
  level: "info" | "warn" | "error";
  message: string;
  /**
   * Client-stamped arrival time. Stamped at `dispatch()` (one moment
   * per event), not at backfill replay. The daemon's wire envelope
   * carries no `ts` today, so this captures "when the SessionClient
   * received the event" — close to but not identical to "when the
   * daemon emitted it." A future daemon-side `ts` field would
   * supersede this; downstream consumers should treat the field as
   * advisory.
   */
  ts: number;
}

export interface SessionStatusEvent {
  status: string;
}

/**
 * Per-line message length cap. Prevents a hostile or buggy daemon (or
 * a third-party module hooking `bootSessionServices.emit`) from
 * pushing megabyte-class strings into the ring, which would then live
 * for the lifetime of every attached client. 8 KB easily covers a
 * full stack trace; anything beyond is symptomatic of a bug elsewhere.
 * Security P1-2 on PR #27.
 */
const MAX_MESSAGE_LENGTH = 8 * 1024;

/** Default cap on the in-memory log ring — see `SessionClient` doc. */
const DEFAULT_LOG_RING_SIZE = 200;

/**
 * Runtime guard for the daemon's `session/log` payload. The wire is
 * `unknown` and the cast-then-trust pattern (mirroring DevToolsClient
 * dispatch) is safe enough when only one consumer pulls from the
 * adapter, but `lifecycle.log` events feed THREE clients (MCP, Electron,
 * TUI) — a malformed payload would write `undefined` into all three.
 * Validate + coerce at the dispatch boundary so every consumer sees
 * the same well-formed shape. Architecture + Security P1 on PR #27.
 */
function parseSessionLogPayload(data: unknown): SessionLogEvent {
  if (!data || typeof data !== "object") {
    return { level: "info", message: "", ts: Date.now() };
  }
  const p = data as Record<string, unknown>;
  const rawLevel = typeof p.level === "string" ? p.level : "info";
  const level: SessionLogEvent["level"] =
    rawLevel === "warn" || rawLevel === "error" ? rawLevel : "info";
  const rawMessage = typeof p.message === "string" ? p.message : "";
  const message =
    rawMessage.length > MAX_MESSAGE_LENGTH
      ? rawMessage.slice(0, MAX_MESSAGE_LENGTH)
      : rawMessage;
  return { level, message, ts: Date.now() };
}

function parseSessionStatusPayload(data: unknown): SessionStatusEvent {
  if (!data || typeof data !== "object") return { status: "" };
  const p = data as Record<string, unknown>;
  return { status: typeof p.status === "string" ? p.status : "" };
}

export class SessionClient
  extends EventEmitter
  implements AdapterSink<SessionEventKind>
{
  /**
   * In-memory ring buffer of recent `session/log` events, populated by
   * `dispatch()` and snapshot-readable via `recentLogs()`. The ring
   * exists because daemon-emitted boot progress fires DURING
   * `connectToDaemonSession` — between the `events/subscribe` ACK and
   * the `session/status: running` edge that resolves the await — so
   * any caller that adds an `on("log", ...)` listener AFTER
   * `connectToDaemonSession` returns races the events. Without the
   * ring those listeners would silently miss every boot-time log line
   * (which is exactly what an MCP server, an Electron renderer
   * subscribing post-connect, or a TUI would do).
   *
   * The fix is buffer-on-dispatch: every log event lands in the ring
   * regardless of whether anyone is subscribed yet. Late attachers
   * call `recentLogs()` to snapshot, then attach `on("log", ...)`
   * — Node's EventEmitter is synchronous, so no event can land
   * between the snapshot returning and the listener attaching.
   */
  private readonly logRing: SessionLogEvent[] = [];
  private readonly logRingSize: number;

  constructor(opts: { logRingSize?: number } = {}) {
    super();
    // No `IpcSender` argument — sessions have no per-adapter RPC; the
    // session lifecycle (start/stop/release) lives on `DaemonSession`
    // itself, not here. This adapter is purely an event sink.
    this.logRingSize = opts.logRingSize ?? DEFAULT_LOG_RING_SIZE;
  }

  dispatch(kind: SessionEventKind, data: unknown): void {
    if (kind === "session/log") {
      const evt = parseSessionLogPayload(data);
      this.logRing.push(evt);
      if (this.logRing.length > this.logRingSize) {
        this.logRing.shift();
      }
      this.emit("log", evt);
    } else {
      this.emit("status", parseSessionStatusPayload(data));
    }
  }

  /**
   * Snapshot of the in-memory log ring. Returned as a defensive copy
   * so callers iterating over the result during a subsequent dispatch
   * don't observe mid-mutation state.
   */
  recentLogs(): readonly SessionLogEvent[] {
    return this.logRing.slice();
  }

  notifyDisconnected(err?: Error): void {
    this.emit("disconnected", err);
  }
}
