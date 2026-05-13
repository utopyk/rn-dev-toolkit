// Session supervisor. Owns the transition ladder
// stopped → starting → running → stopping → stopped per session and
// fans session events out to events/subscribe consumers via an
// EventEmitter.
//
// Named `DaemonSupervisor` to avoid colliding with the unrelated
// `Supervisor` in src/core/module-host/supervisor.ts (module-host
// crash-loop detector).
//
// Phase D1 — internal state is a `Map<SessionId, SessionEntry>`. Two
// concurrent sessions for the same worktree are allowed at the
// supervisor layer.
//
// Phase D2 — the legacy single-session facade (`start`, `stop`,
// `attach`, `release`, `getServices`, `getState`, `getAttachedCount`,
// `getSessionWorktreeKey`) is gone. Every callsite — `src/daemon/index.ts`
// dispatchers, `src/daemon/client-rpcs.ts` — now threads `SessionId`
// through the per-session API. The single-session "back-compat" shape
// (e.g. `session/stop` with no sessionId) lives at the dispatcher layer,
// not in the supervisor: the dispatcher resolves "the only active
// session" via `listSessions()` before calling the per-session API. The
// supervisor itself only speaks `SessionId`.
//
// Concurrency model: each entry carries its own `bootEpoch` and
// `bootInFlight`. `bootAsync` validates `entry.bootEpoch ===
// this.sessions.get(sessionId)?.bootEpoch` (not its local capture) at
// publish time so a stale boot can't leak into a fresh entry that
// re-used the same sessionId after a crash-restart. Entry deletion
// happens AFTER `bootInFlight` settles, never racing it.

import path from "node:path";
import { EventEmitter } from "node:events";
import type { IpcServer } from "../core/ipc.js";
import { ArtifactStore } from "../core/artifact.js";
import { ModuleRegistry } from "../modules/registry.js";
import { readHostVersion } from "../core/host-version.js";
import { type SessionId } from "../core/identifiers.js";
import type { ValidatedProfile } from "./profile-guard.js";
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
  profile: ValidatedProfile;
}

export type StartSessionResult =
  | { kind: "ok"; status: "starting"; sessionId: SessionId }
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
      sessionId: SessionId;
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
 * Per-session state. Lifted from the flat singleton fields of the
 * pre-D1 supervisor; one entry per active session in `this.sessions`.
 *
 * Phase D2 — `activeProfile` is `ValidatedProfile`. The dispatcher
 * validates payloads at the wire boundary via `validateProfile` and
 * passes the branded result down; `bootSessionServices` then re-uses
 * the same branded profile for HookManager.fire so the spawn boundary
 * cannot be reached with attacker-controlled fields.
 *
 * `acquiredModules` is allocated empty in D1 and populated by D4's
 * cross-session ModuleHost refcount work — pre-allocated here so the
 * field is available to crash-cleanup paths (`stopEntry`) when D4
 * lands without touching this file again.
 */
export interface SessionEntry {
  sessionId: SessionId;
  state: SessionState;
  wired: WiredServices | null;
  activeProfile: ValidatedProfile;
  bootEpoch: number;
  bootInFlight: Promise<void> | null;
  /** ArtifactStore-hashed worktree key. Stable for the entry's lifetime. */
  sessionWorktreeKey: string;
  attachedConnections: Set<string>;
  /** D4 placeholder — populated by ModuleHost refcount work. */
  acquiredModules: Array<{ moduleId: string; scopeUnit: string; consumerId: string }>;
}

/**
 * Emits:
 *   - "event"         (SessionEvent)  — forwarded to events/subscribe streams.
 *                                        Carries `sessionId` per D1 DR-5.
 *   - "state-changed" (SessionState)  — transition edges. Also forwarded as
 *                                        a `session/status` event.
 */
export class DaemonSupervisor extends EventEmitter {
  private readonly worktree: string;
  private readonly ipc: IpcServer;
  private readonly bootFn: SessionBootFn;
  private readonly subscribeRegistry: import("../daemon/subscribe-registry.js").SubscribeRegistry | undefined;

  private readonly sessions = new Map<SessionId, SessionEntry>();

  constructor(opts: DaemonSupervisorOptions) {
    super();
    this.worktree = opts.worktree;
    this.ipc = opts.ipc;
    this.bootFn = opts.bootFn;
    this.subscribeRegistry = opts.subscribeRegistry;
  }

  // ===========================================================================
  // Primary per-session API (new in D1)
  // ===========================================================================

  /**
   * Start a fresh session keyed by the caller-supplied sessionId. The
   * caller is responsible for ensuring the sessionId is unique;
   * collisions return `E_SESSION_ALREADY_EXISTS`. Port collisions with
   * any other active session on this daemon return `E_PORT_CONFLICT`.
   *
   * Phase D2 — primary API. The dispatcher in `src/daemon/index.ts`
   * is the only caller that mints sessionIds (via `generateSessionId`);
   * test fixtures may inject their own to assert deterministic IDs.
   */
  async startSession(
    sessionId: SessionId,
    profile: ValidatedProfile,
  ): Promise<StartSessionResult> {
    if (this.sessions.has(sessionId)) {
      return {
        kind: "error",
        code: "E_SESSION_ALREADY_EXISTS",
        message: `session ${sessionId} already exists`,
      };
    }

    // Port collision detection across active sessions on this daemon.
    // Two sessions for the same worktree on the same Metro port can't
    // both bind it — fail loudly at start time instead of producing a
    // misleading Metro-spawn error later.
    if (profile.metroPort !== undefined) {
      for (const other of this.sessions.values()) {
        if (
          other.activeProfile.metroPort === profile.metroPort &&
          other.state.status !== "stopped"
        ) {
          return {
            kind: "error",
            code: "E_PORT_CONFLICT",
            message: `Metro port ${profile.metroPort} is already in use by session ${other.sessionId}`,
          };
        }
      }
    }

    const artifactStore = new ArtifactStore(
      path.join(this.worktree, ".rn-dev", "artifacts"),
    );
    const sessionWorktreeKey = artifactStore.worktreeHash(profile.worktree);

    const entry: SessionEntry = {
      sessionId,
      state: INITIAL_SESSION_STATE,
      wired: null,
      activeProfile: profile,
      bootEpoch: 1,
      bootInFlight: null,
      sessionWorktreeKey,
      attachedConnections: new Set(),
      acquiredModules: [],
    };
    this.sessions.set(sessionId, entry);
    this.transition(entry, "starting");

    const bootPromise = this.bootAsync(entry, artifactStore, entry.bootEpoch)
      .catch((err) => {
        this.emitSessionEvent({
          kind: "session/log",
          worktreeKey: entry.sessionWorktreeKey,
          sessionId: entry.sessionId,
          data: {
            level: "error",
            message: `bootSessionServices failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        });
        // Only roll back if we still own the epoch — a concurrent
        // stop() may have already torn the entry down.
        const current = this.sessions.get(sessionId);
        if (current && current.bootEpoch === entry.bootEpoch) {
          // Drop the first attacher's refcount entry on boot failure.
          // Without this, an attach() that added connId before bootAsync
          // ran leaves a stale entry across the transition to "stopped";
          // the next attach (from a new client whose dispatcher sees
          // state=stopped) re-enters the first-attacher branch and
          // boots a fresh session, but the stale connId then blocks
          // last-release teardown until the original conn's socket
          // closes.
          current.attachedConnections.clear();
          this.transition(current, "stopped");
        }
      });

    entry.bootInFlight = bootPromise.finally(() => {
      const current = this.sessions.get(sessionId);
      if (current && current.bootInFlight === entry.bootInFlight) {
        current.bootInFlight = null;
      }
    });

    return { kind: "ok", status: "starting", sessionId };
  }

  /**
   * Attach a connection to a known sessionId. Caller looks up / mints
   * the id before calling. Phase D2 wires this up at the
   * `events/subscribe { profile | sessionId }` boundary in
   * `src/daemon/index.ts`.
   *
   * Semantics:
   *   - Unknown sessionId → `E_UNKNOWN_SESSION`.
   *   - Mismatched profile.name + worktree → `E_PROFILE_MISMATCH`.
   *   - Session stopping → `E_SESSION_STOPPING`.
   *   - Otherwise idempotent add to the attached set.
   */
  attachToSession(
    sessionId: SessionId,
    connectionId: string,
    profile: ValidatedProfile,
  ): AttachSessionResult {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return {
        kind: "error",
        code: "E_UNKNOWN_SESSION",
        message: `session ${sessionId} not found`,
      };
    }
    if (entry.state.status === "stopping") {
      return {
        kind: "error",
        code: "E_SESSION_STOPPING",
        message: `session ${sessionId} is stopping`,
      };
    }
    if (!profileMatches(entry.activeProfile, profile)) {
      return {
        kind: "error",
        code: "E_PROFILE_MISMATCH",
        message: `session ${sessionId} runs profile "${entry.activeProfile.name}"; cannot attach to "${profile.name}"`,
      };
    }
    entry.attachedConnections.add(connectionId);
    return {
      kind: "ok",
      status: entry.state.status,
      started: false,
      attached: entry.attachedConnections.size,
      sessionId,
    };
  }

  /**
   * Stop the named session. Awaits any in-flight boot before disposing
   * services so a publish-after-stop race can't leak a wired services
   * struct.
   */
  async stopSession(sessionId: SessionId): Promise<StopSessionResult> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return {
        kind: "error",
        code: "E_UNKNOWN_SESSION",
        message: `session ${sessionId} not found`,
      };
    }
    return this.stopEntry(entry);
  }

  /** Read the entry for a known session, or undefined if not found. */
  getSessionEntry(sessionId: SessionId): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  /** Read the wired services for a known session, or null if not running. */
  getSessionServices(sessionId: SessionId): SessionServices | null {
    return this.sessions.get(sessionId)?.wired?.services ?? null;
  }

  /** Read the current state for a known session, or null if not found. */
  getSessionState(sessionId: SessionId): SessionState | null {
    return this.sessions.get(sessionId)?.state ?? null;
  }

  /**
   * Snapshot of every session entry. Returns a fresh array; the
   * underlying Map is private. Phase D2 `sessions/list` RPC reads from
   * here.
   */
  listSessions(): readonly SessionEntry[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Find a session whose profile matches the supplied (name, worktree)
   * pair. Used by Phase D2's `events/subscribe { profile }` boot-or-join
   * branch. Returns the first match — duplicate `(worktree, name)`
   * pairs across active sessions are prevented at `startSession` time
   * via the same-name guard, so "first match" is also "only match".
   *
   * Phase A8 race note: this method does NOT lock — it's a read-only
   * snapshot. D2's events/subscribe handler must layer a check-and-set
   * around the call to fix the read-then-write race with concurrent
   * subscribers; that lock lives at the RPC layer, not in the
   * supervisor.
   */
  findSessionByProfile(
    profileName: string,
    profileWorktree: string | null,
  ): SessionEntry | undefined {
    const wt = profileWorktree ?? "";
    for (const entry of this.sessions.values()) {
      if (entry.state.status === "stopped") continue;
      if (
        entry.activeProfile.name === profileName &&
        (entry.activeProfile.worktree ?? "") === wt
      ) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Remove a connection from every session's attached set. If any
   * session's set becomes empty as a result, tear that session down.
   * Phase D2 hooks this into the socket-close path; in D1 the legacy
   * `release(connId)` facade below already routes here so existing
   * `events/subscribe` consumers keep working.
   *
   * Architecture finding #2: walking every session (vs the historical
   * "the only session") is the load-bearing change. Without it, a
   * flaky renderer that reconnects mid-boot leaks an orphan session
   * over time.
   */
  async releaseConnectionFromAllSessions(
    connectionId: string,
  ): Promise<ReleaseSessionResult> {
    let totalAttached = 0;
    let stoppedSession = false;
    const toStop: SessionEntry[] = [];
    for (const entry of this.sessions.values()) {
      const wasAttached = entry.attachedConnections.delete(connectionId);
      if (
        wasAttached &&
        entry.attachedConnections.size === 0 &&
        entry.state.status !== "stopped"
      ) {
        toStop.push(entry);
      }
      totalAttached += entry.attachedConnections.size;
    }
    for (const entry of toStop) {
      await this.stopEntry(entry);
      stoppedSession = true;
    }
    return { kind: "ok", attached: totalAttached, stoppedSession };
  }

  /**
   * Stop every active session — used on daemon shutdown.
   */
  async shutdown(): Promise<void> {
    const entries = Array.from(this.sessions.values());
    for (const entry of entries) {
      try {
        await this.stopEntry(entry);
      } catch {
        /* best-effort */
      }
    }
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

  /** Attach a listener for events/subscribe fan-out. Returns detach fn. */
  onEvent(listener: (evt: SessionEvent) => void): () => void {
    this.on("event", listener);
    return () => {
      this.off("event", listener);
    };
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private async stopEntry(entry: SessionEntry): Promise<StopSessionResult> {
    if (entry.state.status === "stopped") {
      // Scrub the attached set even when stopped: callers hitting
      // session/stop expect kill-for-everyone semantics, and a stale
      // entry would block the next attach() from booting via the
      // first-attacher branch.
      entry.attachedConnections.clear();
      this.sessions.delete(entry.sessionId);
      return { kind: "ok", status: "stopped" };
    }
    if (entry.state.status === "stopping") {
      return { kind: "ok", status: "stopping" };
    }

    // Bump the epoch first so any in-flight boot observes it on the
    // publish check (`this.sessions.get(sid)?.bootEpoch !== myEpoch`)
    // and disposes rather than overwriting state we're about to clear.
    entry.bootEpoch++;
    // session/stop is the kill-for-everyone path (distinct from
    // release, the ref-counted detach). Empty the attached set so a
    // release racing alongside teardown can't double-dispatch a stop.
    entry.attachedConnections.clear();
    this.transition(entry, "stopping");

    // Wait for any boot in progress to finish its teardown. Without
    // this join, `bootAsync` can publish services into `entry.wired`
    // *after* we've set it to null, leaking them.
    const inFlight = entry.bootInFlight;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        /* bootAsync's own error handler already logged it */
      }
    }

    const wired = entry.wired;
    entry.wired = null;

    if (wired) {
      // Dispose first so teardown-time emits (metro stopped, module
      // crashed-on-exit, etc.) propagate to events/subscribe listeners
      // who need them. Detach only after the last event fires; otherwise
      // the "stopped" edge arrives at the client as silence.
      try {
        await wired.services.dispose();
      } catch {
        /* best-effort — teardown errors are non-fatal */
      }
      wired.detach();
    }

    this.transition(entry, "stopped");
    this.sessions.delete(entry.sessionId);
    return { kind: "ok", status: "stopped" };
  }

  private async bootAsync(
    entry: SessionEntry,
    artifactStore: ArtifactStore,
    myEpoch: number,
  ): Promise<void> {
    const moduleRegistry = new ModuleRegistry();
    const emit = (line: string): void => {
      this.emitSessionEvent({
        kind: "session/log",
        worktreeKey: entry.sessionWorktreeKey,
        sessionId: entry.sessionId,
        data: { level: "info", message: line },
      });
    };
    const hostVersion = readHostVersion();

    const services = await this.bootFn({
      sessionId: entry.sessionId,
      profile: entry.activeProfile,
      projectRoot: this.worktree,
      artifactStore,
      moduleRegistry,
      emit,
      hostVersion,
      ipc: this.ipc,
      subscribeRegistry: this.subscribeRegistry,
    });

    // Epoch gate — if start/stop has advanced the counter since we
    // captured it on entry, our boot is stale. Look up the current
    // entry by sessionId (not the local `entry` ref) so a deleted
    // entry that's been re-created with the same id can't be silently
    // overwritten with stale services.
    const current = this.sessions.get(entry.sessionId);
    if (!current || current.bootEpoch !== myEpoch) {
      try {
        await services.dispose();
      } catch {
        /* ignore — we're discarding this boot's work */
      }
      return;
    }

    const detach = this.wireServiceEvents(current, services);
    current.wired = { services, detach, epoch: myEpoch };
    current.state = {
      status: "running",
      services: this.snapshotServices(services),
    };
    this.emitStateChanged(current);
  }

  private wireServiceEvents(
    entry: SessionEntry,
    services: SessionServices,
  ): () => void {
    const worktreeKey = services.worktreeKey;
    const sessionId = entry.sessionId;
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
      sessionId,
      data: { status: p.status },
    }));
    bind<{ worktreeKey: string; line: string; stream: "stdout" | "stderr" }>(
      services.metro,
      "log",
      (p) => ({
        kind: "metro/log",
        worktreeKey,
        sessionId,
        data: { line: p.line, stream: p.stream },
      }),
    );
    bind<Record<string, unknown>>(services.devtools, "status", (p) => ({
      kind: "devtools/status",
      worktreeKey,
      sessionId,
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
      sessionId,
      data: {
        addedIds: p.addedIds,
        updatedIds: p.updatedIds,
        evictedIds: p.evictedIds,
      },
    }));
    bind<{ moduleId: string; scopeUnit: string; from: string; to: string }>(
      services.moduleHost,
      "state-changed",
      (p) => ({ kind: "modules/state-changed", worktreeKey, sessionId, data: p }),
    );
    bind<{ moduleId: string; scopeUnit: string; reason: string }>(
      services.moduleHost,
      "crashed",
      (p) => ({ kind: "modules/crashed", worktreeKey, sessionId, data: p }),
    );
    bind<{ moduleId: string; scopeUnit: string; reason: string }>(
      services.moduleHost,
      "failed",
      (p) => ({ kind: "modules/failed", worktreeKey, sessionId, data: p }),
    );
    // Builder events carry a `source: "builtin" | "override"` discriminator
    // (Phase H2b). Today the source is always "builtin" because the Builder
    // emits the events; H4's BuildHostCapability wrapper will start
    // synthesizing "override" events for hook-script-driven builds. Forwarded
    // verbatim so subscribers can already discriminate at the wire boundary.
    bind<{
      source: "builtin" | "override";
      text: string;
      stream: "stdout" | "stderr";
      replace?: boolean;
    }>(services.builder, "line", (p) => ({
      kind: "builder/line",
      worktreeKey,
      sessionId,
      data: { source: p.source, text: p.text, stream: p.stream, replace: p.replace },
    }));
    bind<{ source: "builtin" | "override"; phase: string }>(
      services.builder,
      "progress",
      (p) => ({
        kind: "builder/progress",
        worktreeKey,
        sessionId,
        data: { source: p.source, phase: p.phase },
      }),
    );
    bind<{
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
    }>(services.builder, "done", (p) => ({
      kind: "builder/done",
      worktreeKey,
      sessionId,
      data: {
        source: p.source,
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
        sessionId,
        data: { name: p.name, result: p.result },
      }));
    }

    // Phase H2g — fan out HookManager `hooks/fired` over the existing
    // events/subscribe channel. Lets MCP agents and the renderer answer
    // "did my hook just run?" without grepping the daemon log. Mirrors
    // the HookManager's internal emit shape ({ target, outcome }) into
    // the SessionEvent { ok, fired, skipped, failureCount } summary so
    // the wire payload is bounded (full failure objects can be large).
    bind<{
      target: string;
      outcome: { ok: boolean; fired: number; skipped: number; failures: unknown[] };
    }>(services.hookManager, "hooks/fired", (p) => ({
      kind: "hooks/fired",
      worktreeKey,
      sessionId,
      data: {
        target: p.target,
        ok: p.outcome.ok,
        fired: p.outcome.fired,
        skipped: p.outcome.skipped,
        failureCount: p.outcome.failures.length,
      },
    }));

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

  private transition(entry: SessionEntry, next: SessionStatus): void {
    if (entry.state.status === next) return;
    entry.state = {
      status: next,
      services: next === "running" ? entry.state.services : null,
    };
    this.emitStateChanged(entry);
  }

  private emitStateChanged(entry: SessionEntry): void {
    this.emit("state-changed", entry.state);
    this.emitSessionEvent({
      kind: "session/status",
      worktreeKey: entry.sessionWorktreeKey,
      sessionId: entry.sessionId,
      data: { status: entry.state.status },
    });
  }

  private emitSessionEvent(evt: SessionEvent): void {
    this.emit("event", evt);
  }
}

/**
 * Same-session match predicate. Matches today's pair check at
 * (profile.name, profile.worktree) — the daemon already validated the
 * full profile shape on session/start, so the cheap pair is
 * sufficient as a sanity gate. Both `worktree` fields are normalised
 * to "" for the comparison so null and absence read equivalent.
 */
function profileMatches(active: ValidatedProfile, incoming: ValidatedProfile): boolean {
  return (
    active.name === incoming.name &&
    (active.worktree ?? "") === (incoming.worktree ?? "")
  );
}
