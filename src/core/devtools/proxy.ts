/**
 * CdpProxy — transparent WebSocket proxy between Fusebox (downstream) and
 * Metro's /inspector/debug endpoint (upstream).
 *
 * Transparency invariants (from plan §Proxy Contract):
 *   1. Frames forwarded in arrival order. No `await` between receive and
 *      forward on the wire path.
 *   2. Raw frame payloads forwarded untouched. JSON parsing happens on a
 *      clone for the tap path only — never on the bytes we forward.
 *   3. Command `id` namespacing: proxy-originated commands use ids
 *      >= 1_000_000_000. Their responses are swallowed, never forwarded.
 *   4. On upstream close the proxy closes downstream with code 1012 so
 *      Fusebox re-initialises its domains (prevents stale-breakpoint bugs).
 *   5. Bound to 127.0.0.1 only (security S2). Path nonce enforced
 *      via verifyClient (S3). Origin check (S8) also here.
 *
 * The proxy itself is reconnect-unaware — `DevToolsManager` owns the state
 * machine and decides when to start/stop proxies.
 */

import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { CdpCommand, CdpEvent, CdpResponse } from "./domain-tap.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Starting id for proxy-originated commands. Fusebox uses small positive ints. */
const PROXY_ID_BASE = 1_000_000_000;

/** Default per-command timeout when a tap calls sendCommand(). */
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;

/** WS close codes. */
const WS_CODE_SERVICE_RESTART = 1012;
const WS_CODE_GOING_AWAY = 1001;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CdpProxyOptions {
  /** Upstream CDP URL (e.g. `ws://localhost:8081/inspector/debug?device=...`). */
  upstreamUrl: string;
  /**
   * If true, `start()` opens upstream eagerly and resolves only after the
   * upstream handshake completes. If false (default), upstream opens lazily
   * on first downstream connect — matching the human flow where Fusebox
   * drives.
   */
  eagerUpstream?: boolean;
  /** Called for every non-proxy CDP event frame received from upstream. */
  onEvent?: (evt: CdpEvent) => void;
  /** Called when upstream open completes. */
  onUpstreamOpen?: () => void;
  /** Called when upstream closes (ours or theirs). */
  onUpstreamClose?: (code: number, reason: string) => void;
  /** Called on any non-fatal error (logged only). */
  onError?: (err: Error) => void;
  /** Restrict allowed `Origin` headers. Empty array = allow any (default). */
  allowedOrigins?: readonly string[];
}

export interface CdpProxyHandle {
  readonly port: number;
  readonly nonce: string;
  readonly isUpstreamOpen: boolean;
}

// ---------------------------------------------------------------------------
// CdpProxy
// ---------------------------------------------------------------------------

export class CdpProxy extends EventEmitter {
  private server: WebSocketServer | null = null;
  private upstream: WebSocket | null = null;
  private downstreams: Set<WebSocket> = new Set();
  private port = 0;
  private nonce = "";
  private nextCommandId = PROXY_ID_BASE;
  private pending = new Map<
    number,
    {
      resolve: (r: CdpResponse) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private started = false;
  private stopped = false;

  constructor(private readonly opts: CdpProxyOptions) {
    super();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<CdpProxyHandle> {
    if (this.started) throw new Error("CdpProxy already started");
    this.started = true;
    this.nonce = randomBytes(16).toString("hex");

    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: (info, cb) => {
        // Path nonce check (S3)
        const url = info.req.url ?? "";
        const expectedPath = `/proxy/${this.nonce}`;
        if (!url.startsWith(expectedPath)) {
          cb(false, 404, "Not Found");
          return;
        }
        // Origin check (S8)
        const allowed = this.opts.allowedOrigins;
        if (allowed && allowed.length > 0) {
          const origin = info.origin ?? "";
          if (!allowed.includes(origin)) {
            cb(false, 403, "Forbidden origin");
            return;
          }
        }
        cb(true);
      },
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.once("listening", () => {
        server.off("error", onError);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine proxy port");
    }
    this.port = address.port;

    server.on("connection", (ws, req) => {
      void req;
      this.handleDownstreamConnect(ws);
    });

    if (this.opts.eagerUpstream) {
      await this.connectUpstream();
    }

    return {
      port: this.port,
      nonce: this.nonce,
      isUpstreamOpen: this.upstream?.readyState === WebSocket.OPEN,
    };
  }

  /**
   * Explicitly open the upstream CDP connection. Useful when the manager
   * wants to begin capture before any Fusebox client connects. Idempotent.
   */
  async connectUpstream(): Promise<void> {
    if (this.upstream) return;
    await this.openUpstream();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    // Reject pending commands
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("proxy-stopped"));
    }
    this.pending.clear();

    // Intentional teardown: use terminate() so we don't block waiting on
    // close-handshake acks from either side. A graceful close is only
    // appropriate for transient disconnects (upstream drop → 1012), not for
    // manager-driven shutdown.
    for (const ws of this.downstreams) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
    this.downstreams.clear();

    if (this.upstream) {
      try {
        this.upstream.terminate();
      } catch {
        // ignore
      }
      this.upstream = null;
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  get handle(): CdpProxyHandle {
    return {
      port: this.port,
      nonce: this.nonce,
      isUpstreamOpen: this.upstream?.readyState === WebSocket.OPEN,
    };
  }

  // -------------------------------------------------------------------------
  // Commands (tap-facing)
  // -------------------------------------------------------------------------

  /**
   * Send a CDP command upstream. Response is delivered via returned Promise.
   * Proxy ids never reach downstream.
   */
  sendCommand(
    cmd: CdpCommand,
    timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS
  ): Promise<CdpResponse> {
    return new Promise<CdpResponse>((resolve, reject) => {
      if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) {
        reject(new Error("upstream-not-open"));
        return;
      }
      const id = this.nextCommandId++;
      const frame = JSON.stringify({ id, method: cmd.method, params: cmd.params ?? {} });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("command-timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.upstream.send(frame, (err) => {
          if (err) {
            const entry = this.pending.get(id);
            if (entry) {
              clearTimeout(entry.timer);
              this.pending.delete(id);
              reject(err);
            }
          }
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Downstream (Fusebox) socket handling
  // -------------------------------------------------------------------------

  private handleDownstreamConnect(ws: WebSocket): void {
    this.downstreams.add(ws);

    ws.on("error", (err) => {
      this.opts.onError?.(err);
    });

    ws.on("message", (data, isBinary) => {
      // Forward untouched (invariant #2). No parse, no await.
      if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) {
        // Upstream missing — drop silently. Downstream will time out and
        // retry; manager decides how to recover.
        return;
      }
      try {
        this.upstream.send(data, { binary: isBinary }, (err) => {
          if (err) {
            // Forwarding to upstream failed — close the offending downstream.
            try {
              ws.close(WS_CODE_GOING_AWAY, "upstream-send-failed");
            } catch {
              // ignore
            }
          }
        });
      } catch (err) {
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    });

    ws.on("close", () => {
      this.downstreams.delete(ws);
    });

    // Ensure upstream is open. Fire-and-forget — frames arrive only after
    // upstream ready. The rejection MUST be caught here: openUpstream's
    // promise rejects when the upstream URL is unreachable (e.g. the
    // `/inspector/no-target` placeholder used by `DevToolsManager` while
    // no Hermes target is selected). Pre-fix this surfaced as an
    // unhandled rejection that crashed the daemon process under Bun's
    // default (--unhandled-rejections=throw equivalent), taking the IPC
    // socket with it. Errors are still reported through `onError`; the
    // downstream WS sees the upstream `close` event and can reconnect.
    if (!this.upstream) {
      this.openUpstream().catch(() => {
        // intentionally swallowed — see comment above
      });
    }
  }

  // -------------------------------------------------------------------------
  // Upstream (Metro) socket handling
  // -------------------------------------------------------------------------

  private openUpstream(): Promise<void> {
    if (this.upstream) return Promise.resolve();
    const upstream = new WebSocket(this.opts.upstreamUrl);
    this.upstream = upstream;

    const openPromise = new Promise<void>((resolve, reject) => {
      upstream.once("open", () => {
        upstream.off("error", onErr);
        this.opts.onUpstreamOpen?.();
        resolve();
      });
      const onErr = (err: Error) => {
        upstream.off("open", resolve);
        reject(err);
      };
      upstream.once("error", onErr);
    });

    upstream.on("message", (data, isBinary) => {
      this.handleUpstreamFrame(data, isBinary);
    });

    upstream.on("close", (code, reasonBuf) => {
      const reason = reasonBuf?.toString?.() ?? "";
      this.upstream = null;
      // Reject all in-flight proxy commands
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("upstream-closed"));
      }
      this.pending.clear();
      // Close downstreams with 1012 (service restart) — forces Fusebox to
      // re-initialise its domains (plan §State Lifecycle Risks).
      for (const ws of this.downstreams) {
        try {
          ws.close(WS_CODE_SERVICE_RESTART, "upstream-closed");
        } catch {
          // ignore
        }
      }
      this.downstreams.clear();
      this.opts.onUpstreamClose?.(code, reason);
    });

    upstream.on("error", (err) => {
      this.opts.onError?.(err);
    });

    return openPromise;
  }

  private handleUpstreamFrame(data: RawData, isBinary: boolean): void {
    // 1) Forward the raw payload to every connected downstream, in order,
    //    synchronously. No await.
    for (const ws of this.downstreams) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(data, { binary: isBinary });
      } catch {
        // send failures become visible via 'close' on the socket; ignore here
      }
    }

    if (isBinary) return; // Binary frames don't participate in CDP routing.

    // 2) Tap path — parse a string clone for event dispatch + command replies.
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof Buffer) {
      text = data.toString("utf8");
    } else if (Array.isArray(data)) {
      text = Buffer.concat(data).toString("utf8");
    } else {
      text = Buffer.from(data as ArrayBuffer).toString("utf8");
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // non-JSON frames are ignored on the tap path
    }

    const id = parsed.id;
    if (typeof id === "number") {
      if (id >= PROXY_ID_BASE) {
        // Proxy-originated response: resolve and swallow (don't re-forward;
        // it was already forwarded above, but Fusebox won't match it since
        // the id is outside its range — Fusebox ignores unknown ids).
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          entry.resolve({
            id,
            result: parsed.result as Record<string, unknown> | undefined,
            error: parsed.error as CdpResponse["error"],
          });
        }
      }
      // Fusebox-originated response: nothing to do — already forwarded.
      return;
    }

    // Event: { method, params } without id
    const method = parsed.method;
    if (typeof method === "string") {
      const params = (parsed.params as Record<string, unknown>) ?? {};
      try {
        this.opts.onEvent?.({ method, params });
      } catch (err) {
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}
