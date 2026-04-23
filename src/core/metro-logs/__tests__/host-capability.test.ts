import { describe, it, expect } from "vitest";
import { MetroLogsStore } from "../buffer.js";
import { createMetroLogsHostCapability } from "../host-capability.js";

const DEFAULT_WK = "wk-default";

function buildCap(opts?: { allowedWorktreeKeys?: () => readonly string[] }) {
  const store = new MetroLogsStore({ capacity: 50 });
  const cap = createMetroLogsHostCapability(
    store,
    DEFAULT_WK,
    opts?.allowedWorktreeKeys,
  );
  return { store, cap };
}

describe("createMetroLogsHostCapability — routing", () => {
  it("defaults to the host worktree when none supplied", async () => {
    const { store, cap } = buildCap();
    store.append(DEFAULT_WK, "stdout", "hello");
    const result = await cap.list({});
    expect(result.entries.map((e) => e.line)).toEqual(["hello"]);
    expect(result.meta.worktreeKey).toBe(DEFAULT_WK);
  });

  it("silently redirects an unknown worktree to the default (S6-ish: no cross-worktree peek)", async () => {
    const { store, cap } = buildCap({
      allowedWorktreeKeys: () => [DEFAULT_WK],
    });
    store.append(DEFAULT_WK, "stdout", "home");
    store.append("other", "stdout", "other-secret");
    const result = await cap.list({ worktreeKey: "other" });
    expect(result.entries.map((e) => e.line)).toEqual(["home"]);
    expect(result.meta.worktreeKey).toBe(DEFAULT_WK);
  });

  it("allows worktrees on the host's allowlist", async () => {
    const { store, cap } = buildCap({
      allowedWorktreeKeys: () => [DEFAULT_WK, "twin"],
    });
    store.append("twin", "stderr", "twin-line");
    const result = await cap.list({ worktreeKey: "twin" });
    expect(result.entries.map((e) => e.line)).toEqual(["twin-line"]);
    expect(result.meta.worktreeKey).toBe("twin");
  });

  it("clear() returns { status, meta } and bumps the epoch", async () => {
    const { store, cap } = buildCap();
    store.append(DEFAULT_WK, "stdout", "a");
    const before = await cap.status();
    expect(before.meta.bufferEpoch).toBe(1);
    const cleared = await cap.clear({});
    expect(cleared.status).toBe("cleared");
    expect(cleared.meta.bufferEpoch).toBe(2);
    expect(store.size(DEFAULT_WK)).toBe(0);
  });

  it("status() mirrors the underlying store", async () => {
    const { store, cap } = buildCap();
    store.append(DEFAULT_WK, "stdout", "l1");
    store.append(DEFAULT_WK, "stdout", "l2");
    const status = await cap.status();
    expect(status.bufferSize).toBe(2);
    expect(status.meta.totalLinesReceived).toBe(2);
    expect(status.meta.lastEventSequence).toBe(2);
  });
});
