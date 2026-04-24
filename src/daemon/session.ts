// Per-daemon session model. Phase 13.2 grows this from a bare status
// placeholder into the full state machine the DaemonSupervisor drives,
// plus the tagged-union event envelope that events/subscribe streams
// to clients.
//
// State transitions are strict:
//   stopped  -> starting        (session/start)
//   starting -> running|stopped (boot succeeded | boot failed)
//   running  -> stopping        (session/stop)
//   stopping -> stopped         (teardown complete)
// No other transitions are legal — the supervisor enforces them.

export type SessionStatus = "stopped" | "starting" | "running" | "stopping";

/**
 * Minimal, serializable snapshot of per-service health. Fields are
 * populated only when the session is running; during starting /
 * stopping the top-level `SessionState.services` is `null`. Keeping
 * this honest matters because a 13.3 client will read it to decide UI
 * state — placeholder "unknown" strings trained clients to ignore the
 * field, which defeats the point.
 */
export interface ServicesSnapshot {
  /** Module count as reported by the module registry at the time of snapshot. */
  modules: { count: number };
}

export interface SessionState {
  readonly status: SessionStatus;
  /** Non-null only when `status === "running"`. */
  readonly services: ServicesSnapshot | null;
}

export const INITIAL_SESSION_STATE: SessionState = Object.freeze({
  status: "stopped",
  services: null,
}) as SessionState;

// ---------------------------------------------------------------------------
// SessionEvent — tagged union pushed over events/subscribe
// ---------------------------------------------------------------------------
//
// Each variant's `data` is typed to its own shape. Clients filter on
// `kind` and the compiler narrows `data` at the consumer site — no
// `Record<string, unknown>` casting at the edges.
//
// `worktreeKey` is stamped at session/start time; for the brief window
// before the ArtifactStore-hashed key is computed (in the "starting"
// state) it falls back to the absolute worktree path. 13.3 clients
// should tolerate both representations until boot completes.

export type SessionEvent =
  | SessionStatusEvent
  | MetroStatusEvent
  | MetroLogEvent
  | DevtoolsStatusEvent
  | ModulesStateChangedEvent
  | ModulesCrashedEvent
  | ModulesFailedEvent
  | SessionLogEvent;

export interface SessionStatusEvent {
  kind: "session/status";
  worktreeKey: string;
  data: { status: SessionStatus };
}

export interface MetroStatusEvent {
  kind: "metro/status";
  worktreeKey: string;
  data: { status: string };
}

export interface MetroLogEvent {
  kind: "metro/log";
  worktreeKey: string;
  data: { line: string; stream: "stdout" | "stderr" };
}

export interface DevtoolsStatusEvent {
  kind: "devtools/status";
  worktreeKey: string;
  data: DevtoolsStatusPayload;
}

/**
 * DevTools publishes a loose `status` envelope — the manager decides
 * fields at runtime. We surface it as-is so the daemon never silently
 * drops information the TUI had access to in the pre-daemon world.
 * Consumers that care narrow at the call site.
 */
export type DevtoolsStatusPayload = Record<string, unknown>;

export interface ModulesStateChangedEvent {
  kind: "modules/state-changed";
  worktreeKey: string;
  data: { moduleId: string; scopeUnit: string; from: string; to: string };
}

export interface ModulesCrashedEvent {
  kind: "modules/crashed";
  worktreeKey: string;
  data: { moduleId: string; scopeUnit: string; reason: string };
}

export interface ModulesFailedEvent {
  kind: "modules/failed";
  worktreeKey: string;
  data: { moduleId: string; scopeUnit: string; reason: string };
}

export interface SessionLogEvent {
  kind: "session/log";
  worktreeKey: string;
  data: { level: "info" | "warn" | "error"; message: string };
}
