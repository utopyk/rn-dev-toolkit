// Client-side Watcher adapter. Only `action-complete` is streamed over
// events/subscribe today; `pipeline-start` / `action-start` /
// `pipeline-complete` can be added to the daemon fan-out if/when the
// TUI consumer needs them.

import { EventEmitter } from "node:events";
import type { IpcClient } from "../../core/ipc.js";

export interface WatcherClientEvents {
  "action-complete": (evt: {
    name: string;
    result: {
      action: string;
      success: boolean;
      output: string;
      durationMs: number;
    };
  }) => void;
}

export class WatcherClient extends EventEmitter {
  constructor(
    private client: IpcClient,
    private nextId: () => string,
  ) {
    super();
  }

  async start(): Promise<void> {
    await this.client.send({
      type: "command",
      action: "watcher/start",
      id: this.nextId(),
    });
  }

  async stop(): Promise<void> {
    await this.client.send({
      type: "command",
      action: "watcher/stop",
      id: this.nextId(),
    });
  }

  async isRunning(): Promise<boolean> {
    const resp = await this.client.send({
      type: "command",
      action: "watcher/isRunning",
      id: this.nextId(),
    });
    return (resp.payload as { running?: boolean }).running === true;
  }

  _dispatch(kind: "watcher/action-complete", data: unknown): void {
    const topic = kind.slice("watcher/".length);
    this.emit(topic, data);
  }
}
