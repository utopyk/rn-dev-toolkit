import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonSupervisor, type SessionBootFn } from "../supervisor.js";
import { generateSessionId } from "../../core/identifiers.js";
import type { IpcServer } from "../../core/ipc.js";
import type {
  BootSessionServicesOptions,
  SessionServices,
} from "../../core/session/boot.js";
import type { Profile } from "../../core/types.js";
import type { ValidatedProfile } from "../profile-guard.js";
import type { MetroManager } from "../../core/metro.js";
import type { DevToolsManager } from "../../core/devtools.js";
import type { Builder } from "../../core/builder.js";
import type { FileWatcher } from "../../core/watcher.js";
import type { ModuleHostManager } from "../../core/module-host/manager.js";
import { CapabilityRegistry } from "../../core/module-host/capabilities.js";
import { MetroLogsStore } from "../../core/metro-logs/buffer.js";
import { HookManager } from "../../core/hooks/manager.js";
import { getDefaultAuditLog } from "../../core/audit-log.js";

// Unit coverage of the non-counting observer attach (the GUI's "watch
// the agent" tabs). The invariant this file pins: an observer
// connection receives the event fan-out but MUST NOT keep the session
// alive — the daemon has no idle reaper, so a counting observer would
// pin an agent's session (and its subprocesses + Metro port) forever
// after the agent itself released. See
// docs/plans/2026-06-05-feat-gui-observes-mcp-sessions.md and the
// `observerConnections` field on SessionEntry.
//
// Mirrors the harness in supervisor-refcount.test.ts deliberately so the
// two files A/B cleanly.

function makeProfile(projectRoot: string): ValidatedProfile {
  const profile: Profile = {
    name: "unit",
    isDefault: true,
    worktree: null,
    branch: "main",
    platform: "ios",
    mode: "quick",
    metroPort: 8081,
    devices: {},
    buildVariant: "debug",
    preflight: { checks: [], frequency: "once" },
    onSave: [],
    env: {},
    projectRoot,
  };
  return profile as ValidatedProfile;
}

function makeFakeBoot(): SessionBootFn {
  return async (opts: BootSessionServicesOptions) => {
    const services: SessionServices = {
      sessionId: opts.sessionId,
      metro: new EventEmitter() as unknown as MetroManager,
      devtools: new EventEmitter() as unknown as DevToolsManager,
      builder: new EventEmitter() as unknown as Builder,
      watcher: null as FileWatcher | null,
      moduleHost: new EventEmitter() as unknown as ModuleHostManager,
      moduleRegistry: opts.moduleRegistry,
      worktreeKey: opts.artifactStore.worktreeHash(opts.profile.worktree),
      metroLogsStore: new MetroLogsStore(),
      capabilities: new CapabilityRegistry(),
      moduleEvents: new EventEmitter(),
      hookManager: new HookManager({
        auditLog: getDefaultAuditLog(),
        daemonPid: process.pid,
      }),
      validatedProfile: opts.profile as never,
      bootTrace: [],
      acquiredModules: [],
      dispose: async () => {
        /* no-op */
      },
    };
    return services;
  };
}

const fakeIpc = {} as IpcServer;

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
}

describe("DaemonSupervisor non-counting observer attach (unit)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "observer-attach-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("observer attach lands in observerConnections, not attachedConnections; `attached` excludes it", async () => {
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: makeFakeBoot() });
    const sid = generateSessionId();
    const profile = makeProfile(tmpRoot);
    await sup.startSession(sid, profile);
    // Real attacher (the agent) first.
    sup.attachToSession(sid, "agent", profile);
    await waitFor(() => sup.getSessionState(sid)?.status === "running", 1_000);

    const r = sup.attachToSession(sid, "gui-observer", profile, true);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      // `attached` reports the real refcount only — the observer is invisible to it.
      expect(r.attached).toBe(1);
    }
    const entry = sup.getSessionEntry(sid);
    expect(entry?.attachedConnections.has("gui-observer")).toBe(false);
    expect(entry?.attachedConnections.size).toBe(1);
    expect(entry?.observerConnections.has("gui-observer")).toBe(true);
  });

  it("an observer alone never keeps the session alive: last real attacher leaving tears it down", async () => {
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: makeFakeBoot() });
    const sid = generateSessionId();
    const profile = makeProfile(tmpRoot);
    await sup.startSession(sid, profile);
    sup.attachToSession(sid, "agent", profile);
    sup.attachToSession(sid, "gui-observer", profile, true);
    await waitFor(() => sup.getSessionState(sid)?.status === "running", 1_000);

    // The agent (the only REAL attacher) releases. Even though the GUI
    // observer is still attached, the session must tear down — the
    // observer doesn't count.
    const result = await sup.releaseConnectionFromAllSessions("agent");
    expect(result.stoppedSession).toBe(true);
    expect(result.attached).toBe(0);
    expect(sup.getSessionEntry(sid)).toBeUndefined();
  });

  it("releasing an observer is a no-op — it does not tear down a session the agent still holds", async () => {
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: makeFakeBoot() });
    const sid = generateSessionId();
    const profile = makeProfile(tmpRoot);
    await sup.startSession(sid, profile);
    sup.attachToSession(sid, "agent", profile);
    sup.attachToSession(sid, "gui-observer", profile, true);
    await waitFor(() => sup.getSessionState(sid)?.status === "running", 1_000);

    const result = await sup.releaseConnectionFromAllSessions("gui-observer");
    expect(result.stoppedSession).toBe(false);
    expect(result.attached).toBe(1);
    expect(sup.getSessionState(sid)?.status).toBe("running");
    // The observer id is scrubbed so it can't leak across reconnects.
    expect(sup.getSessionEntry(sid)?.observerConnections.has("gui-observer")).toBe(false);
  });

  it("session/stop (kill-for-everyone) scrubs observerConnections too", async () => {
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: makeFakeBoot() });
    const sid = generateSessionId();
    const profile = makeProfile(tmpRoot);
    await sup.startSession(sid, profile);
    sup.attachToSession(sid, "agent", profile);
    const entry = sup.attachToSession(sid, "gui-observer", profile, true);
    expect(entry.kind).toBe("ok");
    await waitFor(() => sup.getSessionState(sid)?.status === "running", 1_000);

    await sup.stopSession(sid);
    // Entry is deleted on stop; a fresh boot with the same id can't
    // inherit a ghost observer.
    expect(sup.getSessionEntry(sid)).toBeUndefined();
  });
});
