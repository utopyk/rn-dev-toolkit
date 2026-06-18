/**
 * WebSocket ingest for the redux module. One server per session, bound to
 * a Metro-paired port (`reduxPortForMetroPort`). The app's vendored
 * enhancer (P6) connects and streams one frame per dispatched action; the
 * server appends them into this session's `ReduxStore`.
 *
 * Session identity is IMPLICIT in the port: each session boot starts its
 * own ingest on `metroPort + REDUX_INGEST_PORT_OFFSET`, and the enhancer —
 * which knows the Metro host/port it loaded from via `getDevServer()` —
 * derives the same redux port. No announce/resolve handshake, no
 * cross-session routing: a connection on this port belongs to this
 * session, period. (Plan O1 resolved to per-session paired ports rather
 * than a daemon-singleton + resolver, to stay inside boot.ts's per-session
 * scope and avoid supervisor surgery.)
 *
 * SECURITY: every frame is untrusted external input from the running app.
 * Defensive parse (never throws out of the message handler), bounded
 * payload size at the WS layer, and the store applies its own per-value
 * caps. The server only ever appends JSON into an in-memory ring — no
 * eval, no fs, no command execution.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { ReduxStore } from "./buffer.js";
import type { ReduxIngestFrame } from "./types.js";

/**
 * Offset from a session's Metro port to its redux-ingest port. Metro
 * uses 8081–8099; +4000 → 12081–12099, clear of Metro, the devtools
 * proxy range, and common app ports. The enhancer hard-codes the same
 * offset so both ends agree without negotiation.
 */
export const REDUX_INGEST_PORT_OFFSET = 4000;

export function reduxPortForMetroPort(metroPort: number): number {
  return metroPort + REDUX_INGEST_PORT_OFFSET;
}

/** WS-layer max frame size. The store caps per-value at 256KB; this is a
 *  coarser guard so a hostile peer can't stream an unbounded single frame.
 *  16MB comfortably covers a large initial-state snapshot. */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export interface ReduxIngestOptions {
  port: number;
  store: ReduxStore;
  /** Store key for this session (the worktreeKey, matching MetroLogsStore). */
  sessionKey: string;
  /** Bind host. Default `0.0.0.0` so LAN devices + emulators reach it
   *  wherever Metro does. */
  host?: string;
  /** Optional log sink (daemon emit) for connect/error breadcrumbs. */
  onLog?: (message: string) => void;
}

interface HelloFrame {
  t: "hello";
  metroPort?: number;
  enhancerVersion?: string;
}
interface ActionFrame {
  t: "action";
  type: string;
  payload?: unknown;
  diff?: unknown;
  stateAfter?: unknown;
}

export class ReduxIngestServer {
  private wss: WebSocketServer | null = null;
  private readonly opts: ReduxIngestOptions;

  constructor(opts: ReduxIngestOptions) {
    this.opts = opts;
  }

  /** Bind the WS server. Resolves once listening (or rejects on EADDRINUSE). */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: this.opts.host ?? "0.0.0.0",
        port: this.opts.port,
        maxPayload: MAX_PAYLOAD_BYTES,
      });
      const onError = (err: Error): void => reject(err);
      wss.once("error", onError);
      wss.once("listening", () => {
        wss.off("error", onError);
        wss.on("error", (err) => this.log(`ingest error: ${err.message}`));
        wss.on("connection", (ws) => this.handleConnection(ws));
        this.wss = wss;
        this.log(`redux ingest listening on :${this.opts.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    if (!wss) return;
    this.wss = null;
    await new Promise<void>((resolve) => {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          /* ignore */
        }
      }
      wss.close(() => resolve());
    });
  }

  private handleConnection(ws: WebSocket): void {
    this.log("enhancer connected");
    ws.on("message", (data) => this.handleMessage(data));
    ws.on("error", () => {
      /* swallow — a misbehaving client must not crash the daemon */
    });
  }

  private handleMessage(data: unknown): void {
    let frame: unknown;
    try {
      const text =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : String(data);
      frame = JSON.parse(text);
    } catch {
      return; // malformed frame — drop silently
    }
    if (frame === null || typeof frame !== "object") return;
    const f = frame as { t?: unknown };
    if (typeof f.t !== "string") return;

    if (f.t === "hello") {
      // Fresh app/store connection: drop stale actions + bump epoch so
      // any holder's cursor goes stale (the app relaunched / re-attached).
      const hello = frame as HelloFrame;
      this.opts.store.clear(this.opts.sessionKey);
      this.log(
        `enhancer hello${hello.enhancerVersion ? ` v${hello.enhancerVersion}` : ""}`,
      );
      return;
    }

    if (f.t === "action") {
      const a = frame as ActionFrame;
      if (typeof a.type !== "string") return;
      const ingestFrame: ReduxIngestFrame = {
        type: a.type,
        payload: a.payload,
        diff: a.diff,
        stateAfter: a.stateAfter,
      };
      this.opts.store.append(this.opts.sessionKey, ingestFrame);
      return;
    }
    // Unknown frame type — ignore (forward-compat).
  }

  private log(message: string): void {
    this.opts.onLog?.(`[redux] ${message}`);
  }
}
