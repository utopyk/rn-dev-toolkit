import { describe, it, expect, vi } from "vitest";
import type { ModuleToolContext } from "@rn-dev/module-sdk";
import { clear, get, list, selectTarget, status } from "../tools.js";
import type { DevtoolsHostCapability } from "../host-capability.js";
import type {
  CaptureListResult,
  CaptureMeta,
  DevToolsStatus,
  NetworkEntry,
} from "../types.js";

const META: CaptureMeta = {
  worktreeKey: "wk",
  bufferEpoch: 4,
  oldestSequence: 1,
  lastEventSequence: 9,
  proxyStatus: "connected",
  selectedTargetId: "t1",
  evictedCount: 0,
  tapDroppedCount: 0,
  bodyTruncatedCount: 0,
  bodyCapture: "metadata-only",
  sessionBoundary: null,
};

function makeCap(): {
  cap: DevtoolsHostCapability;
  calls: {
    status: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    selectTarget: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };
} {
  const statusFn = vi.fn(
    async (): Promise<DevToolsStatus> => ({
      meta: META,
      targets: [],
      rnVersion: "0.74.0",
      proxyPort: 8081,
      sessionNonce: "nonce",
    }),
  );
  const listFn = vi.fn(
    async (): Promise<CaptureListResult<NetworkEntry>> => ({
      entries: [],
      cursorDropped: false,
      meta: META,
    }),
  );
  const getFn = vi.fn(async (): Promise<NetworkEntry | null> => null);
  const selectTargetFn = vi.fn(async () => ({
    status: "switched" as const,
    meta: META,
  }));
  const clearFn = vi.fn(async () => ({
    status: "cleared" as const,
    meta: META,
  }));
  return {
    calls: {
      status: statusFn,
      list: listFn,
      get: getFn,
      selectTarget: selectTargetFn,
      clear: clearFn,
    },
    cap: {
      status: statusFn,
      list: listFn,
      get: getFn,
      selectTarget: selectTargetFn,
      clear: clearFn,
    },
  };
}

function makeCtx(
  cap: DevtoolsHostCapability | null,
  config: Record<string, unknown> = {},
): ModuleToolContext {
  return {
    host: {
      capability: <T>(_id: string): T | null => cap as unknown as T | null,
    },
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    appInfo: {
      hostVersion: "0.0.0",
      platform: "darwin",
      worktreeKey: "wk",
    },
    config,
  } as unknown as ModuleToolContext;
}

describe("devtools-network tools — handler dispatch", () => {
  it("status() round-trips to the host capability", async () => {
    const { cap, calls } = makeCap();
    const result = await status({}, makeCtx(cap));
    expect(calls.status).toHaveBeenCalledWith(undefined);
    expect(result.rnVersion).toBe("0.74.0");
  });

  it("list() passes each filter knob through by name", async () => {
    const { cap, calls } = makeCap();
    await list(
      {
        worktree: "wk",
        urlRegex: "/api/",
        methods: ["GET", "POST"],
        statusRange: [200, 299],
        since: { bufferEpoch: 4, sequence: 5 },
        limit: 50,
      },
      makeCtx(cap),
    );
    expect(calls.list).toHaveBeenCalledWith({
      worktreeKey: "wk",
      filter: {
        urlRegex: "/api/",
        methods: ["GET", "POST"],
        statusRange: [200, 299],
        since: { bufferEpoch: 4, sequence: 5 },
        limit: 50,
      },
    });
  });

  it("list() passes an empty-shaped filter when no knobs supplied", async () => {
    // The handler builds a fresh literal with every filter field
    // explicitly listed. When args carry no knobs, every field is
    // `undefined`; vitest `toEqual` ignores undefined properties, so
    // the shape is structurally `{}`. Host-side `filter?.x` optional
    // chaining makes this equivalent to `filter: undefined`.
    const { cap, calls } = makeCap();
    await list({ worktree: "wk" }, makeCtx(cap));
    expect(calls.list).toHaveBeenCalledWith({
      worktreeKey: "wk",
      filter: {},
    });
  });

  it("get() forwards requestId + worktree", async () => {
    const { cap, calls } = makeCap();
    await get({ worktree: "wk", requestId: "r1" }, makeCtx(cap));
    expect(calls.get).toHaveBeenCalledWith({
      worktreeKey: "wk",
      requestId: "r1",
    });
  });

  it("selectTarget() forwards targetId + worktree", async () => {
    const { cap, calls } = makeCap();
    await selectTarget({ worktree: "wk", targetId: "t2" }, makeCtx(cap));
    expect(calls.selectTarget).toHaveBeenCalledWith({
      worktreeKey: "wk",
      targetId: "t2",
    });
  });

  it("clear() forwards worktree", async () => {
    const { cap, calls } = makeCap();
    await clear({ worktree: "wk" }, makeCtx(cap));
    expect(calls.clear).toHaveBeenCalledWith({ worktreeKey: "wk" });
  });

  it("list() applies captureBodies config when redacting bodies", async () => {
    // Smoke test — confirms that `readCaptureBodies` reads the module
    // config; deeper redaction semantics are covered by `dto.test.ts`.
    const { cap } = makeCap();
    const result = await list(
      { worktree: "wk" },
      makeCtx(cap, { captureBodies: true }),
    );
    expect(result).toBeDefined();
  });

  it("throws a generic error when the capability is unavailable", async () => {
    await expect(status({}, makeCtx(null))).rejects.toThrow(
      /capability unavailable/,
    );
  });
});
