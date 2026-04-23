import { describe, it, expect, vi } from "vitest";
import { createDevtoolsHostCapability } from "../host-capability.js";
import type { DevToolsManager } from "../../devtools.js";

function makeManager(overrides: Partial<DevToolsManager> = {}): DevToolsManager {
  const base = {
    status: vi.fn(() => ({
      meta: {
        worktreeKey: "DEFAULT",
        bufferEpoch: 1,
        oldestSequence: 0,
        lastEventSequence: 0,
        proxyStatus: "connected" as const,
        selectedTargetId: null,
        evictedCount: 0,
        tapDroppedCount: 0,
        bodyTruncatedCount: 0,
        bodyCapture: "full" as const,
        sessionBoundary: null,
      },
      targets: [],
      rnVersion: null,
      proxyPort: 1234,
      sessionNonce: null,
      bodyCaptureEnabled: true,
    })),
    listNetwork: vi.fn(() => ({
      entries: [],
      cursorDropped: false,
      meta: {
        worktreeKey: "DEFAULT",
        bufferEpoch: 1,
        oldestSequence: 0,
        lastEventSequence: 0,
        proxyStatus: "connected" as const,
        selectedTargetId: null,
        evictedCount: 0,
        tapDroppedCount: 0,
        bodyTruncatedCount: 0,
        bodyCapture: "full" as const,
        sessionBoundary: null,
      },
    })),
    getNetwork: vi.fn(() => null),
    selectTarget: vi.fn(async () => {}),
    clear: vi.fn(),
    ...overrides,
  };
  return base as unknown as DevToolsManager;
}

describe("createDevtoolsHostCapability", () => {
  it("falls back to defaultWorktreeKey when caller omits worktreeKey", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT");
    await cap.list({});
    expect(manager.listNetwork).toHaveBeenCalledWith("DEFAULT", undefined);
  });

  it("respects explicit worktreeKey when it's in the allowed set", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT", () => [
      "DEFAULT",
      "OTHER",
    ]);
    await cap.list({ worktreeKey: "OTHER" });
    expect(manager.listNetwork).toHaveBeenCalledWith("OTHER", undefined);
  });

  it("passes filter through to listNetwork", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT");
    const filter = { methods: ["GET"], limit: 10 } as const;
    await cap.list({ filter });
    expect(manager.listNetwork).toHaveBeenCalledWith("DEFAULT", filter);
  });

  it("status forwards allowed worktree keys", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT", () => [
      "DEFAULT",
      "w-1",
    ]);
    await cap.status("w-1");
    expect(manager.status).toHaveBeenCalledWith("w-1");
  });

  it("get returns null when manager returns null", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT");
    const result = await cap.get({ requestId: "r1" });
    expect(result).toBeNull();
    expect(manager.getNetwork).toHaveBeenCalledWith("DEFAULT", "r1");
  });

  it("selectTarget awaits the manager and returns meta", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT");
    const result = await cap.selectTarget({ targetId: "t1" });
    expect(manager.selectTarget).toHaveBeenCalledWith("DEFAULT", "t1");
    expect(result.status).toBe("switched");
    expect(result.meta.proxyStatus).toBe("connected");
  });

  it("clear calls manager.clear and returns meta", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT");
    const result = await cap.clear({});
    expect(manager.clear).toHaveBeenCalledWith("DEFAULT");
    expect(result.status).toBe("cleared");
  });

  it("falls back to defaultWorktreeKey when caller-supplied worktreeKey is not in the allowed set (cross-worktree guard)", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT", () => [
      "DEFAULT",
    ]);
    await cap.list({ worktreeKey: "victim-worktree" });
    expect(manager.listNetwork).toHaveBeenCalledWith("DEFAULT", undefined);
  });

  it("respects allowed multi-worktree set", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT", () => [
      "DEFAULT",
      "w-2",
    ]);
    await cap.list({ worktreeKey: "w-2" });
    expect(manager.listNetwork).toHaveBeenCalledWith("w-2", undefined);
  });

  it("get returns null for empty requestId without hitting the manager", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT");
    const result = await cap.get({ requestId: "" });
    expect(result).toBeNull();
    expect(manager.getNetwork).not.toHaveBeenCalled();
  });

  it("selectTarget throws on empty targetId", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT");
    await expect(cap.selectTarget({ targetId: "" })).rejects.toThrow(
      /targetId is required/,
    );
    expect(manager.selectTarget).not.toHaveBeenCalled();
  });
});
