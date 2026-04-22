import type { ModuleInstance } from "./instance.js";

export interface SupervisorOptions {
  instance: ModuleInstance;
  /** Called when the supervisor decides a crash should be retried. */
  onRespawn: () => void | Promise<void>;
  /** Test-injectable clock; defaults to Date.now. */
  clock?: () => number;
  /** Max crashes within `windowMs` before the instance is marked failed. */
  maxCrashesInWindow?: number;
  /** Sliding-window length in milliseconds. */
  windowMs?: number;
}

/**
 * LSP-style restart policy. Listens for `crashed` events on a
 * `ModuleInstance` and either triggers `onRespawn` (transient crash) or
 * transitions the instance to `failed` (crash loop detected).
 *
 * Sliding window: only crashes whose timestamp is within `windowMs` of the
 * current moment count. A successful recovery (instance reaching `active`)
 * clears the window so a future failure starts counting from scratch.
 */
export class Supervisor {
  private readonly instance: ModuleInstance;
  private readonly onRespawn: () => void | Promise<void>;
  private readonly clock: () => number;
  private readonly maxCrashesInWindow: number;
  private readonly windowMs: number;

  private crashTimes: number[] = [];
  private attached = false;

  // Stored handler references so detach() can remove them.
  private readonly handleCrashed = this.onCrashed.bind(this);
  private readonly handleStateChanged = this.onStateChanged.bind(this);

  constructor(options: SupervisorOptions) {
    this.instance = options.instance;
    this.onRespawn = options.onRespawn;
    this.clock = options.clock ?? Date.now;
    this.maxCrashesInWindow = options.maxCrashesInWindow ?? 5;
    this.windowMs = options.windowMs ?? 3 * 60_000;
  }

  attach(): void {
    if (this.attached) return;
    this.instance.on("crashed", this.handleCrashed);
    this.instance.on("state-changed", this.handleStateChanged);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    this.instance.off("crashed", this.handleCrashed);
    this.instance.off("state-changed", this.handleStateChanged);
    this.attached = false;
  }

  private onCrashed(_payload: { reason: string }): void {
    const now = this.clock();
    this.crashTimes.push(now);
    this.crashTimes = this.crashTimes.filter((t) => now - t < this.windowMs);

    if (this.crashTimes.length >= this.maxCrashesInWindow) {
      this.instance.transitionTo("failed", {
        reason: `${this.maxCrashesInWindow} crashes within ${this.windowMs}ms — supervisor gave up.`,
      });
      return;
    }
    void this.onRespawn();
  }

  private onStateChanged(payload: {
    from: string;
    to: string;
  }): void {
    if (payload.to === "active") {
      this.crashTimes = [];
    }
  }
}
