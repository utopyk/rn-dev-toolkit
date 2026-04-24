// Client-side DevTools adapter. The daemon publishes `devtools/status`
// + `devtools/delta` over events/subscribe. The Network tap's entry
// snapshot is NOT pushed — clients call `listNetwork()` to re-query
// after a delta arrives (same pattern as the in-process manager: the
// delta announces identifiers, the list call resolves them).

import { EventEmitter } from "node:events";
import type { IpcClient } from "../../core/ipc.js";
import type {
  CaptureListResult,
  DevToolsStatus,
  NetworkEntry,
  NetworkFilter,
} from "../../core/devtools/types.js";

export interface DevToolsClientEvents {
  status: (evt: Record<string, unknown>) => void;
  delta: (evt: {
    addedIds: readonly string[];
    updatedIds: readonly string[];
    evictedIds: readonly string[];
  }) => void;
}

export class DevToolsClient extends EventEmitter {
  constructor(
    private client: IpcClient,
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

  _dispatch(kind: "devtools/status" | "devtools/delta", data: unknown): void {
    if (kind === "devtools/status") {
      this.emit("status", data);
    } else {
      this.emit("delta", data);
    }
  }
}
