import { BrowserWindow } from 'electron';
import type { ArtifactStore } from '../../src/core/artifact.js';
import type { FileWatcher } from '../../src/core/watcher.js';
import type { RunMode } from '../../src/core/types.js';
import type { DaemonSession } from '../../src/app/client/session.js';
import type { SessionId } from '../../src/core/identifiers.js';

export interface InstanceState {
  id: string;
  worktree: string | null;
  worktreeName: string;
  branch: string;
  port: number;
  deviceId: string | null;
  deviceName: string;
  deviceIcon: string;
  platform: 'ios' | 'android' | 'both';
  mode: RunMode;
  serviceLog: string[];
  metroLog: string[];
  metroStatus: string;
}

export interface InstanceSummary {
  id: string;
  worktreeName: string;
  branch: string;
  port: number;
  deviceName: string;
  deviceIcon: string;
  platform: string;
  metroStatus: string;
}

/**
 * Phase E1 — multi-session record. Each tab in the renderer corresponds
 * to exactly one SessionRecord; the daemon owns N concurrent sessions
 * each with its own Metro/DevTools/Builder/Watcher/ModuleHost subprocess
 * tree. The renderer keeps its `instances` concept (one per session,
 * 1:1) — `instanceId` here is the cross-reference that lets renderer
 * IPCs that take an instanceId argument resolve back to a session.
 *
 * `disconnectLogged` was previously a single module-scope flag in
 * services.ts (per § Deepening A7 in the multi-session plan); singleton-
 * by-coincidence under one session. Per-record now so a second session's
 * disconnect logs cleanly without being suppressed by the first.
 */
export interface SessionRecord {
  sessionId: SessionId;
  daemonSession: DaemonSession;
  instanceId: string;
  profileName: string | null;
  attachedAt: number;
  disconnectLogged: boolean;
}

/**
 * Cap on concurrent sessions per Electron process. v1 supports 2 visible
 * tabs (the user-facing iPhone+Android story); the data model + IPC
 * handlers tolerate up to 4 (matches `feedback_parallel_instance_requirement`).
 * `instances:create` surfaces `E_SESSION_LIMIT_REACHED` past this point.
 */
export const MAX_SESSIONS = 4;

export const MAX_LOG_LINES = 1000;

export const instances = new Map<string, InstanceState>();

export const state = {
  activeInstanceId: null as string | null,
  mainWindow: null as BrowserWindow | null,
  watcher: null as FileWatcher | null,
  projectRoot: null as string | null,
  artifactStore: null as ArtifactStore | null,
  /**
   * Phase E1 — per-session daemon sessions, keyed by SessionId. One entry
   * per renderer tab. `attachSession` writes here on every successful
   * `connectElectronToDaemon`; teardown (`instances:remove`, daemon
   * disconnect) deletes the entry. The legacy single-session fields
   * below are derived views over this Map for back-compat with code paths
   * that haven't yet been multi-session-aware (main.ts shutdown, etc.).
   */
  sessions: new Map<SessionId, SessionRecord>(),
  /**
   * SessionId of the tab currently in focus. Distinct from `activeInstanceId`
   * because the renderer addresses tabs by instanceId; this is the
   * server-side reverse-lookup target for IPCs that haven't yet been
   * threaded with an explicit sessionId. Mirrors `activeInstanceId` on
   * every `instances:setActive` — `activeInstanceId === sessions.get(activeSessionId)?.instanceId`.
   */
  activeSessionId: null as SessionId | null,
};

/**
 * Phase E1 — resolve the SessionRecord backing a renderer instance.
 * Renderer IPCs pass `instanceId`; handlers route via this lookup.
 * Returns `null` when the instance has no live daemon session (rare —
 * surfaces during the daemon-disconnect → reconnect window).
 */
export function getSessionRecordForInstance(
  instanceId: string,
): SessionRecord | null {
  for (const record of state.sessions.values()) {
    if (record.instanceId === instanceId) return record;
  }
  return null;
}

/**
 * Phase E1 — resolve the active SessionRecord. Used by handlers that
 * don't yet take an `instanceId` argument; they fall back to "whichever
 * tab the user is looking at." Single-session callers (TUI, smoke
 * fixtures with one profile) get the only session.
 */
export function getActiveSessionRecord(): SessionRecord | null {
  if (state.activeSessionId) {
    const record = state.sessions.get(state.activeSessionId);
    if (record) return record;
  }
  // Single-session back-compat: when nothing is explicitly active but
  // exactly one session exists, treat it as active.
  if (state.sessions.size === 1) {
    return state.sessions.values().next().value ?? null;
  }
  return null;
}

export function send(channel: string, ...args: any[]) {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send(channel, ...args);
  }
}

export function appendLog(instance: InstanceState, type: 'service' | 'metro', line: string) {
  const buf = type === 'service' ? instance.serviceLog : instance.metroLog;
  buf.push(line);
  if (buf.length > MAX_LOG_LINES) {
    buf.splice(0, buf.length - MAX_LOG_LINES);
  }
}

export function toSummary(inst: InstanceState): InstanceSummary {
  return {
    id: inst.id,
    worktreeName: inst.worktreeName,
    branch: inst.branch,
    port: inst.port,
    deviceName: inst.deviceName,
    deviceIcon: inst.deviceIcon,
    platform: inst.platform,
    metroStatus: inst.metroStatus,
  };
}

export function findFreePort(): number {
  const usedPorts = new Set<number>();
  for (const inst of instances.values()) {
    usedPorts.add(inst.port);
  }
  for (let port = 8081; port <= 8099; port++) {
    if (!usedPorts.has(port)) return port;
  }
  return 8100; // fallback
}
