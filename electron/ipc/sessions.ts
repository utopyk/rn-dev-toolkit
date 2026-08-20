// SessionsWatcher — the GUI's "watch the agent work" discovery loop.
//
// rn-dev runs ONE daemon per project, shared by the TUI, the Electron
// GUI, and the MCP server. When an LLM drives the tool over MCP it
// creates real daemon sessions the GUI never knew about. This watcher
// closes that gap: it polls the daemon's `sessions/list` and auto-
// surfaces any session this Electron process did NOT create as a
// read-only "observe" tab (badged 🤖 in the renderer), reusing the
// whole per-session machinery (attach-by-id → SessionRecord →
// wireInstanceEvents → DevToolsView).
//
// Two hard constraints shaped the design:
//
//  1. REFCOUNT-FREE DISCOVERY. `IpcClient.send` opens a fresh one-shot
//     socket per call and never registers an event listener, so polling
//     `sessions/list` takes no session refcount. We deliberately do NOT
//     use `connectToDaemon` here — it COLD-SPAWNS a daemon when none is
//     running, which would defeat the purpose. We gate on the exported
//     `isDaemonAlive` (which also handles the stale-socket case) and
//     only talk to a daemon that already exists.
//
//  2. OBSERVING MUST NEVER KEEP A SESSION ALIVE. The attach itself uses
//     the daemon's non-counting observer mode (see `observerConnections`
//     in src/daemon/supervisor.ts). The daemon does NOT close observer
//     sockets on teardown, so the authoritative "agent session ended"
//     signal is this poller noticing the session vanished from
//     `sessions/list` (or going `stopped`) — at which point we tear the
//     observe tab down and disconnect our socket.
//
// See docs/plans/2026-06-05-feat-gui-observes-mcp-sessions.md.

import { join, resolve } from 'node:path';
import { IpcClient } from '../../src/core/ipc.js';
import { isDaemonAlive } from '../../src/daemon/spawn.js';
import { asSessionId, type SessionId } from '../../src/core/identifiers.js';
import { attachDaemonSession, wireInstanceEvents } from './services.js';
import {
  state,
  instances,
  send,
  toSummary,
  countObservedSessions,
  MAX_OBSERVED_SESSIONS,
  type InstanceState,
  type SessionRecord,
} from './state.js';

/** Minimal shape of a `sessions/list` entry (defensively parsed). */
export interface ListedSession {
  sessionId: SessionId;
  profileName: string | null;
  worktreeKey: string;
  status: string;
  /**
   * Current git branch of the daemon's worktree — the ground-truth
   * "which tree am I serving" signal for both this GUI tab and the
   * `sessions/list` MCP tool. Null on non-git worktrees / detached HEAD /
   * old daemons that don't carry the field.
   */
  currentBranch: string | null;
  /** Short (7-char) HEAD SHA; null on non-git or older daemons. */
  headSha: string | null;
}

/**
 * Pure reconcile planner — the part with all the edge cases, kept side-
 * effect-free so vitest can pin classification / single-flight / teardown
 * / cap without an IpcClient or a live daemon.
 *
 * Given the daemon's session list and the GUI's current state, decide:
 *   - `toObserve`  — external sessions to attach read-only (bounded by
 *                    the observe cap, excluding ones we own or are
 *                    mid-attach on).
 *   - `toTeardown` — observed sessions that vanished from the list (or
 *                    went stopped/stopping) → the agent ended them.
 *   - `dropped`    — observe candidates left out because the cap was hit
 *                    (surfaced to the user; never silently truncated).
 */
export function planSessionReconcile(
  listed: ListedSession[],
  opts: {
    ownSessions: ReadonlyMap<SessionId, { sessionId: SessionId; observed: boolean; instanceId: string }>;
    inFlight: ReadonlySet<SessionId>;
    maxObserved: number;
  },
): { toObserve: ListedSession[]; toTeardown: SessionId[]; dropped: number } {
  const isGone = (s: ListedSession | undefined): boolean =>
    !s || s.status === 'stopped' || s.status === 'stopping';

  const toTeardown: SessionId[] = [];
  for (const rec of opts.ownSessions.values()) {
    if (!rec.observed) continue;
    const found = listed.find((s) => s.sessionId === rec.sessionId);
    if (isGone(found)) toTeardown.push(rec.sessionId);
  }

  // How many observe slots are already spoken for (live + in-flight),
  // minus the ones we're about to tear down.
  let observedLive = 0;
  for (const rec of opts.ownSessions.values()) {
    if (rec.observed && !toTeardown.includes(rec.sessionId)) observedLive++;
  }

  const candidates = listed.filter(
    (s) =>
      !opts.ownSessions.has(s.sessionId) && // not ours, not already observed
      !opts.inFlight.has(s.sessionId) && // not mid-attach (single-flight)
      s.status !== 'stopped' &&
      s.status !== 'stopping',
  );

  const budget = Math.max(0, opts.maxObserved - observedLive - opts.inFlight.size);
  const toObserve = candidates.slice(0, budget);
  const dropped = candidates.length - toObserve.length;
  return { toObserve, toTeardown, dropped };
}

/**
 * Pure helper — does the daemon's session list have a non-terminal session
 * for `profileName`? Used by `startRealServices` to short-circuit the
 * primary-tab boot when an agent (or any other client) already booted
 * this profile's session: without it, the GUI's own attach AND the
 * `SessionsWatcher`'s independent observer attach would both surface
 * tabs for the same one session.
 */
export function findRunnableSessionForProfile(
  listed: readonly ListedSession[],
  profileName: string,
): ListedSession | null {
  for (const s of listed) {
    if (s.profileName !== profileName) continue;
    if (s.status === 'stopped' || s.status === 'stopping') continue;
    return s;
  }
  return null;
}

/** Resolve the daemon socket path, honoring the RN_DEV_DAEMON_SOCK hook. */
function resolveSockPath(projectRoot: string): string {
  const envSock = process.env.RN_DEV_DAEMON_SOCK;
  if (typeof envSock === 'string' && envSock.length > 0) return envSock;
  return join(resolve(projectRoot), '.rn-dev', 'sock');
}

/**
 * One-shot peek at the daemon's session list. Returns `null` when no
 * daemon is alive (the GUI's startup race) or when the request errors.
 * Caller filters by profile name via `findRunnableSessionForProfile`.
 */
export async function peekDaemonSessions(
  projectRoot: string,
): Promise<ListedSession[] | null> {
  const sockPath = resolveSockPath(projectRoot);
  if (!(await isDaemonAlive(sockPath))) return null;
  try {
    const client = new IpcClient(sockPath);
    const resp = await client.send({
      type: 'command',
      action: 'sessions/list',
      id: `gui-peek-${Date.now()}`,
    });
    return parseSessionsList(resp.payload);
  } catch {
    return null;
  }
}

/**
 * Module-level in-flight registry so the `SessionsWatcher.tick` and
 * `startRealServices` code paths can't race two attaches for the same
 * sessionId. `state.sessions` is updated synchronously inside
 * `attachDaemonSession` AFTER its async daemon handshake — checking the
 * map alone leaves a window where two awaited attaches both proceed.
 * Using a Map (not a Set) lets a second caller AWAIT the in-flight
 * attach's promise rather than bail with `null`: without this,
 * `startRealServices` would see the watcher's attach in progress, return
 * null, and fall through to the primary-tab boot path — re-introducing
 * the duplicate this fix is meant to prevent.
 */
const pendingObserves = new Map<SessionId, Promise<SessionRecord | null>>();

/**
 * Attach to an existing agent/MCP session as a read-only observer
 * (🤖 tab). Shared by `SessionsWatcher.tick` (poll path) and
 * `startRealServices` (boot-time short-circuit when an agent session
 * already exists for the GUI's default profile). Idempotent: returns
 * `null` if the session is already observed or its attach is mid-flight.
 *
 * The daemon uses non-counting observer attach (see `observerConnections`
 * in src/daemon/supervisor.ts), so the GUI never keeps the session alive.
 */
export async function attachAgentSessionAsObserver(
  projectRoot: string,
  listed: ListedSession,
): Promise<SessionRecord | null> {
  // Already attached (the watcher tick beat us, or vice-versa). Return
  // the live record so `startRealServices` can short-circuit on its
  // existence rather than falling through and double-booting the same
  // session as a primary tab.
  const existing = state.sessions.get(listed.sessionId);
  if (existing) return existing;
  // Attach in flight by another caller — await its result instead of
  // bailing with null. Returning null here would let `startRealServices`
  // fall through to the primary-tab boot, re-introducing the duplicate.
  const inFlight = pendingObserves.get(listed.sessionId);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<SessionRecord | null> => {
    const instanceId = `agent-${listed.sessionId.slice(0, 8)}`;
    try {
      const record = await attachDaemonSession({
        projectRoot,
        instanceId,
        observe: {
          sessionId: listed.sessionId,
          worktreeKeyHint: listed.worktreeKey,
        },
      });

      // Derive the Metro port — sessions/list doesn't carry it, but the
      // attached session's metro adapter does. Port stays 0 if the agent
      // session hasn't published a Metro instance yet (DevToolsView then
      // shows its "connecting" state until a later observe re-runs).
      let port = 0;
      let metroStatus = listed.status;
      try {
        const inst = await record.daemonSession.metro.getInstance();
        if (inst) {
          port = inst.port;
          metroStatus = inst.status;
        }
      } catch {
        /* leave port 0 — non-fatal */
      }

      const worktreeName = listed.profileName ?? 'agent';
      const instance: InstanceState = {
        id: instanceId,
        worktree: null,
        worktreeName,
        // Prefer the daemon's live branch over the profile name, which
        // was only a placeholder here. Falls back to the profile name for
        // older daemons that don't publish `currentBranch`.
        branch: listed.currentBranch ?? listed.profileName ?? '·',
        headSha: listed.headSha,
        port,
        deviceId: null,
        deviceName: 'agent session',
        deviceIcon: '🤖',
        platform: 'both',
        mode: 'quick',
        serviceLog: [],
        metroLog: [],
        metroStatus,
        observed: true,
      };
      instances.set(instanceId, instance);
      send('instance:created', toSummary(instance));
      send('instance:log', {
        instanceId,
        text: `👁 Observing agent session ${listed.sessionId.slice(0, 8)} (read-only).`,
      });
      wireInstanceEvents(instance, record.daemonSession);
      return record;
    } catch {
      // E_UNKNOWN_SESSION (session vanished mid-poll), boot failed, or the
      // attach watchdog tripped — all normal races. No tab was created
      // yet; skip quietly and let the next tick retry if it reappears.
      return null;
    }
  })();

  pendingObserves.set(listed.sessionId, promise);
  try {
    return await promise;
  } finally {
    pendingObserves.delete(listed.sessionId);
  }
}

function parseSessionsList(payload: unknown): ListedSession[] {
  if (!payload || typeof payload !== 'object') return [];
  const arr = (payload as { sessions?: unknown }).sessions;
  if (!Array.isArray(arr)) return [];
  const out: ListedSession[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.sessionId !== 'string' || r.sessionId.length === 0) continue;
    if (typeof r.status !== 'string') continue;
    out.push({
      sessionId: asSessionId(r.sessionId),
      profileName: typeof r.profileName === 'string' ? r.profileName : null,
      worktreeKey: typeof r.worktreeKey === 'string' ? r.worktreeKey : '',
      status: r.status,
      currentBranch:
        typeof r.currentBranch === 'string' && r.currentBranch.length > 0
          ? r.currentBranch
          : null,
      headSha:
        typeof r.headSha === 'string' && r.headSha.length > 0
          ? r.headSha
          : null,
    });
  }
  return out;
}

export class SessionsWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private client: IpcClient | null = null;
  private clientSockPath: string | null = null;
  private readonly observingInFlight = new Set<SessionId>();
  private lastDroppedLogged = 0;

  constructor(private readonly intervalMs = 1500) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        if (this.running) this.scheduleNext();
      });
    }, this.intervalMs);
  }

  private async tick(): Promise<void> {
    const projectRoot = state.projectRoot;
    if (!projectRoot) return; // services not started yet
    const sockPath = resolveSockPath(projectRoot);
    if (!(await isDaemonAlive(sockPath))) return; // no daemon → nothing to observe

    let listed: ListedSession[];
    try {
      listed = await this.listSessions(sockPath);
    } catch {
      // Transient (daemon restarting, socket mid-handshake) — retry next tick.
      return;
    }

    const plan = planSessionReconcile(listed, {
      ownSessions: state.sessions,
      inFlight: this.observingInFlight,
      maxObserved: MAX_OBSERVED_SESSIONS,
    });

    for (const sid of plan.toTeardown) {
      const record = state.sessions.get(sid);
      if (record) this.teardownObserved(record);
    }
    for (const s of plan.toObserve) {
      void this.observe(s, projectRoot);
    }

    // Surface a capped/dropped count once (don't spam every 1.5s).
    if (plan.dropped !== this.lastDroppedLogged) {
      if (plan.dropped > 0) {
        send(
          'service:log',
          `👁 ${plan.dropped} more agent session(s) not shown — observe cap is ${MAX_OBSERVED_SESSIONS}.`,
        );
      }
      this.lastDroppedLogged = plan.dropped;
    }
  }

  private async listSessions(sockPath: string): Promise<ListedSession[]> {
    if (!this.client || this.clientSockPath !== sockPath) {
      this.client = new IpcClient(sockPath);
      this.clientSockPath = sockPath;
    }
    const resp = await this.client.send({
      type: 'command',
      action: 'sessions/list',
      id: `gui-watch-${Date.now()}`,
    });
    return parseSessionsList(resp.payload);
  }

  private async observe(s: ListedSession, projectRoot: string): Promise<void> {
    this.observingInFlight.add(s.sessionId);
    try {
      await attachAgentSessionAsObserver(projectRoot, s);
    } finally {
      this.observingInFlight.delete(s.sessionId);
    }
  }

  private teardownObserved(record: SessionRecord): void {
    state.sessions.delete(record.sessionId);
    if (state.activeSessionId === record.sessionId) {
      state.activeSessionId = state.sessions.keys().next().value ?? null;
    }
    // Detach our read-only observer socket ONLY. The agent's session is
    // already gone (or going) — disconnect() is idempotent and never
    // sends session/stop.
    record.daemonSession.disconnect();
    instances.delete(record.instanceId);
    if (state.activeInstanceId === record.instanceId) {
      state.activeInstanceId = instances.keys().next().value ?? null;
    }
    send('instance:removed', record.instanceId);
    send('service:log', '👁 Agent session ended — observe tab closed.');
  }
}
