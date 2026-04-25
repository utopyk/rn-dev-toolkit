import { describe, expect, it } from "vitest";
import { SenderBindings } from "../sender-bindings.js";

describe("SenderBindings (unit)", () => {
  it("denies by default — unbound (connId, moduleId) pairs return false", () => {
    const sb = new SenderBindings();
    expect(sb.canCall("c1", "modA")).toBe(false);
  });

  it("bind() then canCall() returns true", () => {
    const sb = new SenderBindings();
    sb.bind("c1", "modA");
    expect(sb.canCall("c1", "modA")).toBe(true);
  });

  it("bindings are scoped to (connectionId, moduleId) — neither dimension leaks", () => {
    const sb = new SenderBindings();
    sb.bind("c1", "modA");
    expect(sb.canCall("c1", "modB")).toBe(false); // same conn, different module
    expect(sb.canCall("c2", "modA")).toBe(false); // different conn, same module
  });

  it("a single conn can bind multiple modules", () => {
    const sb = new SenderBindings();
    sb.bind("c1", "modA");
    sb.bind("c1", "modB");
    expect(sb.canCall("c1", "modA")).toBe(true);
    expect(sb.canCall("c1", "modB")).toBe(true);
  });

  it("clearConnection drops every binding the conn held", () => {
    const sb = new SenderBindings();
    sb.bind("c1", "modA");
    sb.bind("c1", "modB");
    sb.bind("c2", "modA");

    sb.clearConnection("c1");

    expect(sb.canCall("c1", "modA")).toBe(false);
    expect(sb.canCall("c1", "modB")).toBe(false);
    // c2's binding is unaffected.
    expect(sb.canCall("c2", "modA")).toBe(true);
  });

  it("clearConnection on an unknown id is a no-op", () => {
    const sb = new SenderBindings();
    sb.bind("c1", "modA");
    expect(() => sb.clearConnection("c-ghost")).not.toThrow();
    expect(sb.canCall("c1", "modA")).toBe(true);
  });
});
