// Client-side Builder adapter. The original Builder is fire-and-forget
// (build() kicks off a subprocess, events announce progress). The
// adapter preserves that: build() returns a resolved Promise once the
// daemon acks, and events flow via dispatch as the daemon observes
// the underlying Builder emit them.

import { EventEmitter } from "node:events";
import type { BuildOptions } from "../../core/builder.js";
import type { AdapterSink, BuilderEventKind } from "./adapter-sink.js";
import type { IpcSender } from "./session.js";

// `source` discriminator on every Builder event (Phase H2b). Today the
// wire always carries `"builtin"` because the daemon-side Builder is the
// emitter; H4's BuildHostCapability wrapper flips this to `"override"`
// when an override hook script synthesizes events, letting consumers
// distinguish "build failed" from "override hook crashed" without
// re-checking what the daemon was running underneath.
export interface BuilderClientEvents {
  line: (evt: {
    source: "builtin" | "override";
    text: string;
    stream: "stdout" | "stderr";
    replace?: boolean;
  }) => void;
  progress: (evt: { source: "builtin" | "override"; phase: string }) => void;
  done: (evt: {
    source: "builtin" | "override";
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
  /** Fires once on unexpected daemon death (Phase 13.4 prereq #1). */
  disconnected: (err?: Error) => void;
}

/** Ring buffer entry: tagged-union event capturing what the daemon emitted. */
export type BuilderRingEntry =
  | { kind: "line"; ts: number; data: { source: string; text: string; stream: string; replace?: boolean } }
  | { kind: "progress"; ts: number; data: { source: string; phase: string } }
  | { kind: "done"; ts: number; data: { source: string; success: boolean; errors: unknown[]; platform?: string } };

const DEFAULT_BUILDER_RING_SIZE = 500;

export class BuilderClient
  extends EventEmitter
  implements AdapterSink<BuilderEventKind>
{
  /**
   * In-memory ring of recent builder events. Same rationale as
   * SessionClient.logRing: builder/line/progress/done events fire DURING
   * a long-running build, but agents poll asynchronously — they need a
   * snapshot of what happened, not a live stream. MCP's
   * `rn-dev/build-status` reads from this ring on demand. 500 entries
   * is enough for a multi-thousand-line xcodebuild without unbounded
   * memory growth (capped at ≈100KB for typical line lengths).
   */
  private readonly ring: BuilderRingEntry[] = [];
  private readonly ringSize: number;

  constructor(
    private client: IpcSender,
    private nextId: () => string,
    opts: { ringSize?: number } = {},
  ) {
    super();
    this.ringSize = opts.ringSize ?? DEFAULT_BUILDER_RING_SIZE;
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

  dispatch(kind: BuilderEventKind, data: unknown): void {
    const topic = kind.slice("builder/".length);
    this.pushRingEntry(topic, data);
    this.emit(topic, data);
  }

  /**
   * Snapshot of the in-memory event ring — defensive copy so callers
   * iterating during a concurrent dispatch don't observe mid-mutation
   * state.
   */
  recentEvents(): readonly BuilderRingEntry[] {
    return this.ring.slice();
  }

  notifyDisconnected(err?: Error): void {
    this.emit("disconnected", err);
  }

  private pushRingEntry(topic: string, data: unknown): void {
    const entry = parseBuilderRingEntry(topic, data);
    if (!entry) return;
    this.ring.push(entry);
    if (this.ring.length > this.ringSize) {
      this.ring.shift();
    }
  }
}

function parseBuilderRingEntry(topic: string, data: unknown): BuilderRingEntry | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const ts = Date.now();
  const source = typeof d.source === "string" ? d.source : "builtin";
  if (topic === "line") {
    return {
      kind: "line",
      ts,
      data: {
        source,
        text: typeof d.text === "string" ? d.text : "",
        stream: typeof d.stream === "string" ? d.stream : "stdout",
        replace: typeof d.replace === "boolean" ? d.replace : undefined,
      },
    };
  }
  if (topic === "progress") {
    return {
      kind: "progress",
      ts,
      data: { source, phase: typeof d.phase === "string" ? d.phase : "" },
    };
  }
  if (topic === "done") {
    return {
      kind: "done",
      ts,
      data: {
        source,
        success: d.success === true,
        errors: Array.isArray(d.errors) ? d.errors : [],
        platform: typeof d.platform === "string" ? d.platform : undefined,
      },
    };
  }
  return null;
}
