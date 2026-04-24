// Session supervisor. Owns the transition ladder
// stopped → starting → running → stopping → stopped and fans session
// events out to events/subscribe consumers via an EventEmitter.
//
// Named `DaemonSupervisor` to avoid colliding with the unrelated
// `Supervisor` in src/core/module-host/supervisor.ts (module-host
// crash-loop detector).
//
// Concurrency model: every `start()` captures an incrementing `bootEpoch`.
// `bootAsync` compares its captured epoch against the supervisor's
// current epoch before publishing its wired services. Any `stop()` or
// subsequent `start()` bumps the epoch, invalidating a boot that's
// still mid-flight; the losing boot disposes its partially-constructed
// services instead of leaking them. One daemon per worktree — we
// don't coordinate cross-daemon.

import path from "node:path";
import { EventEmitter } from "node:events";
import type { IpcServer } from "../core/ipc.js";
import { ArtifactStore } from "../core/artifact.js";
import { ModuleRegistry } from "../modules/registry.js";
import { readHostVersion } from "../core/host-version.js";
import type { Profile } from "../core/types.js";
import {
  INITIAL_SESSION_STATE,
  type SessionState,
  type SessionStatus,
  type SessionEvent,
  type ServicesSnapshot,
} from "./session.js";
import type {
  BootSessionServicesOptions,
  SessionServices,
} from "../core/session/boot.js";

export type SessionBootFn = (
  opts: BootSessionServicesOptions,
) => Promise<SessionServices>;

export interface DaemonSupervisorOptions {
  /** Absolute path to the worktree. */
  worktree: string;
  /** Pre-started IpcServer — shared with the daemon's RPC dispatch. */
  ipc: IpcServer;
  /** Pluggable boot function. Production uses `bootSessionServices`; tests inject a fake. */
  bootFn: SessionBootFn;
}

export interface StartSessionOptions {
  profile: Profile;
}

export type StartSessionResult =
  | { kind: "ok"; status: "starting" }
  | { kind: "error"; code: string; message: string };

export type StopSessionResult =
  | { kind: "ok"; status: "stopping" | "stopped" }
  | { kind: "error"; code: string; message: string };

type WiredServices = {
  services: SessionServices;
  detach: () => void;
  epoch: number;
};

/**
 * Emits:
 *   - "event"         (SessionEvent)  — forwarded to events/subscribe streams.
 *   - "state-changed" (SessionState)  — transition edges. Also forwarded as
 *                                        a `session/status` event.
 */
export class DaemonSupervisor extends EventEmitter {
  private readonly worktree: string;
  private readonly ipc: IpcServer;
  private readonly bootFn: SessionBootFn;
  private state: SessionState = INITIAL_SESSION_STATE;
  /** Populated while the session is running; null in stopped/starting. */
  private wired: WiredServices | null = null;
  /** Snapshot profile from session/start. Mid-session edits are ignored. */
  private activeProfile: Profile | null = null;
  /**
   * Incrementing generation counter. Bumped on every start() AND
   * stop(); bootAsync captures on entry and re-checks on publish to
   * drop its result if a concurrent transition has since invalidated it.
   */
  private bootEpoch = 0;
  /**
   * In-flight boot promise, if any. stop() awaits it so teardown runs
   * AFTER boot's dispose path finishes rather than racing it.
   */
  private bootInFlight: Promise<void> | null = null;
  /**
   * Stable worktree-hashed key for this session. Stamped at start() so
   * pre-boot lifecycle events carry the same id as post-boot events —
   * Arch reviewer P1 on identity drift.
   */
  private sessionWorktreeKey: string;

  constructor(opts: DaemonSupervisorOptions) {
    super();
    this.worktree = opts.worktree;
    this.ipc = opts.ipc;
    this.bootFn = opts.bootFn;
    this.sessionWorktreeKey = this.worktree;
  }

  getState(): SessionState {
    return this.state;
  }

  async start(opts: StartSessionOptions): Promise<StartSessionResult> {
    if (this.state.status !== "stopped") {
      return {
        kind: "error",
        code: "E_SESSION_ALREADY_RUNNING",
        message: `session is ${this.state.status}; stop it before starting a new one`,
      };
    }

    const myEpoch = ++this.bootEpoch;
    this.activeProfile = opts.profile;
    // Compute the stable worktreeKey now so every event from start → stop
    // carries the same identity — before this, pre-boot events used the
    // raw worktree path while post-boot events used the hashed key and
    // subscribers saw two ids for one session.
    const artifactStore = new ArtifactStore(
      path.join(this.worktree, ".rn-dev", "artifacts"),
    );
    this.sessionWorktreeKey = artifactStore.worktreeHash(opts.profile.worktree);
    this.transition("starting");

    const bootPromise = this.bootAsync(opts.profile, artifactStore, myEpoch).catch(
      (err) => {
        this.emitSessionEvent({
          kind: "session/log",
          worktreeKey: this.sessionWorktreeKey,
          data: {
            level: "error",
            message: `bootSessionServices failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        });
        // Only roll back if we still own the epoch — a concurrent stop()
        // may have already reset the state.
        if (this.bootEpoch === myEpoch) {
          this.activeProfile = null;
          this.transition("stopped");
        }
      },
    );
    this.bootInFlight = bootPromise.finally(() => {
      if (this.bootInFlight === bootPromise) {
        this.bootInFlight = null;
      }
    });

    return { kind: "ok", status: "starting" };
  }

  async stop(): Promise<StopSessionResult> {
    if (this.state.status === "stopped") {
      return { kind: "ok", status: "stopped" };
    }
    if (this.state.status === "stopping") {
      return { kind: "ok", status: "stopping" };
    }

    // Bump the epoch first so any in-flight boot observes it on the
    // publish check and disposes rather than overwriting state we're
    // about to clear.
    this.bootEpoch++;
    this.transition("stopping");

    // Wait for any boot in progress to finish its teardown. Without
    // this join, `bootAsync` can publish services into `this.wired`
    // *after* we've set it to null, leaking them.
    const inFlight = this.bootInFlight;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        /* bootAsync's own error handler already logged it */
      }
    }

    const wired = this.wired;
    this.wired = null;
    this.activeProfile = null;

    if (wired) {
      // Dispose first so teardown-time emits (metro stopped, module
      // crashed-on-exit, etc.) propagate to events/subscribe listeners
      // who need them. Detach only after the last event fires, otherwise
      // the "stopped" edge of the session arrives at the client as
      // silence.
      try {
        await wired.services.dispose();
      } catch {
        /* best-effort — teardown errors are non-fatal */
      }
      wired.detach();
    }

    this.transition("stopped");
    return { kind: "ok", status: "stopped" };
  }

  /** Attach a listener for events/subscribe fan-out. Returns detach fn. */
  onEvent(listener: (evt: SessionEvent) => void): () => void {
    this.on("event", listener);
    return () => {
      this.off("event", listener);
    };
  }

  private async bootAsync(
    profile: Profile,
    artifactStore: ArtifactStore,
    myEpoch: number,
  ): Promise<void> {
    const moduleRegistry = new ModuleRegistry();
    const emit = (line: string): void => {
      this.emitSessionEvent({
        kind: "session/log",
        worktreeKey: this.sessionWorktreeKey,
        data: { level: "info", message: line },
      });
    };
    const hostVersion = readHostVersion();

    const services = await this.bootFn({
      profile,
      projectRoot: this.worktree,
      artifactStore,
      moduleRegistry,
      emit,
      hostVersion,
      ipc: this.ipc,
    });

    // Epoch gate — if start/stop has advanced the counter since we
    // captured it on entry, our boot is stale. Dispose what we built
    // and walk away; the current owner of the state is responsible for
    // its own lifecycle.
    if (myEpoch !== this.bootEpoch) {
      try {
        await services.dispose();
      } catch {
        /* ignore — we're discarding this boot's work */
      }
      return;
    }

    const detach = this.wireServiceEvents(services);
    this.wired = { services, detach, epoch: myEpoch };
    this.state = {
      status: "running",
      services: this.snapshotServices(services),
    };
    this.emitStateChanged();
  }

  private wireServiceEvents(services: SessionServices): () => void {
    const worktreeKey = services.worktreeKey;
    const onMetroStatus = (evt: { worktreeKey: string; status: string }): void => {
      this.emitSessionEvent({
        kind: "metro/status",
        worktreeKey,
        data: { status: evt.status },
      });
    };
    const onMetroLog = (evt: {
      worktreeKey: string;
      line: string;
      stream: "stdout" | "stderr";
    }): void => {
      this.emitSessionEvent({
        kind: "metro/log",
        worktreeKey,
        data: { line: evt.line, stream: evt.stream },
      });
    };
    const onDevtoolsStatus = (payload: Record<string, unknown>): void => {
      this.emitSessionEvent({
        kind: "devtools/status",
        worktreeKey,
        data: payload,
      });
    };
    const onModuleStateChanged = (p: {
      moduleId: string;
      scopeUnit: string;
      from: string;
      to: string;
    }): void => {
      this.emitSessionEvent({
        kind: "modules/state-changed",
        worktreeKey,
        data: p,
      });
    };
    const onModuleCrashed = (p: {
      moduleId: string;
      scopeUnit: string;
      reason: string;
    }): void => {
      this.emitSessionEvent({
        kind: "modules/crashed",
        worktreeKey,
        data: p,
      });
    };
    const onModuleFailed = (p: {
      moduleId: string;
      scopeUnit: string;
      reason: string;
    }): void => {
      this.emitSessionEvent({
        kind: "modules/failed",
        worktreeKey,
        data: p,
      });
    };

    services.metro.on("status", onMetroStatus);
    services.metro.on("log", onMetroLog);
    services.devtools.on("status", onDevtoolsStatus);
    services.moduleHost.on("state-changed", onModuleStateChanged);
    services.moduleHost.on("crashed", onModuleCrashed);
    services.moduleHost.on("failed", onModuleFailed);

    return () => {
      services.metro.off("status", onMetroStatus);
      services.metro.off("log", onMetroLog);
      services.devtools.off("status", onDevtoolsStatus);
      services.moduleHost.off("state-changed", onModuleStateChanged);
      services.moduleHost.off("crashed", onModuleCrashed);
      services.moduleHost.off("failed", onModuleFailed);
    };
  }

  private snapshotServices(services: SessionServices): ServicesSnapshot {
    // Phase 13.2 — only report fields we can fill honestly. Phase 13.3+
    // can add live metro.getStatus(), devtools.getStatus() calls once
    // those surfaces exist on the client.
    return {
      modules: { count: services.moduleRegistry.getAllManifests().length },
    };
  }

  private transition(next: SessionStatus): void {
    if (this.state.status === next) return;
    this.state = {
      status: next,
      services: next === "running" ? this.state.services : null,
    };
    this.emitStateChanged();
  }

  private emitStateChanged(): void {
    this.emit("state-changed", this.state);
    this.emitSessionEvent({
      kind: "session/status",
      worktreeKey: this.sessionWorktreeKey,
      data: { status: this.state.status },
    });
  }

  private emitSessionEvent(evt: SessionEvent): void {
    this.emit("event", evt);
  }
}
