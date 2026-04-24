// Client-side Metro adapter. Reproduces the slice of MetroManager that
// the TUI actually consumes, but against a daemon-side session over
// IpcClient. The daemon publishes `metro/status` / `metro/log` events
// on `events/subscribe` — the session orchestrator fans those into
// this adapter's emitter surface via `_dispatch`. Methods (reload,
// devMenu, getInstance) become async — they round-trip to the daemon.
//
// One daemon = one worktree = one session, so no worktreeKey threads
// through the adapter API. The original manager shape accepted one;
// dropping it at this layer forces client call sites to acknowledge the
// 1:1 relationship rather than carry a redundant identifier.

import { EventEmitter } from "node:events";
import type { IpcClient, IpcMessage } from "../../core/ipc.js";
import type { MetroInstance } from "../../core/types.js";

export interface MetroClientEvents {
  status: (evt: { status: string }) => void;
  log: (evt: { line: string; stream: "stdout" | "stderr" }) => void;
}

export class MetroClient extends EventEmitter {
  constructor(
    private client: IpcClient,
    private nextId: () => string,
  ) {
    super();
  }

  async reload(): Promise<boolean> {
    const resp = await this.client.send({
      type: "command",
      action: "metro/reload",
      id: this.nextId(),
    });
    return readOk(resp);
  }

  async devMenu(): Promise<boolean> {
    const resp = await this.client.send({
      type: "command",
      action: "metro/devMenu",
      id: this.nextId(),
    });
    return readOk(resp);
  }

  async getInstance(): Promise<MetroInstance | null> {
    const resp = await this.client.send({
      type: "command",
      action: "metro/getInstance",
      id: this.nextId(),
    });
    const p = resp.payload as { instance?: MetroInstance | null };
    return p?.instance ?? null;
  }

  /** Internal — the session orchestrator calls this when metro/* events arrive. */
  _dispatch(kind: "metro/status" | "metro/log", data: unknown): void {
    if (kind === "metro/status") {
      this.emit("status", data);
    } else {
      this.emit("log", data);
    }
  }
}

function readOk(resp: IpcMessage): boolean {
  const p = resp.payload as { ok?: boolean };
  return p?.ok === true;
}
