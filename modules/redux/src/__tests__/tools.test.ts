import { describe, it, expect, vi } from "vitest";
import type { ModuleToolContext } from "@rn-dev/module-sdk";
import { action, actions, clear, state, status } from "../tools.js";
import type { ReduxHostCapability } from "../host-capability.js";
import type { ReduxMeta } from "../types.js";

const META: ReduxMeta = {
  sessionKey: "wk",
  bufferEpoch: 1,
  oldestSequence: 1,
  lastEventSequence: 3,
  totalActionsReceived: 3,
  evictedCount: 0,
  truncatedCount: 0,
  hasState: true,
  redactionMode: "mcp-redacted",
};

function makeCap() {
  const calls = {
    status: vi.fn(async () => ({ meta: META, bufferSize: 3, bufferCapacity: 2000 })),
    listActions: vi.fn(async () => ({ entries: [], cursorDropped: false, meta: META })),
    getAction: vi.fn(async () => ({ action: null })),
    getState: vi.fn(async () => ({ value: null, path: "", present: false, meta: META })),
    clear: vi.fn(async () => ({ status: "cleared" as const, meta: META })),
  };
  const cap = calls as unknown as ReduxHostCapability;
  return { cap, calls };
}

function makeCtx(cap: ReduxHostCapability | null, config: Record<string, unknown> = {}): ModuleToolContext {
  return {
    host: { capability: <T>(_id: string): T | null => cap as unknown as T | null },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    appInfo: { hostVersion: "0.0.0", platform: "darwin", worktreeKey: "wk" },
    config,
  } as unknown as ModuleToolContext;
}

describe("redux tools — handler dispatch", () => {
  it("status() round-trips to the capability", async () => {
    const { cap, calls } = makeCap();
    const r = await status({ worktree: "wk" }, makeCtx(cap));
    expect(calls.status).toHaveBeenCalledWith("wk");
    expect(r.bufferSize).toBe(3);
  });

  it("state() passes path + the operator redaction policy from ctx.config", async () => {
    const { cap, calls } = makeCap();
    await state({ path: "auth.session" }, makeCtx(cap, { whitelist: ["ui"], blacklist: ["*account*"], mode: "full" }));
    expect(calls.getState).toHaveBeenCalledWith({
      worktreeKey: undefined,
      path: "auth.session",
      redaction: { whitelist: ["ui"], extraBlacklist: ["*account*"], mode: "full" },
    });
  });

  it("actions() threads filter knobs + redaction", async () => {
    const { cap, calls } = makeCap();
    await actions(
      { typeFilter: "auth", since: { bufferEpoch: 1, sequence: 2 }, limit: 50 },
      makeCtx(cap, {}),
    );
    expect(calls.listActions).toHaveBeenCalledWith({
      worktreeKey: undefined,
      filter: { typeFilter: "auth", since: { bufferEpoch: 1, sequence: 2 }, limit: 50 },
      redaction: { whitelist: [], extraBlacklist: [], mode: "mcp-redacted" },
    });
  });

  it("action() passes the sequence + redaction", async () => {
    const { cap, calls } = makeCap();
    await action({ sequence: 7 }, makeCtx(cap, {}));
    expect(calls.getAction).toHaveBeenCalledWith({
      worktreeKey: undefined,
      sequence: 7,
      redaction: { whitelist: [], extraBlacklist: [], mode: "mcp-redacted" },
    });
  });

  it("clear() does NOT pass redaction (it's a mutate, no read)", async () => {
    const { cap, calls } = makeCap();
    await clear({ worktree: "wk" }, makeCtx(cap));
    expect(calls.clear).toHaveBeenCalledWith({ worktreeKey: "wk" });
  });

  it("throws a generic error when the capability is unavailable", async () => {
    await expect(status({}, makeCtx(null))).rejects.toThrow(/redux capability unavailable/);
  });
});

describe("redux tools — redaction config is FAIL-CLOSED", () => {
  it("missing config → strictest (empty whitelist, no extra blacklist, mcp-redacted)", async () => {
    const { cap, calls } = makeCap();
    await state({}, makeCtx(cap, {}));
    expect(calls.getState.mock.calls[0]![0].redaction).toEqual({
      whitelist: [],
      extraBlacklist: [],
      mode: "mcp-redacted",
    });
  });

  it("garbage config types coerce to strict, never loosen", async () => {
    const { cap, calls } = makeCap();
    await state({}, makeCtx(cap, { whitelist: "ui", blacklist: 42, mode: "reveal-everything" }));
    expect(calls.getState.mock.calls[0]![0].redaction).toEqual({
      whitelist: [],
      extraBlacklist: [],
      mode: "mcp-redacted", // unknown mode string → strict, not "full"
    });
  });

  it("filters non-string entries out of whitelist/blacklist arrays", async () => {
    const { cap, calls } = makeCap();
    await state({}, makeCtx(cap, { whitelist: ["ui", 5, null], blacklist: ["*x*", {}] }));
    expect(calls.getState.mock.calls[0]![0].redaction).toEqual({
      whitelist: ["ui"],
      extraBlacklist: ["*x*"],
      mode: "mcp-redacted",
    });
  });
});

describe("redux tools — per-call mode override (Electron panel)", () => {
  it("state({mode:'full'}) overrides the config default (mcp-redacted)", async () => {
    const { cap, calls } = makeCap();
    await state({ mode: "full" }, makeCtx(cap, {})); // config has no mode ⇒ default mcp-redacted
    expect(calls.getState.mock.calls[0]![0].redaction.mode).toBe("full");
  });

  it("per-call mode can also TIGHTEN: mode:'mcp-redacted' over a config of 'full'", async () => {
    const { cap, calls } = makeCap();
    await state({ mode: "mcp-redacted" }, makeCtx(cap, { mode: "full" }));
    expect(calls.getState.mock.calls[0]![0].redaction.mode).toBe("mcp-redacted");
  });

  it("override changes ONLY the mode — whitelist/blacklist still come from config", async () => {
    const { cap, calls } = makeCap();
    await state({ mode: "full" }, makeCtx(cap, { whitelist: ["ui"], blacklist: ["*x*"] }));
    expect(calls.getState.mock.calls[0]![0].redaction).toEqual({
      whitelist: ["ui"],
      extraBlacklist: ["*x*"],
      mode: "full",
    });
  });

  it("actions() and action() honor the per-call mode too", async () => {
    const { cap, calls } = makeCap();
    await actions({ limit: 10, mode: "full" }, makeCtx(cap, {}));
    await action({ sequence: 1, mode: "full" }, makeCtx(cap, {}));
    expect(calls.listActions.mock.calls[0]![0].redaction.mode).toBe("full");
    expect(calls.getAction.mock.calls[0]![0].redaction.mode).toBe("full");
  });
});
