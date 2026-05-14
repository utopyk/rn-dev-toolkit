// Phase M5 — `rn-dev/audit-tail` reads ~/.rn-dev/audit.log (NDJSON,
// HMAC-chained) and returns recent entries with optional filtering.
//
// Coverage:
//   - Missing audit log → empty array (fresh-install state).
//   - Returns most-recent `limit` entries in chronological order
//     (oldest → newest) so agents can iterate forward.
//   - `kind` filter narrows by exact match.
//   - `since` filter passes entries with ts > since.
//   - `sessionId` filter is forward-compat — v1 audit entries don't
//     carry sessionId so the filter returns [] when set.
//   - `limit` is capped at 200 even when callers pass higher.

import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readAuditTail } from "../tools.js";

function writeNDJSON(path: string, entries: object[]): void {
  const lines = entries.map((e) => JSON.stringify(e));
  writeFileSync(path, lines.join("\n") + "\n");
}

describe("readAuditTail (M5)", () => {
  it("returns an empty array when the audit log file does not exist", () => {
    const out = readAuditTail({
      limit: 50,
      since: null,
      kind: null,
      sessionId: null,
      auditLogPath: "/tmp/this-path-does-not-exist-audit.log",
    });
    expect(out).toEqual([]);
  });

  it("returns the most-recent N entries in chronological order", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-tail-"));
    const path = join(dir, "audit.log");
    writeNDJSON(path, [
      { kind: "install", ts: 100, seq: 1, moduleId: "a", outcome: "ok" },
      { kind: "install", ts: 200, seq: 2, moduleId: "b", outcome: "ok" },
      { kind: "host-call", ts: 300, seq: 3, moduleId: "c", outcome: "ok" },
      { kind: "install", ts: 400, seq: 4, moduleId: "d", outcome: "ok" },
    ]);

    const out = readAuditTail({
      limit: 2,
      since: null,
      kind: null,
      sessionId: null,
      auditLogPath: path,
    });
    expect(out).toHaveLength(2);
    // Oldest of the most-recent-2 first, then the most-recent.
    expect(out[0]?.["seq"]).toBe(3);
    expect(out[1]?.["seq"]).toBe(4);

    rmSync(dir, { recursive: true });
  });

  it("filters by kind", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-tail-"));
    const path = join(dir, "audit.log");
    writeNDJSON(path, [
      { kind: "install", ts: 100, seq: 1, outcome: "ok" },
      { kind: "hook", ts: 200, seq: 2, phase: "build/pre", outcome: "ok" },
      { kind: "install", ts: 300, seq: 3, outcome: "ok" },
      { kind: "hook", ts: 400, seq: 4, phase: "build/post", outcome: "error" },
    ]);

    const out = readAuditTail({
      limit: 50,
      since: null,
      kind: "hook",
      sessionId: null,
      auditLogPath: path,
    });
    expect(out.map((e) => e["seq"])).toEqual([2, 4]);

    rmSync(dir, { recursive: true });
  });

  it("filters by since (strict greater-than)", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-tail-"));
    const path = join(dir, "audit.log");
    writeNDJSON(path, [
      { kind: "install", ts: 100, seq: 1, outcome: "ok" },
      { kind: "install", ts: 200, seq: 2, outcome: "ok" },
      { kind: "install", ts: 300, seq: 3, outcome: "ok" },
    ]);

    const out = readAuditTail({
      limit: 50,
      since: 200,
      kind: null,
      sessionId: null,
      auditLogPath: path,
    });
    expect(out.map((e) => e["seq"])).toEqual([3]);

    rmSync(dir, { recursive: true });
  });

  it("returns [] when sessionId is provided but no entry carries one (v1 entries lack sessionId)", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-tail-"));
    const path = join(dir, "audit.log");
    writeNDJSON(path, [
      { kind: "install", ts: 100, seq: 1, outcome: "ok" },
      { kind: "hook", ts: 200, seq: 2, phase: "build/pre", outcome: "ok" },
    ]);

    const out = readAuditTail({
      limit: 50,
      since: null,
      kind: null,
      sessionId: "sid-1",
      auditLogPath: path,
    });
    expect(out).toEqual([]);

    rmSync(dir, { recursive: true });
  });

  it("filters by sessionId when an entry forward-compat carries one", () => {
    // Future audit kinds may include sessionId; this test pins the
    // filter behavior for that case without depending on a specific kind.
    const dir = mkdtempSync(join(tmpdir(), "audit-tail-"));
    const path = join(dir, "audit.log");
    writeNDJSON(path, [
      { kind: "session-start", ts: 100, seq: 1, sessionId: "sid-a", outcome: "ok" },
      { kind: "session-start", ts: 200, seq: 2, sessionId: "sid-b", outcome: "ok" },
      { kind: "install", ts: 300, seq: 3, outcome: "ok" }, // no sessionId
    ]);

    const out = readAuditTail({
      limit: 50,
      since: null,
      kind: null,
      sessionId: "sid-a",
      auditLogPath: path,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.["seq"]).toBe(1);

    rmSync(dir, { recursive: true });
  });

  it("ignores malformed lines without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-tail-"));
    const path = join(dir, "audit.log");
    writeFileSync(
      path,
      [
        JSON.stringify({ kind: "install", ts: 100, seq: 1, outcome: "ok" }),
        "not-json-at-all",
        "",
        JSON.stringify({ kind: "install", ts: 200, seq: 2, outcome: "ok" }),
      ].join("\n") + "\n",
    );

    const out = readAuditTail({
      limit: 50,
      since: null,
      kind: null,
      sessionId: null,
      auditLogPath: path,
    });
    expect(out.map((e) => e["seq"])).toEqual([1, 2]);

    rmSync(dir, { recursive: true });
  });

  it("returns [] when the directory containing the audit log is missing", () => {
    // The default path is ~/.rn-dev/audit.log; on a fresh install
    // neither the file nor its parent directory exist. The helper
    // must not throw.
    const dir = mkdtempSync(join(tmpdir(), "audit-tail-"));
    rmSync(dir, { recursive: true });
    const path = join(dir, "audit.log");

    const out = readAuditTail({
      limit: 50,
      since: null,
      kind: null,
      sessionId: null,
      auditLogPath: path,
    });
    expect(out).toEqual([]);
  });

  it("respects limit cap (200) even when the file has more matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-tail-cap-"));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "audit.log");
    const entries = Array.from({ length: 250 }, (_, i) => ({
      kind: "install",
      ts: i,
      seq: i + 1,
      outcome: "ok",
    }));
    writeNDJSON(path, entries);

    const out = readAuditTail({
      limit: 200, // The tool clamps user input to 200; helper trusts it.
      since: null,
      kind: null,
      sessionId: null,
      auditLogPath: path,
    });
    expect(out).toHaveLength(200);
    // The newest 200 entries — seq 51..250 in chronological order.
    expect(out[0]?.["seq"]).toBe(51);
    expect(out[199]?.["seq"]).toBe(250);

    rmSync(dir, { recursive: true });
  });
});
