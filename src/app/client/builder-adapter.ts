// Client-side Builder adapter. The original Builder is fire-and-forget
// (build() kicks off a subprocess, events announce progress). The
// adapter preserves that: build() returns a resolved Promise once the
// daemon acks, and events flow via _dispatch as the daemon observes
// the underlying Builder emit them.

import { EventEmitter } from "node:events";
import type { IpcClient } from "../../core/ipc.js";
import type { BuildOptions } from "../../core/builder.js";

export interface BuilderClientEvents {
  line: (evt: { text: string; stream: "stdout" | "stderr"; replace?: boolean }) => void;
  progress: (evt: { phase: string }) => void;
  done: (evt: {
    success: boolean;
    errors: Array<{
      source: "xcodebuild" | "gradle";
      summary: string;
      file?: string;
      line?: number;
      reason?: string;
      suggestion?: string;
    }>;
    platform?: "ios" | "android";
  }) => void;
}

export class BuilderClient extends EventEmitter {
  constructor(
    private client: IpcClient,
    private nextId: () => string,
  ) {
    super();
  }

  async build(opts: BuildOptions): Promise<void> {
    // `IpcMessage.payload` is typed `unknown`, so `BuildOptions`
    // assigns directly — no cast needed. An earlier iteration went
    // through `as unknown as Record<string, unknown>` for no reason
    // (Kieran P0-2 on PR #17).
    await this.client.send({
      type: "command",
      action: "builder/build",
      id: this.nextId(),
      payload: opts,
    });
  }

  _dispatch(
    kind: "builder/line" | "builder/progress" | "builder/done",
    data: unknown,
  ): void {
    const topic = kind.slice("builder/".length);
    this.emit(topic, data);
  }
}
