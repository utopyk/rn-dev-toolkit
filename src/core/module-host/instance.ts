import { EventEmitter } from "node:events";

export type ModuleInstanceState =
  | "idle"
  | "spawning"
  | "handshaking"
  | "active"
  | "updating"
  | "restarting"
  | "crashed"
  | "failed"
  | "stopping";

/**
 * Permitted state transitions. Anything not in this table is rejected at
 * runtime by `transitionTo()`.
 *
 *   idle → spawning
 *   spawning → handshaking | crashed
 *   handshaking → active | crashed
 *   active → updating | restarting | crashed | stopping
 *   updating → active | crashed
 *   restarting → spawning
 *   crashed → spawning | failed
 *   failed → spawning              (manual modules/restart recovery)
 *   stopping → idle
 */
const TRANSITIONS: Record<ModuleInstanceState, readonly ModuleInstanceState[]> =
  {
    idle: ["spawning"],
    spawning: ["handshaking", "crashed"],
    handshaking: ["active", "crashed"],
    active: ["updating", "restarting", "crashed", "stopping"],
    updating: ["active", "crashed"],
    restarting: ["spawning"],
    crashed: ["spawning", "failed"],
    failed: ["spawning"],
    stopping: ["idle"],
  };

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly moduleId: string,
    public readonly scopeUnit: string,
    public readonly from: ModuleInstanceState,
    public readonly to: ModuleInstanceState,
  ) {
    super(
      `Invalid state transition for module "${moduleId}" (scope "${scopeUnit}"): ${from} → ${to}`,
    );
    this.name = "InvalidStateTransitionError";
  }
}

export interface ModuleInstanceOptions {
  moduleId: string;
  scopeUnit: string;
}

export interface TransitionOptions {
  reason?: string;
}

export interface ModuleInstanceEvents {
  "state-changed": {
    from: ModuleInstanceState;
    to: ModuleInstanceState;
  };
  crashed: { reason: string };
  failed: { reason: string };
}

/**
 * State machine + identity bag for a single module subprocess.
 *
 * Pure logic — owns no process handle, no RPC, no timers. The supervisor
 * and manager drive transitions; this class just enforces the transition
 * graph, tracks crash counts, and emits events for observers.
 */
export class ModuleInstance extends EventEmitter {
  readonly moduleId: string;
  readonly scopeUnit: string;
  private _state: ModuleInstanceState = "idle";
  private _crashCount = 0;
  private _lastCrashReason: string | null = null;

  constructor(options: ModuleInstanceOptions) {
    super();
    this.moduleId = options.moduleId;
    this.scopeUnit = options.scopeUnit;
  }

  get state(): ModuleInstanceState {
    return this._state;
  }

  get crashCount(): number {
    return this._crashCount;
  }

  get lastCrashReason(): string | null {
    return this._lastCrashReason;
  }

  transitionTo(
    target: ModuleInstanceState,
    options: TransitionOptions = {},
  ): void {
    const allowed = TRANSITIONS[this._state];
    if (!allowed.includes(target)) {
      throw new InvalidStateTransitionError(
        this.moduleId,
        this.scopeUnit,
        this._state,
        target,
      );
    }

    const from = this._state;
    this._state = target;

    if (target === "crashed") {
      this._crashCount += 1;
      this._lastCrashReason = options.reason ?? "unknown";
      this.emit("crashed", { reason: this._lastCrashReason });
    }

    if (target === "failed") {
      const reason = options.reason ?? this._lastCrashReason ?? "unknown";
      this.emit("failed", { reason });
    }

    if (target === "active") {
      // Successful recovery — reset crash counter so the supervisor's
      // sliding window starts fresh for the next failure cycle.
      this._crashCount = 0;
    }

    this.emit("state-changed", { from, to: target });
  }
}
