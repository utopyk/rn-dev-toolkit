import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AuditLog } from "../../audit-log.js";
import { HookAuditWriter } from "../audit-writer.js";
import type { Registration } from "../types.js";

let tmpRoot = "";
let auditLog: AuditLog;
let writer: HookAuditWriter;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hook-audit-"));
  auditLog = new AuditLog({
    path: join(tmpRoot, "audit.log"),
    keyPath: join(tmpRoot, "audit.key"),
    key: randomBytes(32),
  });
  writer = new HookAuditWriter(auditLog);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function fnRegistration(target: string, symbol = "x"): Registration {
  return {
    target: target as `${string}/${string}`,
    source: { kind: "project", configPath: "/p/rn-dev.config.ts" },
    resolved: { kind: "fn", symbol, fn: () => undefined },
    priority: 0,
    registrationOrder: 0,
    onFail: "warn",
    isOverride: target.endsWith("/custom"),
    orphaned: false,
  };
}

describe("HookAuditWriter — failure policy", () => {
  it("does NOT write when outcome=ok (success path is silent)", async () => {
    const spy = vi.spyOn(auditLog, "append");
    await writer.writeFailure(fnRegistration("build/pre"), {
      outcome: "ok",
      durationMs: 10,
      exitCode: 0,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("writes a failure entry with reason='failure' on outcome=error", async () => {
    const spy = vi.spyOn(auditLog, "append");
    await writer.writeFailure(fnRegistration("build/pre"), {
      outcome: "error",
      durationMs: 100,
      exitCode: 2,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      kind: "hook",
      phase: "build/pre",
      source: "project",
      durationMs: 100,
      exitCode: 2,
      outcome: "error",
      reason: "failure",
    });
  });

  it("writes a denied entry too (warn-escalated failures)", async () => {
    const spy = vi.spyOn(auditLog, "append");
    await writer.writeFailure(fnRegistration("build/pre"), {
      outcome: "denied",
      durationMs: 0,
      exitCode: -1,
    });
    expect(spy.mock.calls[0][0]).toMatchObject({ outcome: "denied" });
  });
});

describe("HookAuditWriter — override registration policy", () => {
  it("always writes a record on override registration", async () => {
    const spy = vi.spyOn(auditLog, "append");
    await writer.writeOverrideRegistration(fnRegistration("build/custom"), "ok");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      kind: "hook",
      phase: "build/custom",
      reason: "override-registered",
      outcome: "ok",
    });
  });

  it("writes denied registrations too", async () => {
    const spy = vi.spyOn(auditLog, "append");
    await writer.writeOverrideRegistration(
      fnRegistration("build/custom"),
      "denied",
    );
    expect(spy.mock.calls[0][0]).toMatchObject({
      reason: "override-registered",
      outcome: "denied",
    });
  });
});

describe("HookAuditWriter — queue-full policy", () => {
  it("writes a denied entry with reason='queue-full'", async () => {
    const spy = vi.spyOn(auditLog, "append");
    await writer.writeQueueFull(fnRegistration("build/pre"));
    expect(spy.mock.calls[0][0]).toMatchObject({
      kind: "hook",
      reason: "queue-full",
      outcome: "denied",
    });
  });
});

describe("HookAuditWriter — source/scriptOrSymbol shape", () => {
  it("tags project-source registrations with 'project'", async () => {
    const spy = vi.spyOn(auditLog, "append");
    await writer.writeFailure(fnRegistration("build/pre"), {
      outcome: "error",
      durationMs: 1,
      exitCode: 1,
    });
    expect(spy.mock.calls[0][0]).toMatchObject({ source: "project" });
  });

  it("tags module-source registrations with 'module:<id>'", async () => {
    const reg: Registration = {
      ...fnRegistration("acme-firebase/build/pre"),
      source: {
        kind: "module",
        moduleId: "acme-firebase",
        manifestPath: "/m/manifest.json",
      },
    };
    const spy = vi.spyOn(auditLog, "append");
    await writer.writeFailure(reg, {
      outcome: "error",
      durationMs: 1,
      exitCode: 1,
    });
    expect(spy.mock.calls[0][0]).toMatchObject({
      source: "module:acme-firebase",
    });
  });

  it("uses 'fn:<symbol>' for in-process registrations", async () => {
    const spy = vi.spyOn(auditLog, "append");
    await writer.writeFailure(fnRegistration("build/pre", "myFn"), {
      outcome: "error",
      durationMs: 1,
      exitCode: 1,
    });
    expect(spy.mock.calls[0][0]).toMatchObject({ scriptOrSymbol: "fn:myFn" });
  });
});

