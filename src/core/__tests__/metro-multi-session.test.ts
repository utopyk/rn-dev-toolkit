/**
 * Phase D3 — MetroManager multi-session capability test.
 *
 * Pins the invariant that two `start()` calls with the SAME
 * `worktreeKey` but DIFFERENT `sessionId`s coexist as two distinct
 * `MetroInstance` values on a single manager. The handoff calls this
 * out as the load-bearing assertion for the Map-key flip from
 * `worktreeKey` to `SessionId`.
 *
 * The supervisor's `startSession` guards same-port collisions at a
 * higher layer (E_PORT_CONFLICT); the manager just refuses duplicate
 * `sessionId` (E_SESSION_ALREADY_EXISTS via thrown Error). Two
 * sessions on the same worktree with different ports is the
 * legitimate concurrent shape.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ArtifactStore } from "../artifact.js";
import { MetroManager } from "../metro.js";
import { asSessionId, type SessionId } from "../identifiers.js";
import type { MetroInstance } from "../types.js";

function sid(s: string): SessionId {
  return asSessionId(s);
}

// Mock child_process — return a fresh fake process per spawn so two
// startMetro calls don't share the same ChildProcess reference.
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  let nextPid = 11000;
  return {
    ...actual,
    spawn: vi.fn(() => ({
      pid: nextPid++,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
      unref: vi.fn(),
    })),
    execFile: vi.fn(
      (_cmd: string, _args: string[], cb: (...args: unknown[]) => void) => {
        cb(null, "", "");
      },
    ),
  };
});

vi.mock("net", () => ({
  createServer: vi.fn(() => ({
    listen: vi.fn((_port: number, cb: () => void) => {
      cb();
      return {
        once: vi.fn((_event: string, cb2: () => void) => {
          cb2();
        }),
        close: vi.fn((cb2?: () => void) => cb2?.()),
      };
    }),
    once: vi.fn(),
    close: vi.fn((cb?: () => void) => cb?.()),
  })),
}));

describe("MetroManager multi-session (Phase D3)", () => {
  let tmpDir: string;
  let store: ArtifactStore;
  let manager: MetroManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rn-dev-metro-multi-"));
    store = new ArtifactStore(join(tmpDir, "artifacts"));
    manager = new MetroManager(store, [8081, 8099]);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("two start() calls with same worktreeKey + different sessionIds produce two MetroInstances", () => {
    const sidA = sid("session-A");
    const sidB = sid("session-B");
    const wt = "shared-worktree-hash";

    const a = manager.start({
      sessionId: sidA,
      worktreeKey: wt,
      projectRoot: "/repo",
      port: 8081,
    });
    const b = manager.start({
      sessionId: sidB,
      worktreeKey: wt,
      projectRoot: "/repo",
      port: 8082,
    });

    // Two distinct instances at the manager layer — Map key is
    // SessionId, so same-worktreeKey doesn't collide.
    expect(a).not.toBe(b);
    expect(manager.getInstance(sidA)).toBe(a);
    expect(manager.getInstance(sidB)).toBe(b);

    // Both carry the same worktreeKey metadata — the demotion is
    // intentional (port persistence + log routing still need it).
    expect(a.worktree).toBe(wt);
    expect(b.worktree).toBe(wt);

    // Ports do not collide — caller picked them explicitly. The
    // manager doesn't enforce port uniqueness; that's the
    // supervisor's E_PORT_CONFLICT check.
    expect(a.port).toBe(8081);
    expect(b.port).toBe(8082);

    expect(manager.getAll()).toHaveLength(2);
  });

  it("getInstance disambiguates by sessionId — same-worktreeKey lookups are unsupported", () => {
    const sidA = sid("alpha");
    const sidB = sid("beta");
    const wt = "wt-shared";

    manager.start({
      sessionId: sidA,
      worktreeKey: wt,
      projectRoot: "/repo",
      port: 8081,
    });
    manager.start({
      sessionId: sidB,
      worktreeKey: wt,
      projectRoot: "/repo",
      port: 8082,
    });

    // The manager only accepts SessionId; a worktreeKey-shaped lookup
    // is meaningless after D3. We assert this by checking that the
    // two sessions are independently addressable.
    expect(manager.getInstance(sidA)?.port).toBe(8081);
    expect(manager.getInstance(sidB)?.port).toBe(8082);
  });

  it("stop(sessionId) removes only the named session, leaving the sibling running", () => {
    const sidA = sid("keep");
    const sidB = sid("drop");
    const wt = "wt-shared";

    manager.start({
      sessionId: sidA,
      worktreeKey: wt,
      projectRoot: "/repo",
      port: 8081,
    });
    manager.start({
      sessionId: sidB,
      worktreeKey: wt,
      projectRoot: "/repo",
      port: 8082,
    });

    const result = manager.stop(sidB);
    expect(result).toBe(true);
    expect(manager.getInstance(sidA)).not.toBeNull();
    expect(manager.getInstance(sidB)).toBeNull();
    expect(manager.getAll()).toHaveLength(1);
  });

  it("status events emit sessionId so DevToolsManager can route to its own state", () => {
    const sidA = sid("alpha");
    const captured: Array<{ sessionId?: SessionId; worktreeKey?: string }> = [];
    manager.on("status", (payload) => {
      captured.push(payload as { sessionId?: SessionId; worktreeKey?: string });
    });

    const instance = manager.start({
      sessionId: sidA,
      worktreeKey: "wt",
      projectRoot: "/repo",
      port: 8081,
    });

    // stop emits the "stopped" status; before D3, only worktreeKey
    // was carried; after D3 the payload carries both.
    manager.stop(sidA);

    const stopped = captured.find((p) => p.sessionId === sidA);
    expect(stopped).toBeDefined();
    expect(stopped?.worktreeKey).toBe("wt");
    // sanity — the started instance also bound the sessionId
    expect(instance.sessionId).toBe(sidA);
  });

  it("starting a session with a duplicate sessionId throws", () => {
    const sidA = sid("dupe");
    manager.start({
      sessionId: sidA,
      worktreeKey: "wt",
      projectRoot: "/repo",
      port: 8081,
    });

    expect(() =>
      manager.start({
        sessionId: sidA,
        worktreeKey: "wt",
        projectRoot: "/repo",
        port: 8082,
      }),
    ).toThrow(/already started/i);
  });
});
