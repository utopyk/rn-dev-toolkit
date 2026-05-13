import { describe, it, expect, vi } from "vitest";
import { createDevtoolsHostCapability } from "../host-capability.js";
import type { DevToolsManager } from "../../devtools.js";
import { asSessionId, type SessionId } from "../../identifiers.js";

const SID: SessionId = asSessionId("test-session");

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
  it("routes to the constructed sessionId when caller omits worktreeKey", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT", SID);
    await cap.list({});
    expect(manager.listNetwork).toHaveBeenCalledWith(SID, undefined);
  });

  it("routes to the constructed sessionId when explicit worktreeKey is in the allowed set", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT", SID, () => [
      "DEFAULT",
      "OTHER",
    ]);
    await cap.list({ worktreeKey: "OTHER" });
    // Phase D3 — the capability is per-session, so even an allowed
    // worktreeKey routes to the constructed sessionId. The
    // worktreeKey field becomes informational, not addressing.
    expect(manager.listNetwork).toHaveBeenCalledWith(SID, undefined);
  });

  it("passes filter through to listNetwork", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT", SID);
    const filter = { methods: ["GET"], limit: 10 } as const;
    await cap.list({ filter });
    expect(manager.listNetwork).toHaveBeenCalledWith(SID, filter);
  });

  it("status routes to the constructed sessionId", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT", SID, () => [
      "DEFAULT",
      "w-1",
    ]);
    await cap.status("w-1");
    expect(manager.status).toHaveBeenCalledWith(SID);
  });

  it("get returns null when manager returns null", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT", SID);
    const result = await cap.get({ requestId: "r1" });
    expect(result).toBeNull();
    expect(manager.getNetwork).toHaveBeenCalledWith(SID, "r1");
  });

  it("selectTarget awaits the manager and returns meta", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT", SID);
    const result = await cap.selectTarget({ targetId: "t1" });
    expect(manager.selectTarget).toHaveBeenCalledWith(SID, "t1");
    expect(result.status).toBe("switched");
    expect(result.meta.proxyStatus).toBe("connected");
  });

  it("clear calls manager.clear and returns meta", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT", SID);
    const result = await cap.clear({});
    expect(manager.clear).toHaveBeenCalledWith(SID);
    expect(result.status).toBe("cleared");
  });

  it("does not leak across worktrees — every call routes to the constructed sessionId regardless of caller worktreeKey", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT", SID, () => [
      "DEFAULT",
    ]);
    await cap.list({ worktreeKey: "victim-worktree" });
    expect(manager.listNetwork).toHaveBeenCalledWith(SID, undefined);
  });

  it("respects allowed multi-worktree set without changing routing", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT", SID, () => [
      "DEFAULT",
      "w-2",
    ]);
    await cap.list({ worktreeKey: "w-2" });
    expect(manager.listNetwork).toHaveBeenCalledWith(SID, undefined);
  });

  it("get returns null for empty requestId without hitting the manager", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT", SID);
    const result = await cap.get({ requestId: "" });
    expect(result).toBeNull();
    expect(manager.getNetwork).not.toHaveBeenCalled();
  });

  it("selectTarget throws on empty targetId", async () => {
    const manager = makeManager();
    const cap = createDevtoolsHostCapability(manager, "DEFAULT", SID);
    await expect(cap.selectTarget({ targetId: "" })).rejects.toThrow(
      /targetId is required/,
    );
    expect(manager.selectTarget).not.toHaveBeenCalled();
  });
});
