// Per-daemon session model. Phase 13.1 ships only the type surface;
// the state transitions and service wiring land in Phase 13.2 when
// Metro/DevTools/ModuleHost move into the daemon.

export type SessionStatus = "stopped" | "starting" | "running" | "stopping";

export interface SessionState {
  readonly status: SessionStatus;
}

export const INITIAL_SESSION_STATE: SessionState = Object.freeze({
  status: "stopped",
}) as SessionState;
