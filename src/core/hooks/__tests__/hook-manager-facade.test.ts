// Facade preservation tests (todo #002). H2 callers
// (e.g. `src/daemon/client-rpcs.ts`) bind to the HookManager surface;
// any silent rename or signature change here would break them. These
// tests pin the surface so a regression fails CI loudly.

import { describe, it, expect, expectTypeOf } from "vitest";
import { HookManager } from "../manager.js";
import type { HookPhase } from "@rn-dev/config";
import type { FireOutcome } from "../dispatcher.js";
import type { ValidatedProfile } from "../../../daemon/profile-guard.js";
import type { Registration, RegistrationInput, RegistryDump } from "../types.js";

describe("HookManager — facade method snapshot", () => {
  it("exposes the H1-stable public method set (no rename without review)", () => {
    const methods = Object.getOwnPropertyNames(HookManager.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual([
      "addRegistration",
      "declareProvider",
      "dumpRegistry",
      "fire",
      "orphanedRegistrations",
      "retractProvider",
    ]);
  });

  it("extends EventEmitter so callers can subscribe to hooks/* events", () => {
    expect(HookManager.prototype).toHaveProperty("on");
    expect(HookManager.prototype).toHaveProperty("emit");
    expect(HookManager.prototype).toHaveProperty("off");
  });
});

describe("HookManager — typed signatures", () => {
  it("`fire` accepts (HookPhase, unknown, ValidatedProfile) and returns Promise<FireOutcome>", () => {
    expectTypeOf<HookManager["fire"]>().parameters.toEqualTypeOf<
      [HookPhase, unknown, ValidatedProfile]
    >();
    expectTypeOf<HookManager["fire"]>().returns.toEqualTypeOf<Promise<FireOutcome>>();
  });

  it("`addRegistration` accepts RegistrationInput and returns Promise<Registration>", () => {
    expectTypeOf<HookManager["addRegistration"]>().parameters.toEqualTypeOf<
      [RegistrationInput]
    >();
    expectTypeOf<HookManager["addRegistration"]>().returns.toEqualTypeOf<
      Promise<Registration>
    >();
  });

  it("`declareProvider` accepts (string, readonly string[]) and returns void", () => {
    expectTypeOf<HookManager["declareProvider"]>().parameters.toEqualTypeOf<
      [string, readonly string[]]
    >();
    expectTypeOf<HookManager["declareProvider"]>().returns.toEqualTypeOf<void>();
  });

  it("`dumpRegistry` returns RegistryDump (debug API, internal)", () => {
    expectTypeOf<HookManager["dumpRegistry"]>().returns.toEqualTypeOf<RegistryDump>();
  });
});
