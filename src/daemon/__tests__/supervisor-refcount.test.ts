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
import type {
  MetroManager,
} from "../../core/metro.js";
import type {
  DevToolsManager,
} from "../../core/devtools.js";
import type { Builder } from "../../core/builder.js";
import type { FileWatcher } from "../../core/watcher.js";
import type {
  ModuleHostManager,
} from "../../core/module-host/manager.js";
import { CapabilityRegistry } from "../../core/module-host/capabilities.js";
import { MetroLogsStore } from "../../core/metro-logs/buffer.js";
import { HookManager } from "../../core/hooks/manager.js";
import { getDefaultAuditLog } from "../../core/audit-log.js";

// Unit-level coverage of the per-session refcount semantics. Phase 13.5
// established the invariants (attach during starting, idempotent
// attach, release-by-conn isolation, stop scrubs the set, boot-failure
// clears the set); Phase D2 deletes the legacy single-session facade
// and these tests now drive the per-session API directly. The
// invariants are unchanged — only the verbs.
//
// Integration coverage at src/app/client/__tests__/session-release.test.ts
// exercises the wire path; this file pins the in-memory state machine
// transitions in isolation so refcount edge cases regress here before
// the integration suite even sees them.

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

/**
 * Minimal-yet-complete fake bootFn. Returns a SessionServices stub whose
 * dispose() resolves quickly. Tests can opt into a deferred-resolution
 * variant via `makeDeferredBoot()` to exercise concurrent-attach-while-
 * starting paths.
 */
function makeFakeBoot(): { boot: SessionBootFn; lastServices: { current: SessionServices | null } } {
  const lastServices = { current: null as SessionServices | null };
  const boot: SessionBootFn = async (opts: BootSessionServicesOptions) => {
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
      // Phase H2g — minimal stub; refcount tests don't fire hooks so the
      // brand integrity isn't load-bearing here.
      validatedProfile: opts.profile as never,
      bootTrace: [],
      dispose: async () => {
        /* no-op */
      },
    };
    lastServices.current = services;
    return services;
  };
  return { boot, lastServices };
}

function makeDeferredBoot(): {
  boot: SessionBootFn;
  resolve: () => void;
  reject: (err: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const gate = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const { boot: fastBoot } = makeFakeBoot();
  const boot: SessionBootFn = async (opts) => {
    await gate;
    return fastBoot(opts);
  };
  return { boot, resolve, reject };
}

const fakeIpc = {} as IpcServer;

// ---------------------------------------------------------------------------
// Phase D2 — supervisor-attach shim
//
// The legacy `supervisor.attach(connId, { profile })` facade is gone;
// the dispatcher layer in `src/daemon/index.ts` now drives the boot-or-join
// dance directly (findSessionByProfile → startSession-if-missing →
// attachToSession). This shim replays the dispatcher's logic at the unit
// level so the refcount invariants — first-attacher boots, joiner
// short-circuits, idempotent attach, attach-during-starting queues into
// the set — stay pinned with their existing assertions.
//
// This is test-fixture code by design: it deliberately compresses what
// the dispatcher's `handleEventsSubscribe` does (without the wire +
// subscribe-registry + bootLock layers) so the unit-level invariants
// can be asserted without booting an integration daemon.
// ---------------------------------------------------------------------------

type AttachShimResult =
  | { kind: "ok"; status: string; started: boolean; attached: number }
  | { kind: "error"; code: string; message: string };

async function attachShim(
  sup: DaemonSupervisor,
  connId: string,
  opts: { profile: ValidatedProfile },
): Promise<AttachShimResult> {
  const existing = sup.findSessionByProfile(opts.profile.name, opts.profile.worktree);
  if (existing) {
    if (existing.state.status === "stopping") {
      return {
        kind: "error",
        code: "E_SESSION_STOPPING",
        message: "session is stopping",
      };
    }
    const r = sup.attachToSession(existing.sessionId, connId, opts.profile);
    if (r.kind === "error") return r;
    return { kind: "ok", status: r.status, started: false, attached: r.attached };
  }
  const sid = generateSessionId();
  const start = await sup.startSession(sid, opts.profile);
  if (start.kind === "error") {
    return { kind: "error", code: start.code, message: start.message };
  }
  const r = sup.attachToSession(sid, connId, opts.profile);
  if (r.kind === "error") return r;
  // First-attacher status comes from startSession's return value
  // (always "starting"), NOT from the entry's current state — fake
  // boots resolve fast enough that `attachToSession` can read a
  // "running" entry on the same microtask drain that returned
  // startSession's `{ status: "starting" }`. Test fixtures assert
  // "starting" here as the shape contract; the runtime transitions
  // are checked separately via `getState`.
  return { kind: "ok", status: start.status, started: true, attached: r.attached };
}

async function stopShim(sup: DaemonSupervisor): Promise<void> {
  const active = sup.listSessions().filter((e) => e.state.status !== "stopped");
  for (const entry of active) await sup.stopSession(entry.sessionId);
}

function getState(sup: DaemonSupervisor): {
  status: "stopped" | "starting" | "running" | "stopping";
} {
  for (const e of sup.listSessions()) {
    if (e.state.status !== "stopped") return e.state;
  }
  return { status: "stopped" };
}

function getAttachedCount(sup: DaemonSupervisor): number {
  return sup.listSessions().reduce((a, e) => a + e.attachedConnections.size, 0);
}

describe("DaemonSupervisor per-session refcount (unit)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "supervisor-refcount-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("first attacher boots the session; getAttachedCount tracks the set", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    expect(getAttachedCount(sup)).toBe(0);

    const result = await attachShim(sup, "c1", { profile: makeProfile(tmpRoot) });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.started).toBe(true);
      expect(result.status).toBe("starting");
      expect(result.attached).toBe(1);
    }

    await waitFor(() => getState(sup).status === "running", 1_000);
    expect(getAttachedCount(sup)).toBe(1);
  });

  it("second attacher with matching profile joins; reports started=false", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    await attachShim(sup, "c1", { profile: makeProfile(tmpRoot) });
    await waitFor(() => getState(sup).status === "running", 1_000);

    const second = await attachShim(sup, "c2", { profile: makeProfile(tmpRoot) });
    expect(second.kind).toBe("ok");
    if (second.kind === "ok") {
      expect(second.started).toBe(false);
      expect(second.status).toBe("running");
      expect(second.attached).toBe(2);
    }
  });

  it("attach with mismatched profile name returns E_PROFILE_MISMATCH; first attacher unaffected", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    const alpha = { ...makeProfile(tmpRoot), name: "alpha" } as ValidatedProfile;
    const beta = { ...makeProfile(tmpRoot), name: "beta", metroPort: 8082 } as ValidatedProfile;
    await attachShim(sup, "c1", { profile: alpha });
    await waitFor(() => getState(sup).status === "running", 1_000);

    // Phase D2: with the legacy facade gone, two profiles with different
    // names + different ports cleanly boot two sessions (attachShim
    // mints a fresh session for `beta` instead of mismatching against
    // `alpha`'s entry). The pre-D2 single-session test relied on the
    // facade to reject; assert the per-session shape directly. To pin
    // the underlying invariant (attachToSession rejects mismatch on the
    // SAME session id) call attachToSession directly with alpha's sid.
    const alphaEntry = sup.findSessionByProfile("alpha", null);
    expect(alphaEntry).toBeDefined();
    if (!alphaEntry) return;
    const mismatch = sup.attachToSession(alphaEntry.sessionId, "c2", beta);
    expect(mismatch.kind).toBe("error");
    if (mismatch.kind === "error") {
      expect(mismatch.code).toBe("E_PROFILE_MISMATCH");
    }
    expect(getAttachedCount(sup)).toBe(1);
  });

  it("attach is idempotent on the same connectionId — refcount does not double-count", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    await attachShim(sup, "c1", { profile: makeProfile(tmpRoot) });
    await waitFor(() => getState(sup).status === "running", 1_000);

    const dup = await attachShim(sup, "c1", { profile: makeProfile(tmpRoot) });
    expect(dup.kind).toBe("ok");
    if (dup.kind === "ok") {
      expect(dup.attached).toBe(1);
    }
    expect(getAttachedCount(sup)).toBe(1);
  });

  it("attach during starting state queues into the set without double-booting", async () => {
    const { boot, resolve } = makeDeferredBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    const first = await attachShim(sup, "c1", { profile: makeProfile(tmpRoot) });
    expect(first.kind).toBe("ok");
    expect(getState(sup).status).toBe("starting");

    const second = await attachShim(sup, "c2", { profile: makeProfile(tmpRoot) });
    expect(second.kind).toBe("ok");
    if (second.kind === "ok") {
      expect(second.started).toBe(false);
      expect(second.status).toBe("starting");
      expect(second.attached).toBe(2);
    }

    resolve();
    await waitFor(() => getState(sup).status === "running", 1_000);
    expect(getAttachedCount(sup)).toBe(2);
  });

  it("attach during stopping state returns E_SESSION_STOPPING", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    await attachShim(sup, "c1", { profile: makeProfile(tmpRoot) });
    await waitFor(() => getState(sup).status === "running", 1_000);

    // Drive into stopping but don't await — we want to catch the
    // intermediate state.
    const stopPromise = stopShim(sup);
    expect(getState(sup).status).toBe("stopping");

    const blocked = await attachShim(sup, "c-late", { profile: makeProfile(tmpRoot) });
    expect(blocked.kind).toBe("error");
    if (blocked.kind === "error") {
      expect(blocked.code).toBe("E_SESSION_STOPPING");
    }

    await stopPromise;
  });

  it("release of the only attacher transitions running → stopped", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    await attachShim(sup, "c1", { profile: makeProfile(tmpRoot) });
    await waitFor(() => getState(sup).status === "running", 1_000);

    const result = await sup.releaseConnectionFromAllSessions("c1");
    expect(result.stoppedSession).toBe(true);
    expect(result.attached).toBe(0);
    expect(getState(sup).status).toBe("stopped");
    expect(getAttachedCount(sup)).toBe(0);
  });

  it("release of one attacher with another still attached keeps the session running", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    await attachShim(sup, "c1", { profile: makeProfile(tmpRoot) });
    await attachShim(sup, "c2", { profile: makeProfile(tmpRoot) });
    await waitFor(() => getState(sup).status === "running", 1_000);

    const result = await sup.releaseConnectionFromAllSessions("c1");
    expect(result.stoppedSession).toBe(false);
    expect(result.attached).toBe(1);
    expect(getState(sup).status).toBe("running");
  });

  it("release of an unknown connectionId is a no-op", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    await attachShim(sup, "c1", { profile: makeProfile(tmpRoot) });
    await waitFor(() => getState(sup).status === "running", 1_000);

    const ghostRelease = await sup.releaseConnectionFromAllSessions("c-ghost");
    expect(ghostRelease.stoppedSession).toBe(false);
    expect(ghostRelease.attached).toBe(1);
    expect(getState(sup).status).toBe("running");
  });

  it("explicit release followed by socket-close-style release is safe (double-release is no-op)", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    await attachShim(sup, "c1", { profile: makeProfile(tmpRoot) });
    await attachShim(sup, "c2", { profile: makeProfile(tmpRoot) });
    await waitFor(() => getState(sup).status === "running", 1_000);

    const r1 = await sup.releaseConnectionFromAllSessions("c1");
    expect(r1.stoppedSession).toBe(false);
    expect(r1.attached).toBe(1);

    const r2 = await sup.releaseConnectionFromAllSessions("c1");
    expect(r2.stoppedSession).toBe(false);
    expect(r2.attached).toBe(1);
    expect(getState(sup).status).toBe("running");
  });

  it("session/stop scrubs the attached set so subsequent releases are no-ops", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    await attachShim(sup, "c1", { profile: makeProfile(tmpRoot) });
    await attachShim(sup, "c2", { profile: makeProfile(tmpRoot) });
    await waitFor(() => getState(sup).status === "running", 1_000);

    await stopShim(sup);
    expect(getState(sup).status).toBe("stopped");
    expect(getAttachedCount(sup)).toBe(0);

    const r = await sup.releaseConnectionFromAllSessions("c1");
    expect(r.stoppedSession).toBe(false);
    expect(r.attached).toBe(0);
  });

  it("per-session attachedConnections sets stay isolated — release from session A leaves session B intact", async () => {
    // Phase D1 — `releaseConnectionFromAllSessions(connId)` walks every
    // entry now (architecture finding #2). The historical "the only
    // session" assumption is gone; pin the isolation invariant here so a
    // future refactor that accidentally tracks attachments globally
    // can't slip past the gate.
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    const sidA = generateSessionId();
    const sidB = generateSessionId();
    const profileA = { ...makeProfile(tmpRoot), name: "alpha", metroPort: 8081 } as ValidatedProfile;
    const profileB = { ...makeProfile(tmpRoot), name: "beta", metroPort: 8082 } as ValidatedProfile;

    const startA = await sup.startSession(sidA, profileA);
    expect(startA.kind).toBe("ok");
    const startB = await sup.startSession(sidB, profileB);
    expect(startB.kind).toBe("ok");

    sup.attachToSession(sidA, "connA1", profileA);
    sup.attachToSession(sidA, "connA2", profileA);
    sup.attachToSession(sidB, "connB1", profileB);

    await waitFor(() => sup.getSessionState(sidA)?.status === "running", 1_000);
    await waitFor(() => sup.getSessionState(sidB)?.status === "running", 1_000);

    // Release connA1 — only session A's count should drop. Session B
    // is untouched even though release scans every entry.
    await sup.releaseConnectionFromAllSessions("connA1");
    expect(sup.getSessionEntry(sidA)?.attachedConnections.size).toBe(1);
    expect(sup.getSessionEntry(sidB)?.attachedConnections.size).toBe(1);

    // Release the LAST attacher on session A — session A should tear
    // down. Session B keeps running.
    await sup.releaseConnectionFromAllSessions("connA2");
    expect(sup.getSessionEntry(sidA)).toBeUndefined(); // deleted on stop
    expect(sup.getSessionState(sidB)?.status).toBe("running");
    expect(sup.getSessionEntry(sidB)?.attachedConnections.size).toBe(1);

    await sup.releaseConnectionFromAllSessions("connB1");
    expect(sup.getSessionEntry(sidB)).toBeUndefined();
  });

  it("boot failure clears the attached set so the next attacher boots cleanly", async () => {
    const failingBoot: SessionBootFn = async () => {
      throw new Error("boom");
    };
    const sup = new DaemonSupervisor({
      worktree: tmpRoot,
      ipc: fakeIpc,
      bootFn: failingBoot,
    });

    const first = await attachShim(sup, "c1", { profile: makeProfile(tmpRoot) });
    expect(first.kind).toBe("ok");

    // Wait for the failure to propagate (bootAsync's catch handler).
    await waitFor(() => getState(sup).status === "stopped", 1_000);
    // Critical: the stale c1 entry must not survive the failure, or
    // a subsequent fresh attach would inherit a "ghost" attacher and
    // last-release tear-down would never fire.
    expect(getAttachedCount(sup)).toBe(0);

    // Replace the bootFn with a successful one and attach again. The
    // supervisor doesn't expose bootFn replacement, so we instead
    // verify a new supervisor instance with the same worktree boots
    // cleanly — the state-machine invariant is per-instance, but the
    // test spirit ("post-failure state isn't sticky") holds.
    const { boot: goodBoot } = makeFakeBoot();
    const sup2 = new DaemonSupervisor({
      worktree: tmpRoot,
      ipc: fakeIpc,
      bootFn: goodBoot,
    });
    const second = await attachShim(sup2, "c2", { profile: makeProfile(tmpRoot) });
    expect(second.kind).toBe("ok");
    await waitFor(() => getState(sup2).status === "running", 1_000);
    expect(getAttachedCount(sup2)).toBe(1);
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
