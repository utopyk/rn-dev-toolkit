// Client-side DevTools adapter. The daemon publishes `devtools/status`
// + `devtools/delta` over events/subscribe. The Network tap's entry
// snapshot is NOT pushed — clients call `listNetwork()` to re-query
// after a delta arrives (same pattern as the in-process manager: the
// delta announces identifiers, the list call resolves them).

import { EventEmitter } from "node:events";
import type {
  CaptureListResult,
  DevToolsStatus,
  NetworkEntry,
  NetworkFilter,
} from "../../core/devtools/types.js";
import type { AdapterSink, DevToolsEventKind } from "./adapter-sink.js";
import type { IpcSender } from "./session.js";

export interface DevToolsClientEvents {
  status: (evt: Record<string, unknown>) => void;
  delta: (evt: {
    addedIds: readonly string[];
    updatedIds: readonly string[];
    evictedIds: readonly string[];
  }) => void;
  /** Fires once on unexpected daemon death (Phase 13.4 prereq #1). */
  disconnected: (err?: Error) => void;
}

export class DevToolsClient
  extends EventEmitter
  implements AdapterSink<DevToolsEventKind>
{
  constructor(
    private client: IpcSender,
    private nextId: () => string,
  ) {
    super();
  }

  /**
   * Round-trips to the daemon's DevToolsManager.listNetwork. The
   * daemon returns a real `CaptureListResult<NetworkEntry>` which
   * JSON-serializes losslessly — the adapter preserves the typing
   * here so React consumers in AppContext don't have to launder the
   * response through a second `as unknown as` cast (Kieran P1-4 /
   * P1-5 on PR #17).
   */
  async listNetwork(
    filter?: NetworkFilter,
  ): Promise<CaptureListResult<NetworkEntry>> {
    const resp = await this.client.send({
      type: "command",
      action: "devtools/listNetwork",
      id: this.nextId(),
      payload: filter !== undefined ? { filter } : undefined,
    });
    return resp.payload as CaptureListResult<NetworkEntry>;
  }

  async status(): Promise<DevToolsStatus> {
    const resp = await this.client.send({
      type: "command",
      action: "devtools/status",
      id: this.nextId(),
    });
    return resp.payload as DevToolsStatus;
  }

  async clear(): Promise<void> {
    await this.client.send({
      type: "command",
      action: "devtools/clear",
      id: this.nextId(),
    });
  }

  async selectTarget(targetId: string): Promise<void> {
    const resp = await this.client.send({
      type: "command",
      action: "devtools/selectTarget",
      id: this.nextId(),
      payload: { targetId },
    });
    const p = resp.payload as { ok?: boolean; code?: string; message?: string };
    if (p?.code) {
      throw new Error(`devtools/selectTarget: ${p.code}: ${p.message ?? ""}`);
    }
  }

  /**
   * Stop + re-start the daemon's DevTools proxy for this session — used
   * by the Electron "Reconnect" button when the manager landed in
   * `no-target` and the user wants to rediscover targets after the app
   * launches. Returns the new `{proxyPort, sessionNonce}` so the
   * renderer can re-splice Fusebox's `ws=` URL.
   */
  async restart(): Promise<{ proxyPort: number; sessionNonce: string }> {
    const resp = await this.client.send({
      type: "command",
      action: "devtools/restart",
      id: this.nextId(),
    });
    // Mirror selectTarget's `p?.code` pattern + add a malformed-response
    // guard so a daemon that ever returns null/undefined doesn't trip
    // `'code' in p` with a TypeError, and so the renderer can't splice
    // `undefined` into Fusebox's `ws=` URL on a malformed reply.
    // Kieran TS P1-1 on PR #26.
    const p = resp.payload as
      | {
          proxyPort?: number;
          sessionNonce?: string;
          code?: string;
          message?: string;
        }
      | null
      | undefined;
    if (p?.code) {
      throw new Error(`devtools/restart: ${p.code}: ${p.message ?? ""}`);
    }
    if (typeof p?.proxyPort !== "number" || typeof p?.sessionNonce !== "string") {
      throw new Error("devtools/restart: malformed daemon response");
    }
    return { proxyPort: p.proxyPort, sessionNonce: p.sessionNonce };
  }

  dispatch(kind: DevToolsEventKind, data: unknown): void {
    if (kind === "devtools/status") {
      this.emit("status", data);
    } else {
      this.emit("delta", data);
    }
  }

  notifyDisconnected(err?: Error): void {
    this.emit("disconnected", err);
  }
}
