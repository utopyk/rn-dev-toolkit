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

// Phase D4 — supervisor `stopEntry` walks the per-session
// `acquiredModules` array and calls `moduleHost.release(...)` for each
// triple BEFORE `services.dispose()` runs. The fake boot returned here
// pre-populates `services.acquiredModules` so the test asserts:
//   1. Every recorded acquire is released.
//   2. Releases fire BEFORE dispose() — the brief's "module subprocess
//      shutdown sees the refcount drop before the host capability
//      registry tears down" ordering.
//   3. A release that throws does not block subsequent releases or
//      dispose (best-effort semantics).

function makeProfile(
  projectRoot: string,
  name: string,
  metroPort: number,
): ValidatedProfile {
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

interface CleanupHarness {
  bootFn: SessionBootFn;
  /**
   * Per-session-id record of teardown-time calls. Each entry holds the
   * release tuples in invocation order plus a flag set when dispose()
   * runs, so the test can assert release-before-dispose.
   */
  trace: Map<
    SessionId,
    {
      events: Array<
        | { kind: "release"; moduleId: string; scopeUnit: string; consumerId: string }
        | { kind: "dispose" }
      >;
    }
  >;
}

function makeCleanupBoot(opts: {
  /** Triples to pre-populate on every booted session. */
  acquired: Array<{ moduleId: string; scopeUnit: string; consumerId: string }>;
  /** Optional release error injector — when present, throws for matching triples. */
  failRelease?: (moduleId: string, scopeUnit: string, consumerId: string) => boolean;
}): CleanupHarness {
  const trace = new Map<
    SessionId,
    CleanupHarness["trace"] extends Map<SessionId, infer V> ? V : never
  >();

  const bootFn: SessionBootFn = async (bootOpts: BootSessionServicesOptions) => {
    const sessionTrace: { events: Array<
      | { kind: "release"; moduleId: string; scopeUnit: string; consumerId: string }
      | { kind: "dispose" }
    > } = { events: [] };
    trace.set(bootOpts.sessionId, sessionTrace);

    const moduleHostFake = new EventEmitter() as EventEmitter & {
      release: ModuleHostManager["release"];
    };
    moduleHostFake.release = async (
      moduleId: string,
      scopeUnit: string,
      consumerId: string,
    ): Promise<void> => {
      if (opts.failRelease?.(moduleId, scopeUnit, consumerId)) {
        throw new Error(
          `release(${moduleId}, ${scopeUnit}, ${consumerId}) failed`,
        );
      }
      sessionTrace.events.push({
        kind: "release",
        moduleId,
        scopeUnit,
        consumerId,
      });
    };

    const services: SessionServices = {
      sessionId: bootOpts.sessionId,
      metro: new EventEmitter() as unknown as MetroManager,
      devtools: new EventEmitter() as unknown as DevToolsManager,
      builder: new EventEmitter() as unknown as Builder,
      watcher: null as FileWatcher | null,
      moduleHost: moduleHostFake as unknown as ModuleHostManager,
      moduleRegistry: bootOpts.moduleRegistry,
      worktreeKey: bootOpts.artifactStore.worktreeHash(bootOpts.profile.worktree),
      metroLogsStore: new MetroLogsStore(),
      capabilities: new CapabilityRegistry(),
      moduleEvents: new EventEmitter(),
      hookManager: new HookManager({
        auditLog: getDefaultAuditLog(),
        daemonPid: process.pid,
      }),
      validatedProfile: bootOpts.profile as never,
      bootTrace: [],
      // Pre-populate exactly what the production `recordAcquire` hook
      // would have pushed during boot; the supervisor's release walk
      // reads from this array.
      acquiredModules: [...opts.acquired],
      dispose: async () => {
        sessionTrace.events.push({ kind: "dispose" });
      },
    };
    return services;
  };

  return { bootFn, trace };
}

const fakeIpc = {} as IpcServer;

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("DaemonSupervisor — stopEntry module cleanup (D4)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "supervisor-module-cleanup-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("releases every acquired (moduleId, scopeUnit, consumerId) triple BEFORE dispose()", async () => {
    const sid = generateSessionId();
    const harness = makeCleanupBoot({
      acquired: [
        { moduleId: "echo", scopeUnit: "wt-1", consumerId: sid },
        { moduleId: "noop", scopeUnit: "wt-1", consumerId: sid },
      ],
    });
    const sup = new DaemonSupervisor({
      worktree: tmpRoot,
      ipc: fakeIpc,
      bootFn: harness.bootFn,
    });

    await sup.startSession(sid, makeProfile(tmpRoot, "alpha", 8091));
    await waitFor(() => sup.getSessionState(sid)?.status === "running", 1_000);

    await sup.stopSession(sid);

    const events = harness.trace.get(sid)!.events;
    expect(events).toEqual([
      { kind: "release", moduleId: "echo", scopeUnit: "wt-1", consumerId: sid },
      { kind: "release", moduleId: "noop", scopeUnit: "wt-1", consumerId: sid },
      { kind: "dispose" },
    ]);
  });

  it("concurrent stop of two sessions sharing a (moduleId, scopeUnit) calls release per session", async () => {
    const sidA = generateSessionId();
    const sidB = generateSessionId();
    const harness = makeCleanupBoot({
      acquired: [
        // Each session ends up with its own consumerId entry — the
        // production seam closes over the session's own sessionId.
        // We hand-stamp them per-session here so the trace assertion
        // checks that both releases route through their own session
        // services (the cross-session manager-side refcount is pinned
        // separately in refcount-cross-session.test.ts).
        { moduleId: "echo", scopeUnit: "wt-shared", consumerId: "PER_SESSION" },
      ],
    });
    // Rewrap so each session's acquiredModules carries its own sessionId.
    const wrappedBootFn: SessionBootFn = async (bootOpts) => {
      const services = await harness.bootFn(bootOpts);
      services.acquiredModules = services.acquiredModules.map((a) => ({
        ...a,
        consumerId: bootOpts.sessionId,
      }));
      return services;
    };
    const sup = new DaemonSupervisor({
      worktree: tmpRoot,
      ipc: fakeIpc,
      bootFn: wrappedBootFn,
    });

    await sup.startSession(sidA, makeProfile(tmpRoot, "alpha", 8092));
    await sup.startSession(sidB, makeProfile(tmpRoot, "beta", 8093));
    await waitFor(() => sup.getSessionState(sidA)?.status === "running", 1_000);
    await waitFor(() => sup.getSessionState(sidB)?.status === "running", 1_000);

    await Promise.all([sup.stopSession(sidA), sup.stopSession(sidB)]);

    const a = harness.trace.get(sidA)!.events;
    const b = harness.trace.get(sidB)!.events;
    expect(a).toContainEqual({
      kind: "release",
      moduleId: "echo",
      scopeUnit: "wt-shared",
      consumerId: sidA,
    });
    expect(b).toContainEqual({
      kind: "release",
      moduleId: "echo",
      scopeUnit: "wt-shared",
      consumerId: sidB,
    });
    // dispose always trails the release for each session.
    expect(a[a.length - 1]).toEqual({ kind: "dispose" });
    expect(b[b.length - 1]).toEqual({ kind: "dispose" });
  });

  it("a release that throws does not block subsequent releases or dispose", async () => {
    const sid = generateSessionId();
    const harness = makeCleanupBoot({
      acquired: [
        { moduleId: "boom", scopeUnit: "wt-1", consumerId: sid },
        { moduleId: "ok", scopeUnit: "wt-1", consumerId: sid },
      ],
      failRelease: (moduleId) => moduleId === "boom",
    });
    const sup = new DaemonSupervisor({
      worktree: tmpRoot,
      ipc: fakeIpc,
      bootFn: harness.bootFn,
    });

    await sup.startSession(sid, makeProfile(tmpRoot, "alpha", 8094));
    await waitFor(() => sup.getSessionState(sid)?.status === "running", 1_000);

    await sup.stopSession(sid);

    const events = harness.trace.get(sid)!.events;
    // The first release threw (so it was NOT recorded), but the
    // second release still ran and dispose() still followed.
    expect(events).toEqual([
      { kind: "release", moduleId: "ok", scopeUnit: "wt-1", consumerId: sid },
      { kind: "dispose" },
    ]);
  });
});
