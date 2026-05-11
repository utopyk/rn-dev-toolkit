import { describe, it, expect } from "vitest";
import { HookRegistry, suggestHookName } from "../registry.js";
import type { RegistrationInput } from "../types.js";

function fnReg(
  target: string,
  symbol: string,
  opts: { priority?: number; onFail?: "hard" | "warn" | "retry" } = {},
): RegistrationInput {
  return {
    target: target as `${string}/${string}`,
    source: { kind: "project", configPath: "/p/rn-dev.config.ts" },
    entry: { fn: () => undefined, priority: opts.priority, onFail: opts.onFail },
    resolved: { kind: "fn", symbol, fn: () => undefined },
  };
}

describe("HookRegistry — providers + orphans", () => {
  it("declares providers and recognises known hook names", () => {
    const r = new HookRegistry();
    r.declareProvider("build", ["pre", "post"]);
    expect(r.isProviderKnown("build", "pre")).toBe(true);
    expect(r.isProviderKnown("build", "missing")).toBe(false);
    expect(r.isProviderKnown("unknown", "pre")).toBe(false);
  });

  it("marks a registration orphaned when the target's <moduleId> is unknown", () => {
    const r = new HookRegistry();
    const reg = r.addRegistration(fnReg("ghost/pre", "ghostPre"));
    expect(reg.orphaned).toBe(true);
  });

  it("marks a registration orphaned when the <hookName> is not declared by the provider", () => {
    const r = new HookRegistry();
    r.declareProvider("build", ["pre"]);
    const reg = r.addRegistration(fnReg("build/post", "buildPost"));
    expect(reg.orphaned).toBe(true);
  });

  it("clears orphan flags via recomputeOrphans when the provider declares the slot later", () => {
    const r = new HookRegistry();
    const reg = r.addRegistration(fnReg("build/pre", "buildPre"));
    expect(reg.orphaned).toBe(true);
    r.declareProvider("build", ["pre"]);
    const flipped = r.recomputeOrphans();
    expect(flipped).toHaveLength(1);
    expect(flipped[0].target).toBe("build/pre");
    expect(reg.orphaned).toBe(false);
  });

  it("re-orphans registrations when the provider is retracted", () => {
    const r = new HookRegistry();
    r.declareProvider("build", ["pre"]);
    const reg = r.addRegistration(fnReg("build/pre", "buildPre"));
    expect(reg.orphaned).toBe(false);
    r.retractProvider("build");
    r.recomputeOrphans();
    expect(reg.orphaned).toBe(true);
  });
});

describe("HookRegistry — pre-baked sort order", () => {
  it("sorts by priority desc, then registrationOrder asc", () => {
    const r = new HookRegistry();
    r.declareProvider("build", ["pre"]);
    const a = r.addRegistration(fnReg("build/pre", "a", { priority: 0 }));
    const b = r.addRegistration(fnReg("build/pre", "b", { priority: 10 }));
    const c = r.addRegistration(fnReg("build/pre", "c", { priority: 10 }));
    const d = r.addRegistration(fnReg("build/pre", "d", { priority: 5 }));
    const list = r.registrationsFor("build/pre");
    // priority 10 first (b before c by registrationOrder), then 5, then 0
    expect(list.map((r) => r.resolved.kind === "fn" && r.resolved.symbol)).toEqual([
      "b",
      "c",
      "d",
      "a",
    ]);
    void d;
  });

  it("hasAnyRegistration is false for a slot with no registrations", () => {
    const r = new HookRegistry();
    expect(r.hasAnyRegistration("build/pre")).toBe(false);
  });

  it("hasAnyRegistration becomes true once a registration is added", () => {
    const r = new HookRegistry();
    r.addRegistration(fnReg("build/pre", "a"));
    expect(r.hasAnyRegistration("build/pre")).toBe(true);
  });
});

describe("HookRegistry — single override invariant", () => {
  it("allows one non-orphaned override per slot", () => {
    const r = new HookRegistry();
    r.declareProvider("build", ["custom"]);
    expect(() => r.addRegistration(fnReg("build/custom", "first"))).not.toThrow();
  });

  it("rejects a second non-orphaned override registration", () => {
    const r = new HookRegistry();
    r.declareProvider("build", ["custom"]);
    r.addRegistration(fnReg("build/custom", "first"));
    expect(() => r.addRegistration(fnReg("build/custom", "second"))).toThrow(
      /multiple-override/,
    );
  });

  it("does not block override registration when the first is orphaned (no provider)", () => {
    const r = new HookRegistry();
    expect(() => r.addRegistration(fnReg("build/custom", "first"))).not.toThrow();
    // Both orphaned — no provider yet.
    expect(() => r.addRegistration(fnReg("build/custom", "second"))).not.toThrow();
  });
});

describe("HookRegistry — removeBySource", () => {
  it("removes registrations matched by predicate and returns count", () => {
    const r = new HookRegistry();
    r.declareProvider("build", ["pre"]);
    const a = r.addRegistration(fnReg("build/pre", "a"));
    r.addRegistration(fnReg("build/pre", "b"));
    const removed = r.removeBySource((reg) => reg.registrationOrder === a.registrationOrder);
    expect(removed).toBe(1);
    expect(r.registrationsFor("build/pre")).toHaveLength(1);
  });

  it("frees the override slot when removing the override registration", () => {
    const r = new HookRegistry();
    r.declareProvider("build", ["custom"]);
    r.addRegistration(fnReg("build/custom", "first"));
    r.removeBySource((reg) => reg.target === "build/custom");
    // After removal, a fresh override must be permitted.
    expect(() => r.addRegistration(fnReg("build/custom", "second"))).not.toThrow();
  });
});

describe("HookRegistry — dump", () => {
  it("returns a structured snapshot suitable for vitest assertions", () => {
    const r = new HookRegistry();
    r.declareProvider("build", ["pre", "post"]);
    r.addRegistration(fnReg("build/pre", "a"));
    r.addRegistration(fnReg("build/pre", "b", { priority: 5 }));
    const dump = r.dump();
    expect(dump.providers).toEqual({ build: ["pre", "post"] });
    expect(dump.registrations["build/pre"]).toHaveLength(2);
    expect(dump.orphaned).toEqual([]);
  });
});

describe("suggestHookName", () => {
  it("suggests a close-by candidate", () => {
    expect(suggestHookName("ppre", ["pre", "post"])).toBe("pre");
  });

  it("returns undefined when no candidate is close enough", () => {
    expect(suggestHookName("zzzz", ["pre", "post"])).toBeUndefined();
  });

  it("returns undefined for an empty candidate list", () => {
    expect(suggestHookName("anything", [])).toBeUndefined();
  });
});
