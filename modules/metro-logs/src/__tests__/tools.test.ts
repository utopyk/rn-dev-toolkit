import { describe, it, expect, vi } from "vitest";
import type { ModuleToolContext } from "@rn-dev/module-sdk";
import { clear, extractFilter, list, status } from "../tools.js";
import type {
  MetroLogsHostCapability,
  MetroLogsListArgs,
  MetroLogsClearArgs,
} from "../host-capability.js";
import type {
  MetroLogsListResult,
  MetroLogsMeta,
  MetroLogsStatus,
} from "../types.js";

const META: MetroLogsMeta = {
  worktreeKey: "wk",
  bufferEpoch: 3,
  oldestSequence: 2,
  lastEventSequence: 7,
  totalLinesReceived: 10,
  evictedCount: 3,
  metroStatus: "running",
};

function makeCap(overrides?: Partial<MetroLogsHostCapability>): {
  cap: MetroLogsHostCapability;
  calls: {
    status: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };
} {
  const statusFn = vi.fn(
    async (): Promise<MetroLogsStatus> => ({
      meta: META,
      bufferSize: 5,
      bufferCapacity: 2000,
    }),
  );
  const listFn = vi.fn(
    async (_args: MetroLogsListArgs): Promise<MetroLogsListResult> => ({
      entries: [],
      cursorDropped: false,
      meta: META,
    }),
  );
  const clearFn = vi.fn(
    async (_args: MetroLogsClearArgs) =>
      ({ status: "cleared" as const, meta: META }),
  );
  return {
    calls: { status: statusFn, list: listFn, clear: clearFn },
    cap: {
      status: overrides?.status ?? statusFn,
      list: overrides?.list ?? listFn,
      clear: overrides?.clear ?? clearFn,
    },
  };
}

function makeCtx(cap: MetroLogsHostCapability | null): ModuleToolContext {
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
    config: {},
  } as unknown as ModuleToolContext;
}

describe("metro-logs tools — handler dispatch", () => {
  it("status() round-trips to the host capability", async () => {
    const { cap, calls } = makeCap();
    const result = await status({}, makeCtx(cap));
    expect(calls.status).toHaveBeenCalledWith(undefined);
    expect(result.bufferSize).toBe(5);
    expect(result.meta.bufferEpoch).toBe(3);
  });

  it("status() forwards worktree when supplied", async () => {
    const { cap, calls } = makeCap();
    await status({ worktree: "alt" }, makeCtx(cap));
    expect(calls.status).toHaveBeenCalledWith("alt");
  });

  it("list() passes through filter fields when present", async () => {
    const { cap, calls } = makeCap();
    await list(
      {
        worktree: "wk",
        substring: "warn",
        stream: "stderr",
        since: { bufferEpoch: 3, sequence: 5 },
        limit: 50,
      },
      makeCtx(cap),
    );
    expect(calls.list).toHaveBeenCalledWith({
      worktreeKey: "wk",
      filter: {
        substring: "warn",
        stream: "stderr",
        since: { bufferEpoch: 3, sequence: 5 },
        limit: 50,
      },
    });
  });

  it("list() omits filter entirely when no knobs supplied", async () => {
    const { cap, calls } = makeCap();
    await list({ worktree: "wk" }, makeCtx(cap));
    expect(calls.list).toHaveBeenCalledWith({
      worktreeKey: "wk",
      filter: undefined,
    });
  });

  it("clear() forwards worktree", async () => {
    const { cap, calls } = makeCap();
    const result = await clear({ worktree: "wk" }, makeCtx(cap));
    expect(calls.clear).toHaveBeenCalledWith({ worktreeKey: "wk" });
    expect(result.status).toBe("cleared");
  });

  it("throws a generic error when the capability is unavailable (no denial-vs-missing leak)", async () => {
    await expect(status({}, makeCtx(null))).rejects.toThrow(
      /capability unavailable/,
    );
  });
});

describe("metro-logs tools — extractFilter", () => {
  it("drops invalid cursor shapes", () => {
    const f = extractFilter({
      worktree: "wk",
      since: { bufferEpoch: "oops" } as unknown as {
        bufferEpoch: number;
        sequence: number;
      },
    });
    expect(f?.since).toBeUndefined();
  });

  it("drops invalid stream", () => {
    const f = extractFilter({
      stream: "stdin" as unknown as "stdout",
    });
    expect(f?.stream).toBeUndefined();
  });

  it("clamps/drops out-of-range limits", () => {
    expect(extractFilter({ limit: 0 })?.limit).toBeUndefined();
    expect(extractFilter({ limit: -5 })?.limit).toBeUndefined();
    expect(extractFilter({ limit: 1.5 })?.limit).toBeUndefined();
    expect(extractFilter({ limit: 10_000 })?.limit).toBeUndefined();
    expect(extractFilter({ limit: 500 })?.limit).toBe(500);
  });

  it("drops empty substring", () => {
    expect(extractFilter({ substring: "" })?.substring).toBeUndefined();
    expect(extractFilter({ substring: "warn" })?.substring).toBe("warn");
  });

  it("returns undefined when no filter fields are present", () => {
    expect(extractFilter({ worktree: "wk" })).toBeUndefined();
  });
});
