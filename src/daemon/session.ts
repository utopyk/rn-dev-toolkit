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

import type { SessionId } from "../core/identifiers.js";

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
//
// Phase D1 — every variant gains `sessionId: SessionId` (DR-5). Both
// fields coexist: `worktreeKey` keeps the existing service-internal
// lookup path working in MetroManager/DevToolsManager; `sessionId` is
// the new identity dimension that lets renderer + MCP route events to
// the right tab/agent context. Lifted into the generic envelope so a
// future variant addition can't accidentally omit one of the two.

/**
 * Common envelope for every SessionEvent variant. Discriminated by
 * `kind`; carries both `worktreeKey` (legacy service-keying dimension)
 * and `sessionId` (D1 identity dimension). Variants extend by binding
 * `kind` and `data`.
 */
interface SessionEventEnvelope<K extends string, D> {
  kind: K;
  worktreeKey: string;
  sessionId: SessionId;
  data: D;
}

export type SessionEvent =
  | SessionStatusEvent
  | MetroStatusEvent
  | MetroLogEvent
  | DevtoolsStatusEvent
  | DevtoolsDeltaEvent
  | ModulesStateChangedEvent
  | ModulesCrashedEvent
  | ModulesFailedEvent
  | BuilderLineEvent
  | BuilderProgressEvent
  | BuilderDoneEvent
  | WatcherActionCompleteEvent
  | SessionLogEvent
  | HooksFiredEvent;

export type SessionStatusEvent = SessionEventEnvelope<
  "session/status",
  { status: SessionStatus }
>;

export type MetroStatusEvent = SessionEventEnvelope<
  "metro/status",
  { status: string }
>;

export type MetroLogEvent = SessionEventEnvelope<
  "metro/log",
  { line: string; stream: "stdout" | "stderr" }
>;

export type DevtoolsStatusEvent = SessionEventEnvelope<
  "devtools/status",
  DevtoolsStatusPayload
>;

/**
 * DevTools publishes a loose `status` envelope — the manager decides
 * fields at runtime. We surface it as-is so the daemon never silently
 * drops information the TUI had access to in the pre-daemon world.
 * Consumers that care narrow at the call site.
 */
export type DevtoolsStatusPayload = Record<string, unknown>;

export type ModulesStateChangedEvent = SessionEventEnvelope<
  "modules/state-changed",
  { moduleId: string; scopeUnit: string; from: string; to: string }
>;

export type ModulesCrashedEvent = SessionEventEnvelope<
  "modules/crashed",
  { moduleId: string; scopeUnit: string; reason: string }
>;

export type ModulesFailedEvent = SessionEventEnvelope<
  "modules/failed",
  { moduleId: string; scopeUnit: string; reason: string }
>;

/**
 * Coalesced network-capture delta fired by DevToolsManager every 100ms
 * while a target session is attached. The payload carries identifiers
 * only — clients re-query `devtools/listNetwork` to resolve entries.
 */
export type DevtoolsDeltaEvent = SessionEventEnvelope<
  "devtools/delta",
  {
    addedIds: readonly string[];
    updatedIds: readonly string[];
    evictedIds: readonly string[];
  }
>;

// Phase H2b — `source` discriminator on every Builder wire event:
// "builtin" today, "override" once H4's BuildHostCapability wrapper
// starts synthesizing events from override hook scripts. Lets MCP
// subscribers + the renderer distinguish "build failed" from "override
// hook crashed" without re-checking the daemon's underlying state.
export type BuilderLineEvent = SessionEventEnvelope<
  "builder/line",
  {
    source: "builtin" | "override";
    text: string;
    stream: "stdout" | "stderr";
    replace?: boolean;
  }
>;

export type BuilderProgressEvent = SessionEventEnvelope<
  "builder/progress",
  { source: "builtin" | "override"; phase: string }
>;

export type BuilderDoneEvent = SessionEventEnvelope<
  "builder/done",
  {
    source: "builtin" | "override";
    success: boolean;
    errors: BuilderErrorSnapshot[];
    platform?: "ios" | "android";
  }
>;

/**
 * Phase H2g — fired on every HookManager hook completion (success and
 * fail). Rides the existing events/subscribe channel so MCP agents and
 * the renderer can answer "did my hook just run?" without grepping the
 * daemon log. The shape mirrors the HookManager's internal `hooks/fired`
 * emit but with `worktreeKey` for fan-out routing.
 */
export type HooksFiredEvent = SessionEventEnvelope<
  "hooks/fired",
  {
    target: string;
    ok: boolean;
    fired: number;
    skipped: number;
    failureCount: number;
  }
>;

/**
 * Shape pushed over the wire for BuildError. Mirrors core/types.ts
 * BuildError minus the heavy `rawOutput` — clients use builder/line
 * events for the full output stream and don't need it twice.
 */
export interface BuilderErrorSnapshot {
  source: "xcodebuild" | "gradle";
  summary: string;
  file?: string;
  line?: number;
  reason?: string;
  suggestion?: string;
}

export type WatcherActionCompleteEvent = SessionEventEnvelope<
  "watcher/action-complete",
  {
    name: string;
    result: {
      action: string;
      success: boolean;
      output: string;
      durationMs: number;
    };
  }
>;

export type SessionLogEvent = SessionEventEnvelope<
  "session/log",
  { level: "info" | "warn" | "error"; message: string }
>;
