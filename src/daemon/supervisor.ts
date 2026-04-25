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
  /**
   * Phase 13.6 PR-C P0-1 — passed through to `BootSessionServicesOptions`
   * so `registerModulesIpc` can close the bidirectional gate bypass on
   * `modules/host-call` and `modules/bind-sender`.
   */
  subscribeRegistry?: import("../daemon/subscribe-registry.js").SubscribeRegistry;
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

/**
 * Result of `attach()`. `started` distinguishes the first-attacher
 * (who triggered the boot) from subsequent joiners (who are sharing
 * an already-running or starting session). Callers don't need to
 * branch on this for correctness — the supervisor resolves all
 * lifecycle differences internally — but logging and audit consumers
 * find it useful.
 */
export type AttachSessionResult =
  | {
      kind: "ok";
      status: SessionStatus;
      started: boolean;
      attached: number;
    }
  | { kind: "error"; code: string; message: string };

export interface ReleaseSessionResult {
  kind: "ok";
  attached: number;
  /** True iff this release dropped the last attacher → supervisor.stop(). */
  stoppedSession: boolean;
}

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
  private readonly subscribeRegistry: import("../daemon/subscribe-registry.js").SubscribeRegistry | undefined;
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
  /**
   * Phase 13.5 — connections currently attached to the active session.
   * First entry triggers the boot; last release tears down. The id is
   * `IpcMessageEvent.connectionId` so the daemon dispatcher can map a
   * client socket to its attachment without leaking the raw `net.Socket`
   * across the supervisor surface.
   */
  private attachedConnections = new Set<string>();

  constructor(opts: DaemonSupervisorOptions) {
    super();
    this.worktree = opts.worktree;
    this.ipc = opts.ipc;
    this.bootFn = opts.bootFn;
    this.subscribeRegistry = opts.subscribeRegistry;
    this.sessionWorktreeKey = this.worktree;
  }

  getState(): SessionState {
    return this.state;
  }

  /**
   * Exposes the wired services while a session is running, or null
   * otherwise. Client RPCs (metro/reload, devtools/listNetwork, etc.)
   * read from this — not from the supervisor's private `wired` field —
   * so the RPC dispatcher stays outside the supervisor's internals.
   */
  getServices(): SessionServices | null {
    return this.wired?.services ?? null;
  }

  /**
   * The worktree the daemon was spawned against. Exposed so RPC
   * handlers can bound untrusted path inputs (builder/build.projectRoot)
   * to within this worktree — a caller that can reach the socket
   * should not be able to spawn a build in a sibling repo whose
   * `node_modules/.bin/react-native` the daemon has never vetted.
   */
  getWorktree(): string {
    return this.worktree;
  }

  /** Phase 13.5 — count of connections currently attached. */
  getAttachedCount(): number {
    return this.attachedConnections.size;
  }

  /**
   * Phase 13.5 — stable worktree-hashed key for the active session.
   * Exposed so the daemon's `session/status` handler can hand it back
   * to joiners that subscribed too late to catch it on the
   * session/status event stream.
   */
  getSessionWorktreeKey(): string {
    return this.sessionWorktreeKey;
  }

  /**
   * Phase 13.5 — attach a connection to the active session, booting
   * it on the first attach if no session is running.
   *
   * Semantics:
   *   - status === "stopped" → boot the session (existing `start()` path)
   *     and add `connectionId` to the attached set. `started: true`.
   *   - status === "starting" | "running" → idempotent add of
   *     `connectionId` to the attached set. If a profile is supplied,
   *     it must match the active profile (else `E_PROFILE_MISMATCH`).
   *   - status === "stopping" → reject with `E_SESSION_STOPPING`. The
   *     caller should wait for `stopped` and retry; this matches the
   *     existing `stop()` invariant that a stopping session is
   *     committed and a fresh `start()` is required.
   *
   * Idempotent on `connectionId` — calling `attach` twice from the same
   * connection is a no-op for the refcount.
   */
  async attach(
    connectionId: string,
    opts: StartSessionOptions,
  ): Promise<AttachSessionResult> {
    if (this.state.status === "stopping") {
      return {
        kind: "error",
        code: "E_SESSION_STOPPING",
        message: "session is stopping; wait for stopped before attaching",
      };
    }

    if (this.state.status === "starting" || this.state.status === "running") {
      // Profile mismatch is a hard reject — the second attacher must
      // not silently end up with a different session than they asked
      // for. Same-name + same-worktree is the cheap equality check;
      // deep-equal would be safer but the profile shape is large and
      // the daemon already accepted the original via validateProfile,
      // so the pair (name, worktree) is sufficient as a sanity gate.
      const active = this.activeProfile;
      if (
        active &&
        (active.name !== opts.profile.name ||
          (active.worktree ?? "") !== (opts.profile.worktree ?? ""))
      ) {
        return {
          kind: "error",
          code: "E_PROFILE_MISMATCH",
          message: `daemon already running profile "${active.name}"; cannot attach to "${opts.profile.name}"`,
        };
      }
      this.attachedConnections.add(connectionId);
      return {
        kind: "ok",
        status: this.state.status,
        started: false,
        attached: this.attachedConnections.size,
      };
    }

    // stopped — first attacher boots the session.
    const startResult = await this.start(opts);
    if (startResult.kind === "error") {
      return startResult;
    }
    this.attachedConnections.add(connectionId);
    return {
      kind: "ok",
      status: startResult.status,
      started: true,
      attached: this.attachedConnections.size,
    };
  }

  /**
   * Phase 13.5 — release a connection from the active session. Last
   * release tears down (delegates to `stop()`); intermediate releases
   * just remove the connection from the attached set.
   *
   * Idempotent — releasing an unknown connectionId is a no-op (matches
   * the socket-close path which fires unconditionally).
   *
   * Concurrent release safety: stop() clears attachedConnections, so a
   * release racing alongside a stop() returns wasAttached=false on the
   * second branch and short-circuits — no double tear-down.
   */
  async release(connectionId: string): Promise<ReleaseSessionResult> {
    const wasAttached = this.attachedConnections.delete(connectionId);
    if (!wasAttached) {
      return {
        kind: "ok",
        attached: this.attachedConnections.size,
        stoppedSession: false,
      };
    }
    if (this.attachedConnections.size === 0 && this.state.status !== "stopped") {
      await this.stop();
      return { kind: "ok", attached: 0, stoppedSession: true };
    }
    return {
      kind: "ok",
      attached: this.attachedConnections.size,
      stoppedSession: false,
    };
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
          // Phase 13.5 — drop the first attacher's refcount entry on
          // boot failure. Otherwise the connId added by attach() before
          // bootAsync ran stays in the set across a transition to
          // "stopped"; the next attach (from a new client whose
          // dispatcher sees state=stopped) re-enters the first-
          // attacher branch and boots a fresh session, but the stale
          // entry then blocks last-release teardown until that conn's
          // socket eventually closes.
          this.attachedConnections.clear();
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
      // Even when already stopped, scrub the attached set: callers
      // hitting session/stop expect the kill-for-everyone semantics
      // and a stale entry would block the next attach() from booting
      // a fresh session via the "first attacher" branch.
      this.attachedConnections.clear();
      return { kind: "ok", status: "stopped" };
    }
    if (this.state.status === "stopping") {
      return { kind: "ok", status: "stopping" };
    }

    // Bump the epoch first so any in-flight boot observes it on the
    // publish check and disposes rather than overwriting state we're
    // about to clear.
    this.bootEpoch++;
    // session/stop is the kill-for-everyone path (Phase 13.5 — distinct
    // from session/release, which is the ref-counted detach). Empty the
    // attached set so a refcount race ("a release lands during stop's
    // teardown") can't double-dispatch a stop.
    this.attachedConnections.clear();
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
      subscribeRegistry: this.subscribeRegistry,
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
    const detachers: Array<() => void> = [];

    type EmitterLike = {
      on: (event: string, listener: (...args: unknown[]) => void) => unknown;
      off: (event: string, listener: (...args: unknown[]) => void) => unknown;
    };

    const bind = <TPayload>(
      target: EmitterLike,
      event: string,
      toEvent: (payload: TPayload) => SessionEvent,
    ): void => {
      const handler = (payload: unknown): void => {
        this.emitSessionEvent(toEvent(payload as TPayload));
      };
      target.on(event, handler);
      detachers.push(() => target.off(event, handler));
    };

    bind<{ worktreeKey: string; status: string }>(services.metro, "status", (p) => ({
      kind: "metro/status",
      worktreeKey,
      data: { status: p.status },
    }));
    bind<{ worktreeKey: string; line: string; stream: "stdout" | "stderr" }>(
      services.metro,
      "log",
      (p) => ({
        kind: "metro/log",
        worktreeKey,
        data: { line: p.line, stream: p.stream },
      }),
    );
    bind<Record<string, unknown>>(services.devtools, "status", (p) => ({
      kind: "devtools/status",
      worktreeKey,
      data: p,
    }));
    bind<{
      worktreeKey: string;
      addedIds: readonly string[];
      updatedIds: readonly string[];
      evictedIds: readonly string[];
    }>(services.devtools, "delta", (p) => ({
      kind: "devtools/delta",
      worktreeKey,
      data: {
        addedIds: p.addedIds,
        updatedIds: p.updatedIds,
        evictedIds: p.evictedIds,
      },
    }));
    bind<{ moduleId: string; scopeUnit: string; from: string; to: string }>(
      services.moduleHost,
      "state-changed",
      (p) => ({ kind: "modules/state-changed", worktreeKey, data: p }),
    );
    bind<{ moduleId: string; scopeUnit: string; reason: string }>(
      services.moduleHost,
      "crashed",
      (p) => ({ kind: "modules/crashed", worktreeKey, data: p }),
    );
    bind<{ moduleId: string; scopeUnit: string; reason: string }>(
      services.moduleHost,
      "failed",
      (p) => ({ kind: "modules/failed", worktreeKey, data: p }),
    );
    bind<{ text: string; stream: "stdout" | "stderr"; replace?: boolean }>(
      services.builder,
      "line",
      (p) => ({
        kind: "builder/line",
        worktreeKey,
        data: { text: p.text, stream: p.stream, replace: p.replace },
      }),
    );
    bind<{ phase: string }>(services.builder, "progress", (p) => ({
      kind: "builder/progress",
      worktreeKey,
      data: { phase: p.phase },
    }));
    bind<{
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
    }>(services.builder, "done", (p) => ({
      kind: "builder/done",
      worktreeKey,
      data: {
        success: p.success,
        errors: p.errors.map((e) => ({
          source: e.source,
          summary: e.summary,
          file: e.file,
          line: e.line,
          reason: e.reason,
          suggestion: e.suggestion,
        })),
        platform: p.platform,
      },
    }));
    if (services.watcher) {
      bind<{
        name: string;
        result: {
          action: string;
          success: boolean;
          output: string;
          durationMs: number;
        };
      }>(services.watcher, "action-complete", (p) => ({
        kind: "watcher/action-complete",
        worktreeKey,
        data: { name: p.name, result: p.result },
      }));
    }

    return () => {
      for (const fn of detachers) fn();
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
