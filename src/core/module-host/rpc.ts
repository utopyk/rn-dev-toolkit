import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import type { CapabilityDescriptor } from "./capabilities.js";

export interface ModuleRpcOptions {
  readable: NodeJS.ReadableStream;
  writable: NodeJS.WritableStream;
}

/**
 * Thin typed wrapper over `vscode-jsonrpc`'s `MessageConnection` with
 * stdio Content-Length framing. Symmetric — the same class powers both
 * the host side (host-side of a child_process.spawn) and the module side
 * (inside the subprocess, bound to process.stdin / process.stdout).
 */
export class ModuleRpc {
  private readonly connection: MessageConnection;
  private disposed = false;

  constructor(options: ModuleRpcOptions) {
    const reader = new StreamMessageReader(options.readable);
    const writer = new StreamMessageWriter(options.writable);
    this.connection = createMessageConnection(reader, writer);
  }

  listen(): void {
    this.connection.listen();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connection.dispose();
  }

  onRequest<P, R>(
    method: string,
    handler: (params: P) => R | Promise<R>,
  ): void {
    this.connection.onRequest(method, (params) =>
      handler(params as P) as R | Promise<R>,
    );
  }

  onNotification<P>(method: string, handler: (params: P) => void): void {
    this.connection.onNotification(method, (params) => {
      handler(params as P);
    });
  }

  sendRequest<P, R>(method: string, params: P): Promise<R> {
    return this.connection.sendRequest<R>(method, params);
  }

  sendNotification<P>(method: string, params: P): void {
    void this.connection.sendNotification(method, params);
  }
}

// ---------------------------------------------------------------------------
// initialize handshake
// ---------------------------------------------------------------------------

export interface InitializeParams {
  capabilities: CapabilityDescriptor[];
  hostVersion: string;
  /**
   * Persisted per-module config blob, loaded by the host from
   * `~/.rn-dev/modules/<id>/config.json` before the handshake. Always
   * present — modules without a `contributes.config.schema` still see
   * `{}`. Runtime updates arrive via the `config/changed` notification.
   */
  config: Record<string, unknown>;
}

export interface InitializeResult {
  moduleId: string;
  /** Number of MCP tools the module is ready to expose. Informational. */
  toolCount?: number;
  /** Module-reported SDK version for compat gate. */
  sdkVersion?: string;
  /** Arbitrary module-reported fields; host logs but does not act on these. */
  [key: string]: unknown;
}

export class ActivationTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`MODULE_ACTIVATION_TIMEOUT: module did not respond to 'initialize' within ${timeoutMs}ms`);
    this.name = "ActivationTimeoutError";
  }
}

export interface PerformInitializeOptions extends InitializeParams {
  timeoutMs: number;
}

/**
 * Send `initialize` to the module and resolve with the module's reply, or
 * reject with `ActivationTimeoutError` after `timeoutMs`.
 *
 * This is the host-driven half of the handshake: host → module 'initialize'
 * with capability list + host version; module → host returns an
 * `InitializeResult` describing what it contributes.
 */
export async function performInitialize(
  rpc: ModuleRpc,
  options: PerformInitializeOptions,
): Promise<InitializeResult> {
  const { timeoutMs, ...params } = options;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ActivationTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    const result = await Promise.race([
      rpc.sendRequest<InitializeParams, InitializeResult>("initialize", params),
      timeout,
    ]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
