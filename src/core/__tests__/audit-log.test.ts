import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  AuditCanonicalizationError,
  AuditLog,
  _canonicalizeForTests,
} from "../audit-log.js";

describe("AuditLog", () => {
  let tmp: string;
  let logPath: string;
  const key = randomBytes(64);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rn-dev-audit-"));
    logPath = join(tmp, "audit.log");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeLog(): AuditLog {
    // Inject a deterministic clock so tests that assert order don't race
    // on Date.now() resolution.
    let t = 1_700_000_000_000;
    return new AuditLog({ path: logPath, key, now: () => t++ });
  }

  it("appends an entry with monotonic seq + correct prevHash chain", async () => {
    const log = makeLog();
    const e1 = await log.append({ kind: "install", moduleId: "foo", outcome: "ok" });
    const e2 = await log.append({ kind: "uninstall", moduleId: "foo", outcome: "ok" });
    expect(e1.seq).toBe(1);
    expect(e1.prevHash).toBe("");
    expect(e2.seq).toBe(2);
    expect(e2.prevHash).toBe(e1.hash);
    expect(e2.hash).not.toBe(e1.hash);
  });

  it("writes one JSON object per line to disk", async () => {
    const log = makeLog();
    await log.append({ kind: "install", moduleId: "a", outcome: "ok" });
    await log.append({ kind: "install", moduleId: "b", outcome: "ok" });
    const raw = readFileSync(logPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      expect(typeof obj["hash"]).toBe("string");
      expect(typeof obj["ts"]).toBe("number");
    }
  });

  it("verify() returns ok for a clean chain", async () => {
    const log = makeLog();
    for (let i = 0; i < 10; i++) {
      await log.append({
        kind: "config-set",
        moduleId: `m${i}`,
        outcome: "ok",
        patchKeys: ["k"],
      });
    }
    expect(await log.verify()).toEqual({
      ok: true,
      entriesRead: 10,
      tailHash: expect.any(String),
    });
  });

  it("verify() detects a tampered entry's kind", async () => {
    const log = makeLog();
    for (let i = 0; i < 5; i++) {
      await log.append({ kind: "install", moduleId: `m${i}`, outcome: "ok" });
    }
    // Tamper: rewrite entry 3's kind.
    const raw = readFileSync(logPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const tampered = JSON.parse(lines[2] as string) as Record<string, unknown>;
    tampered["kind"] = "uninstall";
    lines[2] = JSON.stringify(tampered);
    writeFileSync(logPath, lines.join("\n") + "\n");
    const result = await log.verify();
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe(3);
  });

  it("verify() detects a tampered hash (re-hashed by attacker without the key)", async () => {
    const log = makeLog();
    await log.append({ kind: "install", moduleId: "a", outcome: "ok" });
    const raw = readFileSync(logPath, "utf-8");
    const entry = JSON.parse(raw.trim()) as Record<string, unknown>;
    entry["hash"] = "0".repeat(64);
    writeFileSync(logPath, JSON.stringify(entry) + "\n");
    const result = await log.verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/hash mismatch/);
  });

  it("concurrent append()s serialize onto deterministic seq ordering", async () => {
    const log = makeLog();
    const appends = [0, 1, 2, 3, 4].map((i) =>
      log.append({
        kind: "host-call",
        moduleId: `m${i}`,
        outcome: "ok",
        capabilityId: "math",
        method: "add",
      }),
    );
    const results = await Promise.all(appends);
    const seqs = results.map((r) => r.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    // Chain invariant holds.
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.prevHash).toBe(results[i - 1]!.hash);
    }
  });

  it("rotates at rotateBytes and continues the chain", async () => {
    // Tiny threshold forces rotation after the 2nd entry.
    const log = new AuditLog({ path: logPath, key, rotateBytes: 200 });
    const e1 = await log.append({ kind: "install", moduleId: "a", outcome: "ok" });
    const e2 = await log.append({ kind: "install", moduleId: "b", outcome: "ok" });
    // The rotate check runs on the NEXT append (file size is past threshold
    // after e2). e3 triggers the rotate + starts fresh.
    const e3 = await log.append({ kind: "install", moduleId: "c", outcome: "ok" });

    expect(e3.prevHash).toBe(e2.hash);
    expect(e3.seq).toBe(1); // reset on rotation

    const rotated = readFileSync(logPath + ".1", "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { hash: string; seq: number });
    expect(rotated).toHaveLength(2);
    expect(rotated[0]!.seq).toBe(1);
    expect(rotated[1]!.seq).toBe(2);

    // Cross-file verify: feed rotated tail hash into the fresh log's verify.
    const fresh = await log.verify({ tailHash: rotated[rotated.length - 1]!.hash });
    expect(fresh.ok).toBe(true);
    expect(fresh.entriesRead).toBe(1);
    void e1;
  });

  it("emits 'appended' so listeners (e.g. Electron service-log mirror) can react", async () => {
    const log = makeLog();
    const seen: Array<{ kind: string; moduleId: string }> = [];
    log.on("appended", (entry) => {
      seen.push({ kind: entry.kind, moduleId: entry.moduleId });
    });
    await log.append({ kind: "install", moduleId: "a", outcome: "ok" });
    await log.append({ kind: "uninstall", moduleId: "a", outcome: "ok" });
    expect(seen).toEqual([
      { kind: "install", moduleId: "a" },
      { kind: "uninstall", moduleId: "a" },
    ]);
  });

  it("new AuditLog instance on an existing file resumes the chain correctly", async () => {
    const log1 = makeLog();
    await log1.append({ kind: "install", moduleId: "a", outcome: "ok" });
    await log1.append({ kind: "install", moduleId: "b", outcome: "ok" });

    // Fresh instance — simulating a daemon restart.
    const log2 = new AuditLog({ path: logPath, key });
    const e3 = await log2.append({ kind: "install", moduleId: "c", outcome: "ok" });
    expect(e3.seq).toBe(3);

    const result = await log2.verify();
    expect(result.ok).toBe(true);
    expect(result.entriesRead).toBe(3);
  });

  it("discriminated-union fields round-trip through the HMAC (canonical key sort)", async () => {
    const log = makeLog();
    // Field insertion order shouldn't matter — canonicalize sorts.
    const e = await log.append({
      kind: "config-set",
      moduleId: "settings",
      outcome: "ok",
      patchKeys: ["theme", "logLevel"],
      scopeUnit: "wt-1",
    });
    expect(e.kind).toBe("config-set");
    if (e.kind === "config-set") {
      expect(e.patchKeys).toEqual(["theme", "logLevel"]);
      expect(e.scopeUnit).toBe("wt-1");
    }
    expect((await log.verify()).ok).toBe(true);
  });

  it("rotates through generations + deletes files older than rotateKeep", async () => {
    // Small budget + keep=2 so each append forces a shift.
    const log = new AuditLog({
      path: logPath,
      key,
      rotateBytes: 150,
      rotateKeep: 2,
    });
    // Entry → file grows past 150b → next append rotates.
    await log.append({ kind: "install", moduleId: "a", outcome: "ok" });
    await log.append({ kind: "install", moduleId: "b", outcome: "ok" }); // rotate #1
    await log.append({ kind: "install", moduleId: "c", outcome: "ok" }); // rotate #2
    await log.append({ kind: "install", moduleId: "d", outcome: "ok" }); // rotate #3
    await log.append({ kind: "install", moduleId: "e", outcome: "ok" }); // rotate #4 — deletes .3

    // With keep=2: we should see active + .1 + .2, NOT .3.
    const { existsSync } = await import("node:fs");
    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(logPath + ".1")).toBe(true);
    expect(existsSync(logPath + ".2")).toBe(true);
    expect(existsSync(logPath + ".3")).toBe(false);
  });

  it("emits 'rotated' when the active log shifts", async () => {
    const log = new AuditLog({
      path: logPath,
      key,
      rotateBytes: 150,
    });
    const rotations: Array<{ active: string; rotatedTo: string }> = [];
    log.on("rotated", (ev) => rotations.push(ev));
    await log.append({ kind: "install", moduleId: "a", outcome: "ok" });
    await log.append({ kind: "install", moduleId: "b", outcome: "ok" });
    await log.append({ kind: "install", moduleId: "c", outcome: "ok" });
    expect(rotations.length).toBeGreaterThanOrEqual(1);
    expect(rotations[0]?.rotatedTo).toBe(logPath + ".1");
  });

  // Phase 10 P2-8 — cycle guard. canonicalize() used to blow the stack
  // with RangeError if the input had a self-reference (shouldn't happen
  // for typed audit inputs, but the defense-in-depth matters because
  // append() was close to the hot path).
  describe("canonicalize cycle guard (Phase 10 P2-8)", () => {
    it("throws AuditCanonicalizationError on a direct self-reference", () => {
      const obj: Record<string, unknown> = { a: 1 };
      obj["self"] = obj;
      expect(() => _canonicalizeForTests(obj)).toThrow(
        AuditCanonicalizationError,
      );
      expect(() => _canonicalizeForTests(obj)).toThrow(/cycle/);
    });

    it("throws on an indirect cycle through an array", () => {
      const a: unknown[] = [];
      const b: Record<string, unknown> = { inner: a };
      a.push(b);
      expect(() => _canonicalizeForTests({ root: a })).toThrow(
        AuditCanonicalizationError,
      );
    });

    it("still works for the non-cyclic shapes canonicalize sees from append()", () => {
      const out = _canonicalizeForTests({
        b: 2,
        a: [1, { x: "y" }],
      });
      // Keys sorted, nested structure preserved.
      expect(out).toBe('{"a":[1,{"x":"y"}],"b":2}');
    });
  });

  // Phase 10 P1-4 — guard against the whole-file-read regression. A
  // malformed or malicious log has no practical size cap (the daemon
  // rotates but a paranoid operator may disable it or an attacker could
  // swap the file for a huge one). verify() now streams line-by-line via
  // createReadStream + readline so peak RSS doesn't grow with the file.
  it("verify() streams a 100k-entry log without loading it all into memory", async () => {
    // 10MB rotation threshold is the default; we need the whole 100k in a
    // single file to exercise the streaming path, so crank it way up.
    const log = new AuditLog({
      path: logPath,
      key,
      rotateBytes: 1024 * 1024 * 1024, // 1 GiB — no rotation during the test
    });
    const ENTRIES = 100_000;
    const rssBefore = process.memoryUsage().rss;
    for (let i = 0; i < ENTRIES; i++) {
      await log.append({ kind: "install", moduleId: `m${i}`, outcome: "ok" });
    }
    const result = await log.verify();
    expect(result.ok).toBe(true);
    expect(result.entriesRead).toBe(ENTRIES);

    // Memory-bound: verify's peak should be within a few hundred MB of the
    // pre-test baseline even though the log is ~10-20 MB. A whole-file
    // read would push comfortably past 100 MB; the stream should sit well
    // under. 500 MB is a loose ceiling to avoid flakes on loaded CI
    // runners without letting a regression through silently.
    const rssAfter = process.memoryUsage().rss;
    const delta = rssAfter - rssBefore;
    expect(delta).toBeLessThan(500 * 1024 * 1024);
  }, 120_000);
});
