// Client-side Metro adapter. Reproduces the slice of MetroManager that
// the TUI actually consumes, but against a daemon-side session over
// IpcClient. The daemon publishes `metro/status` / `metro/log` events
// on `events/subscribe` — the session orchestrator fans those into
// this adapter's emitter surface via `dispatch`. Methods (reload,
// devMenu, getInstance) become async — they round-trip to the daemon.
//
// One daemon = one worktree = one session, so no worktreeKey threads
// through the adapter API. The original manager shape accepted one;
// dropping it at this layer forces client call sites to acknowledge the
// 1:1 relationship rather than carry a redundant identifier.

import { EventEmitter } from "node:events";
import type { IpcMessage } from "../../core/ipc.js";
import type { MetroInstance } from "../../core/types.js";
import type { SessionId } from "../../core/identifiers.js";
import type { AdapterSink, MetroEventKind } from "./adapter-sink.js";
import type { IpcSender } from "./session.js";

export interface MetroClientEvents {
  status: (evt: { status: string }) => void;
  log: (evt: { line: string; stream: "stdout" | "stderr" }) => void;
  /**
   * Fires once when the daemon socket drops unexpectedly. Voluntary
   * `disconnect()` / `stop()` do NOT fire it — only a crash / SIGKILL
   * / host loss (Phase 13.4 prereq #1).
   */
  disconnected: (err?: Error) => void;
}

export class MetroClient extends EventEmitter implements AdapterSink<MetroEventKind> {
  constructor(
    private client: IpcSender,
    private nextId: () => string,
    // Phase E wire-contract follow-on — under N>1 sessions the daemon's
    // resolveSessionServices rejects payload-less RPCs with E_SESSION_AMBIGUOUS.
    // See builder-adapter.ts for the full rationale.
    private getSessionId: () => SessionId | null = () => null,
  ) {
    super();
  }

  private payloadWithSession(extra?: Record<string, unknown>): Record<string, unknown> | undefined {
    const sessionId = this.getSessionId();
    if (sessionId === null) return extra;
    return { ...(extra ?? {}), sessionId };
  }

  async reload(): Promise<boolean> {
    const resp = await this.client.send({
      type: "command",
      action: "metro/reload",
      id: this.nextId(),
      payload: this.payloadWithSession(),
    });
    return readOk(resp);
  }

  async devMenu(): Promise<boolean> {
    const resp = await this.client.send({
      type: "command",
      action: "metro/devMenu",
      id: this.nextId(),
      payload: this.payloadWithSession(),
    });
    return readOk(resp);
  }

  async getInstance(): Promise<MetroInstance | null> {
    const resp = await this.client.send({
      type: "command",
      action: "metro/getInstance",
      id: this.nextId(),
      payload: this.payloadWithSession(),
    });
    const p = resp.payload as { instance?: MetroInstance | null };
    return p?.instance ?? null;
  }

  dispatch(kind: MetroEventKind, data: unknown): void {
    if (kind === "metro/status") {
      this.emit("status", data);
    } else {
      this.emit("log", data);
    }
  }

  notifyDisconnected(err?: Error): void {
    this.emit("disconnected", err);
  }
}

function readOk(resp: IpcMessage): boolean {
  const p = resp.payload as { ok?: boolean };
  return p?.ok === true;
}
