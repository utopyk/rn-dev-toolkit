import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookError, HookErrorCode } from "@rn-dev/module-sdk";
import { assertDevMode, getDaemonMode } from "../daemon-mode.js";

const ENV = "RN_DEV_DAEMON_MODE";
let original: string | undefined;

beforeEach(() => {
  original = process.env[ENV];
  delete process.env[ENV];
});

afterEach(() => {
  if (original === undefined) delete process.env[ENV];
  else process.env[ENV] = original;
});

describe("getDaemonMode", () => {
  it("defaults to 'prod' when env var is unset", () => {
    expect(getDaemonMode()).toBe("prod");
  });

  it("returns 'dev' for the exact literal 'dev'", () => {
    process.env[ENV] = "dev";
    expect(getDaemonMode()).toBe("dev");
  });

  it.each([
    ["DEV"],
    ["Dev"],
    ["development"],
    ["true"],
    ["1"],
    [" dev"],
    ["dev "],
    [""],
  ])("treats %j as 'prod' (fail-closed)", (value) => {
    process.env[ENV] = value;
    expect(getDaemonMode()).toBe("prod");
  });
});

describe("assertDevMode", () => {
  it("returns without throwing in dev mode for either sub-mode", () => {
    process.env[ENV] = "dev";
    expect(() => assertDevMode("real")).not.toThrow();
    expect(() => assertDevMode("synthetic")).not.toThrow();
  });

  it("throws E_HOOK_RUN_REAL_DENIED in prod mode for mode='real'", () => {
    expect(() => assertDevMode("real")).toThrow(HookError);
    try {
      assertDevMode("real");
      throw new Error("unreachable");
    } catch (err) {
      const e = err as HookError;
      expect(e.code).toBe(HookErrorCode.E_HOOK_RUN_REAL_DENIED);
      expect(e.details).toEqual({
        code: HookErrorCode.E_HOOK_RUN_REAL_DENIED,
        mode: "real",
        daemonMode: "prod",
      });
    }
  });

  it("throws E_HOOK_RUN_REAL_DENIED in prod mode for mode='synthetic'", () => {
    expect(() => assertDevMode("synthetic")).toThrow(HookError);
    try {
      assertDevMode("synthetic");
      throw new Error("unreachable");
    } catch (err) {
      const e = err as HookError;
      expect(e.code).toBe(HookErrorCode.E_HOOK_RUN_REAL_DENIED);
      expect(e.details).toEqual({
        code: HookErrorCode.E_HOOK_RUN_REAL_DENIED,
        mode: "synthetic",
        daemonMode: "prod",
      });
    }
  });

  it("includes the current daemonMode in the error message", () => {
    process.env[ENV] = "DEV"; // misspelled — reads as prod
    try {
      assertDevMode("real");
      throw new Error("unreachable");
    } catch (err) {
      const e = err as HookError;
      expect(e.message).toContain("RN_DEV_DAEMON_MODE=prod");
      expect(e.message).toContain("Set RN_DEV_DAEMON_MODE=dev");
    }
  });
});
