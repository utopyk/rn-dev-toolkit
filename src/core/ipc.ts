import net from "node:net";
import { EventEmitter } from "node:events";
import { existsSync, unlinkSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IpcMessage {
  /** "command" | "response" | "event" */
  type: string;
  /** "reload", "dev-menu", "clean", "status", etc. */
  action: string;
  payload?: unknown;
  /** Unique message id for request/response matching */
  id: string;
}

export interface IpcMessageEvent {
  message: IpcMessage;
  reply: (response: IpcMessage) => void;
  /**
   * Register a callback invoked when the underlying socket closes.
   *
   * Request/response handlers generally ignore this — the socket is closed
   * by the client after it receives its reply. Subscription-style handlers
   * (e.g. `modules/subscribe`) use it to detach listeners so the daemon
   * doesn't leak subscribers once the MCP server disconnects.
   *
   * Listeners fire exactly once per socket close; throwing inside one does
   * NOT prevent the remaining listeners from running.
   */
  onClose: (listener: () => void) => void;
  /**
   * Stable id for the underlying socket. All `IpcMessageEvent`s emitted
   * from the same accepted connection share this id; closed and
   * subsequently-reopened connections get distinct ids. Used by the daemon
   * to track per-connection state (Phase 13.5 ref-counted sessions, module
   * sender bindings) without leaking the raw `net.Socket` to handlers.
   */
  connectionId: string;
}

// ---------------------------------------------------------------------------
// IpcServer
// ---------------------------------------------------------------------------

export class IpcServer extends EventEmitter {
  private server: net.Server | null = null;
  /** Monotonic counter feeding `connectionId`. Wraps in practice never. */
  private nextConnectionSeq = 1;

  constructor(private socketPath: string) {
    super();
  }

  /**
   * Start the Unix domain socket server.
   * Removes any stale socket file before binding.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Remove stale socket file if it exists
      if (existsSync(this.socketPath)) {
        try {
          unlinkSync(this.socketPath);
        } catch {
          // ignore — may have already been removed by another process
        }
      }

      const srv = net.createServer((socket) => {
        const connectionId = `c${this.nextConnectionSeq++}`;
        let buffer = "";
        const closeListeners: Array<() => void> = [];

        socket.setEncoding("utf8");

        socket.on("data", (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          // Keep incomplete last chunk in buffer
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let message: IpcMessage;
            try {
              message = JSON.parse(trimmed) as IpcMessage;
            } catch {
              // Malformed JSON — skip
              continue;
            }

            const reply = (response: IpcMessage): void => {
              if (!socket.destroyed) {
                socket.write(JSON.stringify(response) + "\n");
              }
            };

            const onClose = (listener: () => void): void => {
              closeListeners.push(listener);
            };

            this.emit("message", {
              message,
              reply,
              onClose,
              connectionId,
            } satisfies IpcMessageEvent);
          }
        });

        socket.on("error", () => {
          // Individual connection errors are non-fatal for the server
        });

        socket.on("close", () => {
          for (const listener of closeListeners) {
            try {
              listener();
            } catch {
              // Subscribers' cleanup shouldn't crash the server.
            }
          }
        });
      });

      srv.on("error", (err) => {
        reject(err);
      });

      srv.listen(this.socketPath, () => {
        this.server = srv;
        resolve();
      });
    });
  }

  /**
   * Stop the server and remove the socket file.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        this.server = null;

        if (existsSync(this.socketPath)) {
          try {
            unlinkSync(this.socketPath);
          } catch {
            // ignore
          }
        }

        resolve();
      });

      // Destroy all open connections so close() resolves promptly
      // (net.Server.close() only stops accepting new connections by default)
      (this.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();

      // Belt-and-suspenders: Bun's Node net compat occasionally leaves
      // closeAllConnections() as a no-op on still-pending sockets, and
      // server.close()'s callback then never fires. Force-resolve after
      // a short grace period — the unlink + null assignment idempotent.
      setTimeout(() => {
        if (this.server) {
          this.server = null;
          if (existsSync(this.socketPath)) {
            try {
              unlinkSync(this.socketPath);
            } catch {
              /* ignore */
            }
          }
          resolve();
        }
      }, 500);
    });
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }
}

// ---------------------------------------------------------------------------
// IpcClient
// ---------------------------------------------------------------------------

const CLIENT_TIMEOUT_MS = 5_000;

export class IpcClient {
  constructor(private socketPath: string) {}

  /**
   * Send a message to the running TUI and wait for a response.
   * Rejects with a timeout error if no response arrives within 5 seconds.
   */
  send(message: IpcMessage): Promise<IpcMessage> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);

      let buffer = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`IPC timeout: no response received within ${CLIENT_TIMEOUT_MS}ms`));
      }, CLIENT_TIMEOUT_MS);

      socket.setEncoding("utf8");

      socket.on("connect", () => {
        socket.write(JSON.stringify(message) + "\n");
      });

      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let response: IpcMessage;
          try {
            response = JSON.parse(trimmed) as IpcMessage;
          } catch {
            continue;
          }

          // Match response to our request by id
          if (response.id === message.id) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(response);
            return;
          }
        }
      });

      socket.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      socket.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("IPC connection closed before response was received"));
      });
    });
  }

  /**
   * Open a long-lived subscription on the IPC socket.
   *
   * The flow: write `message` once, then parse every line that comes back.
   * The first line whose `id` matches is the subscription confirmation and
   * resolves the promise. Every subsequent line is passed to `onEvent`.
   *
   * Unlike `send`, the returned socket stays open until the caller invokes
   * `handle.close()` (or the server disconnects). Use for event streams
   * like `modules/subscribe`; use `send()` for request/response calls.
   */
  subscribe(
    message: IpcMessage,
    options: {
      onEvent: (event: IpcMessage) => void;
      onError?: (err: Error) => void;
      onClose?: () => void;
    },
  ): Promise<{ initial: IpcMessage; close: () => void }> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      let confirmed = false;
      let closed = false;

      const close = (): void => {
        if (closed) return;
        closed = true;
        socket.destroy();
      };

      socket.setEncoding("utf8");

      socket.on("connect", () => {
        socket.write(JSON.stringify(message) + "\n");
      });

      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let parsed: IpcMessage;
          try {
            parsed = JSON.parse(trimmed) as IpcMessage;
          } catch {
            continue;
          }

          // Only the `response` matching the subscribe id confirms the
          // subscription. The daemon may push `event`-typed messages
          // sharing the same id (events/subscribe used the request id
          // as the subscription id) BEFORE the response if the
          // handler registers its event listener early — Phase 13.5
          // tightens this to avoid a race where the first event was
          // mistaken for the confirmation.
          if (
            !confirmed &&
            parsed.id === message.id &&
            parsed.type === "response"
          ) {
            confirmed = true;
            resolve({ initial: parsed, close });
            continue;
          }

          try {
            options.onEvent(parsed);
          } catch (err) {
            options.onError?.(
              err instanceof Error ? err : new Error(String(err)),
            );
          }
        }
      });

      socket.on("error", (err) => {
        if (!confirmed) {
          reject(err);
          return;
        }
        options.onError?.(err);
      });

      socket.on("close", () => {
        if (!confirmed) {
          reject(new Error("IPC subscribe: connection closed before confirmation"));
          return;
        }
        if (!closed) {
          closed = true;
        }
        options.onClose?.();
      });
    });
  }

  /**
   * Check whether a TUI server is currently reachable on the socket path.
   */
  isServerRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!existsSync(this.socketPath)) {
        resolve(false);
        return;
      }

      const socket = net.createConnection(this.socketPath);

      const cleanup = (result: boolean): void => {
        socket.destroy();
        resolve(result);
      };

      socket.on("connect", () => cleanup(true));
      socket.on("error", () => cleanup(false));
    });
  }
}
