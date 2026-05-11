import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AuditLog } from "../../audit-log.js";
import { HookManager } from "../manager.js";
import type { HookSubprocessRunResult } from "../runner-subprocess.js";
import type { ValidatedProfile } from "../../../daemon/profile-guard.js";
import type { Profile } from "../../types.js";

const baseProfile: Profile = {
  name: "test",
  isDefault: false,
  worktree: null,
  branch: "main",
  platform: "ios",
  mode: "quick",
  metroPort: 8081,
  devices: { ios: null, android: null },
  buildVariant: "debug",
  preflight: { checks: [], frequency: "once" },
  onSave: [],
  env: {},
  projectRoot: "/tmp/p",
};
const validated = baseProfile as ValidatedProfile;

let tmpRoot = "";
let auditLog: AuditLog;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "hook-mgr-"));
  auditLog = new AuditLog({
    path: join(tmpRoot, "audit.log"),
    keyPath: join(tmpRoot, "audit.key"),
    key: randomBytes(32),
  });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function fnReg(
  target: string,
  fn: (payload: unknown) => unknown,
  opts: { priority?: number; onFail?: "hard" | "warn" | "retry" } = {},
) {
  return {
    target: target as `${string}/${string}`,
    source: { kind: "project" as const, configPath: "/p/rn-dev.config.ts" },
    entry: { fn, priority: opts.priority, onFail: opts.onFail },
    resolved: { kind: "fn" as const, symbol: target, fn },
  };
}

const noopSubprocess = vi.fn(
  async (): Promise<HookSubprocessRunResult> => ({
    outcome: "ok",
    exitCode: 0,
    durationMs: 5,
    records: [],
  }),
);

describe("HookManager — empty-registry fast path", () => {
  it("returns ok=true without invoking dispatcher when no registrations exist", async () => {
    const mgr = new HookManager({
      auditLog,
      daemonPid: 1234,
      runSubprocess: noopSubprocess,
    });
    const auditSpy = vi.spyOn(auditLog, "append");
    const firedSpy = vi.fn();
    mgr.on("hooks/fired", firedSpy);
    const outcome = await mgr.fire("build/pre", {}, validated);
    expect(outcome).toEqual({ ok: true, fired: 0, skipped: 0, failures: [] });
    expect(auditSpy).not.toHaveBeenCalled();
    // Phase H2g follow-up — hooks/fired DOES emit on the empty-
    // registry path so subscribers can answer "did my slot fire?
    // how many consumers?" instead of seeing silence on no-consumers.
    // Audit stays silent (audit policy: no entry for success).
    expect(firedSpy).toHaveBeenCalledTimes(1);
    expect(firedSpy).toHaveBeenCalledWith({
      target: "build/pre",
      outcome: { ok: true, fired: 0, skipped: 0, failures: [] },
    });
  });
});

describe("HookManager — in-process fire", () => {
  it("invokes a registered fn and returns ok=true", async () => {
    const mgr = new HookManager({ auditLog, daemonPid: 1, runSubprocess: noopSubprocess });
    mgr.declareProvider("build", ["pre"]);
    const fn = vi.fn();
    await mgr.addRegistration(fnReg("build/pre", fn));
    const outcome = await mgr.fire("build/pre", { kind: "test" }, validated);
    expect(outcome.ok).toBe(true);
    expect(outcome.fired).toBe(1);
    expect(fn).toHaveBeenCalledWith({ kind: "test" });
  });

  it("captures a thrown fn as a failure and returns ok=false", async () => {
    const mgr = new HookManager({ auditLog, daemonPid: 1, runSubprocess: noopSubprocess });
    mgr.declareProvider("build", ["pre"]);
    await mgr.addRegistration(
      fnReg("build/pre", () => {
        throw new Error("bang");
      }),
    );
    const outcome = await mgr.fire("build/pre", {}, validated);
    expect(outcome.ok).toBe(false);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0].reason).toBe("in-process-throw");
  });

  it("escalates onFail='hard' to a thrown HookError", async () => {
    const mgr = new HookManager({ auditLog, daemonPid: 1, runSubprocess: noopSubprocess });
    mgr.declareProvider("build", ["pre"]);
    await mgr.addRegistration(
      fnReg(
        "build/pre",
        () => {
          throw new Error("hard");
        },
        { onFail: "hard" },
      ),
    );
    await expect(mgr.fire("build/pre", {}, validated)).rejects.toThrow(/hard-failed/);
  });
});

describe("HookManager — orphan handling", () => {
  it("skips an orphaned registration without firing or auditing", async () => {
    const mgr = new HookManager({ auditLog, daemonPid: 1, runSubprocess: noopSubprocess });
    const fn = vi.fn();
    await mgr.addRegistration(fnReg("ghost/pre", fn));
    const auditSpy = vi.spyOn(auditLog, "append");
    const outcome = await mgr.fire("ghost/pre", {}, validated);
    expect(outcome).toEqual({ ok: true, fired: 0, skipped: 1, failures: [] });
    expect(fn).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("emits hooks/orphaned at registration time for unknown providers", async () => {
    const mgr = new HookManager({ auditLog, daemonPid: 1, runSubprocess: noopSubprocess });
    const orphanSpy = vi.fn();
    mgr.on("hooks/orphaned", orphanSpy);
    await mgr.addRegistration(fnReg("ghost/pre", () => {}));
    expect(orphanSpy).toHaveBeenCalledWith(
      expect.objectContaining({ target: "ghost/pre" }),
    );
  });

  it("re-registers an orphan once its provider declares the slot", async () => {
    const mgr = new HookManager({ auditLog, daemonPid: 1, runSubprocess: noopSubprocess });
    const registeredSpy = vi.fn();
    mgr.on("hooks/registered", registeredSpy);
    await mgr.addRegistration(fnReg("ghost/pre", () => {}));
    expect(registeredSpy).not.toHaveBeenCalled();
    mgr.declareProvider("ghost", ["pre"]);
    expect(registeredSpy).toHaveBeenCalled();
  });
});

describe("HookManager — dispatcher contract (cross-class integration)", () => {
  it("invokes registrations in (priority desc, registrationOrder asc) — no per-fire sort", async () => {
    const mgr = new HookManager({ auditLog, daemonPid: 1, runSubprocess: noopSubprocess });
    mgr.declareProvider("build", ["pre"]);
    const order: string[] = [];
    await mgr.addRegistration(fnReg("build/pre", () => order.push("a"), { priority: 0 }));
    await mgr.addRegistration(fnReg("build/pre", () => order.push("b"), { priority: 10 }));
    await mgr.addRegistration(fnReg("build/pre", () => order.push("c"), { priority: 10 }));
    await mgr.addRegistration(fnReg("build/pre", () => order.push("d"), { priority: 5 }));
    await mgr.fire("build/pre", {}, validated);
    expect(order).toEqual(["b", "c", "d", "a"]);
  });
});

describe("HookManager — audit-writer policy (cross-class integration)", () => {
  it("does NOT write any audit entry on a successful fire", async () => {
    const mgr = new HookManager({ auditLog, daemonPid: 1, runSubprocess: noopSubprocess });
    mgr.declareProvider("build", ["pre"]);
    await mgr.addRegistration(fnReg("build/pre", () => {}));
    const auditSpy = vi.spyOn(auditLog, "append");
    await mgr.fire("build/pre", {}, validated);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("writes exactly one audit entry on an in-process failure", async () => {
    const mgr = new HookManager({ auditLog, daemonPid: 1, runSubprocess: noopSubprocess });
    mgr.declareProvider("build", ["pre"]);
    await mgr.addRegistration(
      fnReg("build/pre", () => {
        throw new Error("oops");
      }),
    );
    const auditSpy = vi.spyOn(auditLog, "append");
    await mgr.fire("build/pre", {}, validated);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0][0]).toMatchObject({
      kind: "hook",
      reason: "failure",
      outcome: "error",
    });
  });

  it("writes exactly one audit entry on override registration", async () => {
    const mgr = new HookManager({ auditLog, daemonPid: 1, runSubprocess: noopSubprocess });
    mgr.declareProvider("build", ["custom"]);
    const auditSpy = vi.spyOn(auditLog, "append");
    await mgr.addRegistration(fnReg("build/custom", () => {}));
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0][0]).toMatchObject({
      kind: "hook",
      reason: "override-registered",
      outcome: "ok",
    });
  });
});

describe("HookManager — concurrent-fire queue cap", () => {
  it("rejects with queue-full and audits when cap is exceeded", async () => {
    const mgr = new HookManager({
      auditLog,
      daemonPid: 1,
      runSubprocess: noopSubprocess,
      concurrentFireCap: 1,
    });
    mgr.declareProvider("build", ["pre"]);
    let release!: () => void;
    const slow = new Promise<void>((r) => {
      release = r;
    });
    await mgr.addRegistration(fnReg("build/pre", () => slow));
    const first = mgr.fire("build/pre", {}, validated);
    // Second fire — should hit queue-full while `first` is in flight.
    const second = mgr.fire("build/pre", {}, validated);
    const secondOutcome = await second;
    expect(secondOutcome.ok).toBe(false);
    expect(secondOutcome.failures[0].reason).toBe("queue-full");
    release();
    await first;
  });
});

describe("HookManager — dumpRegistry", () => {
  it("exposes providers + registrations + orphans for vitest assertions", async () => {
    const mgr = new HookManager({ auditLog, daemonPid: 1, runSubprocess: noopSubprocess });
    mgr.declareProvider("build", ["pre", "post"]);
    await mgr.addRegistration(fnReg("build/pre", () => {}));
    await mgr.addRegistration(fnReg("ghost/pre", () => {}));
    const dump = mgr.dumpRegistry();
    expect(dump.providers).toEqual({ build: ["pre", "post"] });
    expect(dump.registrations["build/pre"]).toHaveLength(1);
    expect(dump.orphaned).toHaveLength(1);
    expect(dump.orphaned[0].target).toBe("ghost/pre");
  });
});
