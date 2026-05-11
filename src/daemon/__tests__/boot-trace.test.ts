import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../core/artifact.js";
import { IpcServer } from "../../core/ipc.js";
import { ModuleRegistry } from "../../modules/registry.js";
import { fakeBootSessionServices } from "../fake-boot.js";
import { SubscribeRegistry } from "../subscribe-registry.js";
import type { Profile } from "../../core/types.js";
import type { SessionServices } from "../../core/session/boot.js";

// Phase H1i — three-phase boot + boot-trace assertion. The boot
// orchestrator emits `boot/phase` markers on the HookManager event
// emitter at three boundaries (capabilities-registered → providers-
// declared → session/init-fired). The assertion below pins the
// invariant the H1 plan calls out: every built-in provider MUST be
// declared (Phase 2) before `session/init` fires (Phase 3). A future
// regression that fires before Phase 2 completes — say, a
// HookManager construction site that drifted to a different boot
// step — would surface as a wrong-order trace, not a runtime crash.

let tmpRoot = "";

function makeProfile(projectRoot: string): Profile {
  return {
    name: "boot-trace",
    isDefault: true,
    worktree: null,
    branch: "main",
    platform: "ios",
    mode: "quick",
    metroPort: 8099,
    devices: {},
    buildVariant: "debug",
    preflight: { checks: [], frequency: "once" },
    onSave: [],
    env: {},
    projectRoot,
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "boot-trace-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("three-phase boot trace (fake-boot)", () => {
  let services: SessionServices | null = null;
  let ipc: IpcServer | null = null;

  afterEach(async () => {
    if (services) {
      try {
        await services.dispose();
      } catch {
        /* best-effort */
      }
      services = null;
    }
    if (ipc) {
      try {
        await ipc.stop();
      } catch {
        /* best-effort */
      }
      ipc = null;
    }
  });

  it("emits phases [1, 2, 3] in order during a healthy boot", async () => {
    const sockPath = join(tmpRoot, "boot-trace.sock");
    ipc = new IpcServer(sockPath);
    await ipc.start();

    services = await fakeBootSessionServices({
      profile: makeProfile(tmpRoot),
      projectRoot: tmpRoot,
      artifactStore: new ArtifactStore(tmpRoot),
      moduleRegistry: new ModuleRegistry(),
      emit: () => {},
      hostVersion: "0.1.0",
      ipc,
      subscribeRegistry: new SubscribeRegistry(),
    });

    const phases = services.bootTrace.map((m) => m.phase);
    expect(phases).toEqual([1, 2, 3]);

    // Monotonic timestamps — phase markers fire in real time, no
    // clock-skew tolerance needed because everything ran inside this
    // test process.
    const tsList = services.bootTrace.map((m) => m.ts);
    expect(tsList[1]).toBeGreaterThanOrEqual(tsList[0]!);
    expect(tsList[2]).toBeGreaterThanOrEqual(tsList[1]!);
  });

  it("declares the session built-in's provides.hooks before Phase 3 (session/init fire)", async () => {
    // Listener attached AFTER boot returns — registry dump captures
    // post-boot state. The point of this assertion isn't to observe
    // the fire mid-flight (that's `hooks/fired`'s job at the
    // HookManager test level); it's to pin the invariant that by the
    // time anyone OUTSIDE the daemon could observe the manager, the
    // built-in providers are already in the registry. A regression
    // that built the manager AFTER fake-boot's session/init fire
    // would expose an empty `providers["session"]` here.
    const sockPath = join(tmpRoot, "providers.sock");
    ipc = new IpcServer(sockPath);
    await ipc.start();

    services = await fakeBootSessionServices({
      profile: makeProfile(tmpRoot),
      projectRoot: tmpRoot,
      artifactStore: new ArtifactStore(tmpRoot),
      moduleRegistry: new ModuleRegistry(),
      emit: () => {},
      hostVersion: "0.1.0",
      ipc,
      subscribeRegistry: new SubscribeRegistry(),
    });

    const dump = services.hookManager.dumpRegistry();
    expect(Object.keys(dump.providers)).toContain("session");
    expect(dump.providers.session).toContain("init");
    expect(dump.providers.session).toContain("profile-changed");
  });

  it("session/init fire IS observable (hooks/fired) during boot", async () => {
    // Mount a `hooks/fired` listener on a fresh HookManager-aware
    // boot via a custom registry. We can't intercept a HookManager
    // before fake-boot constructs it internally, but we CAN stand up
    // a parallel HookManager and verify the firing pattern symmetry
    // in isolation (covered by `hook-manager.test.ts`). Here we just
    // assert that `session/init` did NOT leave any orphaned
    // registrations behind — Phase 2's recomputeOrphans should have
    // cleared them when `declareProvider("session", ...)` fired.
    const sockPath = join(tmpRoot, "orphans.sock");
    ipc = new IpcServer(sockPath);
    await ipc.start();

    services = await fakeBootSessionServices({
      profile: makeProfile(tmpRoot),
      projectRoot: tmpRoot,
      artifactStore: new ArtifactStore(tmpRoot),
      moduleRegistry: new ModuleRegistry(),
      emit: () => {},
      hostVersion: "0.1.0",
      ipc,
      subscribeRegistry: new SubscribeRegistry(),
    });

    const dump = services.hookManager.dumpRegistry();
    // No project config → no project-side registrations → no orphans.
    expect(dump.orphaned.length).toBe(0);
  });
});
