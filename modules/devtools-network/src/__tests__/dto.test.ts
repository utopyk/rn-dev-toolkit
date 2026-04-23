import { describe, it, expect } from "vitest";
import { toDto, toListDto } from "../dto.js";
import type { NetworkEntry, CaptureMeta } from "../types.js";

const META: CaptureMeta = {
  worktreeKey: "w",
  bufferEpoch: 1,
  oldestSequence: 1,
  lastEventSequence: 1,
  proxyStatus: "connected",
  selectedTargetId: "t1",
  evictedCount: 0,
  tapDroppedCount: 0,
  bodyTruncatedCount: 0,
  bodyCapture: "full",
  sessionBoundary: null,
};

function finishedEntry(): NetworkEntry {
  return {
    requestId: "r1",
    sequence: 1,
    version: 1,
    method: "GET",
    url: "https://x",
    requestHeaders: { "X-Api-Key": "[REDACTED]", Accept: "application/json" },
    requestBody: { kind: "absent", reason: "not-captured" },
    timings: { startedAt: 1000, completedAt: 1100, durationMs: 100 },
    source: "cdp",
    terminalState: "finished",
    status: 200,
    statusText: "OK",
    mimeType: "application/json",
    responseHeaders: { "Content-Type": "application/json" },
    responseBody: { kind: "text", data: '{"ok":true}', truncated: false, droppedBytes: 0 },
  };
}

describe("toDto", () => {
  it("preserves shape when captureBodies: true", () => {
    const dto = toDto(finishedEntry(), { captureBodies: true });
    expect(dto.terminalState).toBe("finished");
    expect(dto.status).toBe(200);
    expect(dto.responseBody?.kind).toBe("text");
    if (dto.responseBody?.kind === "text") {
      expect(dto.responseBody.data).toBe('{"ok":true}');
    }
    expect(dto.requestHeaders["X-Api-Key"]).toBe("[REDACTED]");
  });

  it("redacts bodies when captureBodies: false (S5)", () => {
    const dto = toDto(finishedEntry(), { captureBodies: false });
    expect(dto.responseBody?.kind).toBe("redacted");
    if (dto.responseBody?.kind === "redacted") {
      expect(dto.responseBody.reason).toBe("mcp-default");
    }
  });

  it("pass-through preserves already-absent bodies (no info leak)", () => {
    const entry: NetworkEntry = {
      ...finishedEntry(),
      responseBody: { kind: "absent", reason: "204-or-304" },
    };
    const dto = toDto(entry, { captureBodies: false });
    expect(dto.responseBody?.kind).toBe("absent");
    if (dto.responseBody?.kind === "absent") {
      expect(dto.responseBody.reason).toBe("204-or-304");
    }
  });

  it("pending entries omit status/responseBody", () => {
    const entry: NetworkEntry = {
      requestId: "r2",
      sequence: 2,
      version: 1,
      method: "POST",
      url: "https://x",
      requestHeaders: {},
      requestBody: { kind: "absent", reason: "not-captured" },
      timings: { startedAt: 1000 },
      source: "cdp",
      terminalState: "pending",
    };
    const dto = toDto(entry, { captureBodies: true });
    expect(dto.terminalState).toBe("pending");
    expect(dto.status).toBeUndefined();
    expect(dto.responseBody).toBeUndefined();
    expect(dto.timings.completedAt).toBeUndefined();
  });

  it("failed entries include failureReason", () => {
    const entry: NetworkEntry = {
      requestId: "r3",
      sequence: 3,
      version: 1,
      method: "GET",
      url: "https://x",
      requestHeaders: {},
      requestBody: { kind: "absent", reason: "not-captured" },
      timings: { startedAt: 1000, completedAt: 1100, durationMs: 100 },
      source: "cdp",
      terminalState: "failed",
      failureReason: "net::ERR_FAILED",
    };
    const dto = toDto(entry, { captureBodies: true });
    expect(dto.terminalState).toBe("failed");
    expect(dto.failureReason).toBe("net::ERR_FAILED");
  });
});

describe("toListDto", () => {
  it("sets bodyCapture to mcp-redacted when captureBodies false", () => {
    const dto = toListDto(
      {
        entries: [finishedEntry()],
        cursorDropped: false,
        meta: META,
      },
      { captureBodies: false }
    );
    expect(dto.meta.bodyCapture).toBe("mcp-redacted");
    expect(dto.entries[0]!.responseBody?.kind).toBe("redacted");
  });

  it("preserves meta when captureBodies true", () => {
    const dto = toListDto(
      { entries: [], cursorDropped: false, meta: META },
      { captureBodies: true }
    );
    expect(dto.meta).toBe(META);
  });
});
