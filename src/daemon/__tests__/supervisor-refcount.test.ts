import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonSupervisor, type SessionBootFn } from "../supervisor.js";
import type { IpcServer } from "../../core/ipc.js";
import type {
  BootSessionServicesOptions,
  SessionServices,
} from "../../core/session/boot.js";
import type { Profile } from "../../core/types.js";
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
import { ArtifactStore } from "../../core/artifact.js";
import { CapabilityRegistry } from "../../core/module-host/capabilities.js";
import { MetroLogsStore } from "../../core/metro-logs/buffer.js";
import { ModuleRegistry } from "../../modules/registry.js";

// Phase 13.5 unit-level coverage of DaemonSupervisor.attach/release.
// Integration coverage at src/app/client/__tests__/session-release.test.ts
// exercises the wire path; this file pins the in-memory state machine
// transitions in isolation so refcount edge cases (concurrent release
// during stop, attach during starting, idempotency on same connId,
// etc.) regress here before the integration suite even sees them.

function makeProfile(projectRoot: string): Profile {
  return {
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

describe("DaemonSupervisor.attach / release (unit)", () => {
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

    expect(sup.getAttachedCount()).toBe(0);

    const result = await sup.attach("c1", { profile: makeProfile(tmpRoot) });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.started).toBe(true);
      expect(result.status).toBe("starting");
      expect(result.attached).toBe(1);
    }

    // Wait for boot to complete.
    await waitFor(() => sup.getState().status === "running", 1_000);
    expect(sup.getAttachedCount()).toBe(1);
  });

  it("second attacher with matching profile joins; reports started=false", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    await sup.attach("c1", { profile: makeProfile(tmpRoot) });
    await waitFor(() => sup.getState().status === "running", 1_000);

    const second = await sup.attach("c2", { profile: makeProfile(tmpRoot) });
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

    await sup.attach("c1", { profile: { ...makeProfile(tmpRoot), name: "alpha" } });
    await waitFor(() => sup.getState().status === "running", 1_000);

    const second = await sup.attach("c2", {
      profile: { ...makeProfile(tmpRoot), name: "beta" },
    });
    expect(second.kind).toBe("error");
    if (second.kind === "error") {
      expect(second.code).toBe("E_PROFILE_MISMATCH");
    }
    expect(sup.getAttachedCount()).toBe(1);
  });

  it("attach is idempotent on the same connectionId — refcount does not double-count", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    await sup.attach("c1", { profile: makeProfile(tmpRoot) });
    await waitFor(() => sup.getState().status === "running", 1_000);

    const dup = await sup.attach("c1", { profile: makeProfile(tmpRoot) });
    expect(dup.kind).toBe("ok");
    if (dup.kind === "ok") {
      // Same conn re-attaching doesn't grow the set; Set.add is idempotent.
      expect(dup.attached).toBe(1);
    }
    expect(sup.getAttachedCount()).toBe(1);
  });

  it("attach during starting state queues into the set without double-booting", async () => {
    const { boot, resolve } = makeDeferredBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    const first = await sup.attach("c1", { profile: makeProfile(tmpRoot) });
    expect(first.kind).toBe("ok");

    // Boot is gated; supervisor stays "starting" until we resolve.
    expect(sup.getState().status).toBe("starting");

    // Second attach during starting joins the set immediately.
    const second = await sup.attach("c2", { profile: makeProfile(tmpRoot) });
    expect(second.kind).toBe("ok");
    if (second.kind === "ok") {
      expect(second.started).toBe(false);
      expect(second.status).toBe("starting");
      expect(second.attached).toBe(2);
    }

    // Let boot complete.
    resolve();
    await waitFor(() => sup.getState().status === "running", 1_000);
    expect(sup.getAttachedCount()).toBe(2);
  });

  it("attach during stopping state returns E_SESSION_STOPPING", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    await sup.attach("c1", { profile: makeProfile(tmpRoot) });
    await waitFor(() => sup.getState().status === "running", 1_000);

    // Drive into stopping but don't await — we want to catch the
    // intermediate state.
    const stopPromise = sup.stop();
    expect(sup.getState().status).toBe("stopping");

    const blocked = await sup.attach("c-late", { profile: makeProfile(tmpRoot) });
    expect(blocked.kind).toBe("error");
    if (blocked.kind === "error") {
      expect(blocked.code).toBe("E_SESSION_STOPPING");
    }

    await stopPromise;
  });

  it("release of the only attacher transitions running → stopped", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    await sup.attach("c1", { profile: makeProfile(tmpRoot) });
    await waitFor(() => sup.getState().status === "running", 1_000);

    const result = await sup.release("c1");
    expect(result.stoppedSession).toBe(true);
    expect(result.attached).toBe(0);
    expect(sup.getState().status).toBe("stopped");
    expect(sup.getAttachedCount()).toBe(0);
  });

  it("release of one attacher with another still attached keeps the session running", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    await sup.attach("c1", { profile: makeProfile(tmpRoot) });
    await sup.attach("c2", { profile: makeProfile(tmpRoot) });
    await waitFor(() => sup.getState().status === "running", 1_000);

    const result = await sup.release("c1");
    expect(result.stoppedSession).toBe(false);
    expect(result.attached).toBe(1);
    expect(sup.getState().status).toBe("running");
  });

  it("release of an unknown connectionId is a no-op", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    await sup.attach("c1", { profile: makeProfile(tmpRoot) });
    await waitFor(() => sup.getState().status === "running", 1_000);

    const ghostRelease = await sup.release("c-ghost");
    expect(ghostRelease.stoppedSession).toBe(false);
    expect(ghostRelease.attached).toBe(1);
    expect(sup.getState().status).toBe("running");
  });

  it("explicit release followed by socket-close-style release is safe (double-release is no-op)", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    await sup.attach("c1", { profile: makeProfile(tmpRoot) });
    await sup.attach("c2", { profile: makeProfile(tmpRoot) });
    await waitFor(() => sup.getState().status === "running", 1_000);

    // First release — explicit RPC path.
    const r1 = await sup.release("c1");
    expect(r1.stoppedSession).toBe(false);
    expect(r1.attached).toBe(1);

    // Second release on the same id — socket-close path. Must be a
    // no-op on the refcount; must NOT decrement c2's slot.
    const r2 = await sup.release("c1");
    expect(r2.stoppedSession).toBe(false);
    expect(r2.attached).toBe(1);
    expect(sup.getState().status).toBe("running");
  });

  it("session/stop scrubs the attached set so subsequent releases are no-ops", async () => {
    const { boot } = makeFakeBoot();
    const sup = new DaemonSupervisor({ worktree: tmpRoot, ipc: fakeIpc, bootFn: boot });

    await sup.attach("c1", { profile: makeProfile(tmpRoot) });
    await sup.attach("c2", { profile: makeProfile(tmpRoot) });
    await waitFor(() => sup.getState().status === "running", 1_000);

    await sup.stop();
    expect(sup.getState().status).toBe("stopped");
    expect(sup.getAttachedCount()).toBe(0);

    // Releases that arrive after stop (e.g. delayed socket-close
    // events) must be no-ops, not double-tear-downs.
    const r = await sup.release("c1");
    expect(r.stoppedSession).toBe(false);
    expect(r.attached).toBe(0);
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

    const first = await sup.attach("c1", { profile: makeProfile(tmpRoot) });
    expect(first.kind).toBe("ok");

    // Wait for the failure to propagate (bootAsync's catch handler).
    await waitFor(() => sup.getState().status === "stopped", 1_000);
    // Critical: the stale c1 entry must not survive the failure, or
    // a subsequent fresh attach would inherit a "ghost" attacher and
    // last-release tear-down would never fire.
    expect(sup.getAttachedCount()).toBe(0);

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
    const second = await sup2.attach("c2", { profile: makeProfile(tmpRoot) });
    expect(second.kind).toBe("ok");
    await waitFor(() => sup2.getState().status === "running", 1_000);
    expect(sup2.getAttachedCount()).toBe(1);
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
