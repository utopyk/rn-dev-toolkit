import { BrowserWindow } from 'electron';
import type { MetroManager } from '../../src/core/metro.js';
import type { DevToolsManager } from '../../src/core/devtools.js';
import type { ArtifactStore } from '../../src/core/artifact.js';
import type { Builder } from '../../src/core/builder.js';
import type { FileWatcher } from '../../src/core/watcher.js';
import type { RunMode } from '../../src/core/types.js';
import type { DaemonSession } from '../../src/app/client/session.js';

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
  metro: MetroManager | null;
  devtools: DevToolsManager | null;
  devtoolsStarted: boolean;
  builder: Builder | null;
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

export const MAX_LOG_LINES = 1000;

export const instances = new Map<string, InstanceState>();

export const state = {
  activeInstanceId: null as string | null,
  mainWindow: null as BrowserWindow | null,
  watcher: null as FileWatcher | null,
  projectRoot: null as string | null,
  artifactStore: null as ArtifactStore | null,
  // The live daemon-client session for the active profile. Populated
  // by the first attach (either `startRealServices` on boot or
  // `instances:create` when the user runs the wizard from a no-default-
  // profile state). Used by `instances:create` to decide whether the
  // wizard should attach a fresh session or surface
  // MULTI_INSTANCE_NOT_SUPPORTED.
  daemonSession: null as DaemonSession | null,
};

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
