import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonSupervisor, type SessionBootFn } from "../supervisor.js";
import { generateSessionId, type SessionId } from "../../core/identifiers.js";
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
import type { SessionEvent } from "../session.js";

// Phase D1 — multi-session unit coverage of DaemonSupervisor. Pins the
// per-entry state machine and event-tagging invariants that the new
// `Map<SessionId, SessionEntry>` makes possible. Integration coverage
// at the wire boundary lands with D2.

function makeProfile(
  projectRoot: string,
  name: string,
  metroPort: number,
): ValidatedProfile {
  // Phase D2 — supervisor.startSession + attachToSession take a
  // branded ValidatedProfile. Unit fixtures hand-build the shape +
  // assert the brand without re-running validateProfile (the shape is
  // exhaustive and the brand is a phantom type). Production code goes
  // through profile-guard at every wire boundary.
  const profile: Profile = {
    name,
    isDefault: false,
    worktree: null,
    branch: "main",
    platform: "ios",
    mode: "quick",
    metroPort,
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
      dispose: async () => {
        /* no-op */
      },
    };
    return services;
  };
}

const fakeIpc = {} as IpcServer;

describe("DaemonSupervisor multi-session (D1)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "supervisor-multi-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("two concurrent startSession calls with distinct sessionIds + distinct ports both reach running", async () => {
    const sup = new DaemonSupervisor({
      worktree: tmpRoot,
      ipc: fakeIpc,
      bootFn: makeFakeBoot(),
    });

    const sidA = generateSessionId();
    const sidB = generateSessionId();
    const profileA = makeProfile(tmpRoot, "alpha", 8081);
    const profileB = makeProfile(tmpRoot, "beta", 8082);

    const [resA, resB] = await Promise.all([
      sup.startSession(sidA, profileA),
      sup.startSession(sidB, profileB),
    ]);
    expect(resA.kind).toBe("ok");
    expect(resB.kind).toBe("ok");
    if (resA.kind === "ok") expect(resA.sessionId).toBe(sidA);
    if (resB.kind === "ok") expect(resB.sessionId).toBe(sidB);

    await waitFor(() => sup.getSessionState(sidA)?.status === "running", 1_000);
    await waitFor(() => sup.getSessionState(sidB)?.status === "running", 1_000);

    expect(sup.listSessions().map((e) => e.sessionId).sort()).toEqual(
      [sidA, sidB].sort(),
    );
  });

  it("events from concurrent sessions arrive tagged with the correct sessionId", async () => {
    const sup = new DaemonSupervisor({
      worktree: tmpRoot,
      ipc: fakeIpc,
      bootFn: makeFakeBoot(),
    });

    const captured: SessionEvent[] = [];
    sup.onEvent((evt) => captured.push(evt));

    const sidA = generateSessionId();
    const sidB = generateSessionId();
    await sup.startSession(sidA, makeProfile(tmpRoot, "alpha", 8081));
    await sup.startSession(sidB, makeProfile(tmpRoot, "beta", 8082));

    await waitFor(() => sup.getSessionState(sidA)?.status === "running", 1_000);
    await waitFor(() => sup.getSessionState(sidB)?.status === "running", 1_000);

    // Every event the supervisor fanned out must be sessionId-tagged.
    // Each session emits at least two session/status events (starting +
    // running) plus any session/log lines from boot — the count varies
    // by harness setup so assert only the tagging invariant + per-side
    // presence of the terminal "running" status.
    expect(captured.length).toBeGreaterThan(0);
    const sessionIds = new Set(captured.map((e) => e.sessionId));
    expect(sessionIds.has(sidA)).toBe(true);
    expect(sessionIds.has(sidB)).toBe(true);
    for (const evt of captured) {
      expect(typeof evt.sessionId).toBe("string");
      expect(evt.sessionId.length).toBeGreaterThan(0);
    }
    const runningA = captured.find(
      (e) =>
        e.kind === "session/status" &&
        e.sessionId === sidA &&
        e.data.status === "running",
    );
    const runningB = captured.find(
      (e) =>
        e.kind === "session/status" &&
        e.sessionId === sidB &&
        e.data.status === "running",
    );
    expect(runningA).toBeDefined();
    expect(runningB).toBeDefined();
  });

  it("startSession with a duplicate sessionId returns E_SESSION_ALREADY_EXISTS", async () => {
    const sup = new DaemonSupervisor({
      worktree: tmpRoot,
      ipc: fakeIpc,
      bootFn: makeFakeBoot(),
    });
    const sid = generateSessionId();
    const first = await sup.startSession(sid, makeProfile(tmpRoot, "alpha", 8081));
    expect(first.kind).toBe("ok");

    const dup = await sup.startSession(sid, makeProfile(tmpRoot, "beta", 8082));
    expect(dup.kind).toBe("error");
    if (dup.kind === "error") {
      expect(dup.code).toBe("E_SESSION_ALREADY_EXISTS");
    }
  });

  it("startSession with a colliding metroPort returns E_PORT_CONFLICT", async () => {
    const sup = new DaemonSupervisor({
      worktree: tmpRoot,
      ipc: fakeIpc,
      bootFn: makeFakeBoot(),
    });
    const first = await sup.startSession(
      generateSessionId(),
      makeProfile(tmpRoot, "alpha", 8081),
    );
    expect(first.kind).toBe("ok");

    const collide = await sup.startSession(
      generateSessionId(),
      makeProfile(tmpRoot, "beta", 8081),
    );
    expect(collide.kind).toBe("error");
    if (collide.kind === "error") {
      expect(collide.code).toBe("E_PORT_CONFLICT");
    }
  });

  it("attachToSession with an unknown sessionId returns E_UNKNOWN_SESSION", () => {
    const sup = new DaemonSupervisor({
      worktree: tmpRoot,
      ipc: fakeIpc,
      bootFn: makeFakeBoot(),
    });
    const result = sup.attachToSession(
      "00000000-0000-0000-0000-000000000000" as SessionId,
      "c1",
      makeProfile(tmpRoot, "alpha", 8081),
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("E_UNKNOWN_SESSION");
    }
  });

  it("stopSession tears down one session and leaves siblings running", async () => {
    const sup = new DaemonSupervisor({
      worktree: tmpRoot,
      ipc: fakeIpc,
      bootFn: makeFakeBoot(),
    });
    const sidA = generateSessionId();
    const sidB = generateSessionId();
    await sup.startSession(sidA, makeProfile(tmpRoot, "alpha", 8081));
    await sup.startSession(sidB, makeProfile(tmpRoot, "beta", 8082));
    await waitFor(() => sup.getSessionState(sidA)?.status === "running", 1_000);
    await waitFor(() => sup.getSessionState(sidB)?.status === "running", 1_000);

    const stopResult = await sup.stopSession(sidA);
    expect(stopResult.kind).toBe("ok");
    expect(sup.getSessionEntry(sidA)).toBeUndefined();
    expect(sup.getSessionState(sidB)?.status).toBe("running");
  });

  it("findSessionByProfile returns the right entry; null for stopped/missing", async () => {
    const sup = new DaemonSupervisor({
      worktree: tmpRoot,
      ipc: fakeIpc,
      bootFn: makeFakeBoot(),
    });
    const sidA = generateSessionId();
    await sup.startSession(sidA, makeProfile(tmpRoot, "alpha", 8081));
    await waitFor(() => sup.getSessionState(sidA)?.status === "running", 1_000);

    const hit = sup.findSessionByProfile("alpha", null);
    expect(hit?.sessionId).toBe(sidA);

    const miss = sup.findSessionByProfile("nonexistent", null);
    expect(miss).toBeUndefined();

    // Stop the session and confirm findSessionByProfile rejects stopped entries.
    await sup.stopSession(sidA);
    const afterStop = sup.findSessionByProfile("alpha", null);
    expect(afterStop).toBeUndefined();
  });

  it("shutdown stops every active session", async () => {
    const sup = new DaemonSupervisor({
      worktree: tmpRoot,
      ipc: fakeIpc,
      bootFn: makeFakeBoot(),
    });
    const sidA = generateSessionId();
    const sidB = generateSessionId();
    await sup.startSession(sidA, makeProfile(tmpRoot, "alpha", 8081));
    await sup.startSession(sidB, makeProfile(tmpRoot, "beta", 8082));
    await waitFor(() => sup.getSessionState(sidA)?.status === "running", 1_000);
    await waitFor(() => sup.getSessionState(sidB)?.status === "running", 1_000);

    await sup.shutdown();
    expect(sup.listSessions()).toHaveLength(0);
  });
});

async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
}
