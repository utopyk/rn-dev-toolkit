import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildSpawnCommand,
  hasSetpriv,
  wrapChild,
  __setSetprivProbeForTests,
  __resetSetprivCacheForTests,
} from "../spawn-utils.js";

const originalPlatform = process.platform;

function stubPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

describe("buildSpawnCommand", () => {
  beforeEach(() => __resetSetprivCacheForTests());
  afterEach(() => {
    __resetSetprivCacheForTests();
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("returns input unchanged on darwin", () => {
    stubPlatform("darwin");
    const result = buildSpawnCommand({ command: "node", args: ["foo.js"] });
    expect(result).toEqual({ command: "node", args: ["foo.js"] });
  });

  it("returns input unchanged on win32", () => {
    stubPlatform("win32");
    const result = buildSpawnCommand({ command: "bash", args: ["-c", "echo"] });
    expect(result).toEqual({ command: "bash", args: ["-c", "echo"] });
  });

  it("wraps with setpriv on linux when setpriv is available", () => {
    stubPlatform("linux");
    __setSetprivProbeForTests(() => true);
    const result = buildSpawnCommand({ command: "node", args: ["foo.js", "--flag"] });
    expect(result).toEqual({
      command: "setpriv",
      args: ["--pdeathsig", "SIGKILL", "--", "node", "foo.js", "--flag"],
    });
  });

  it("returns input unchanged on linux when setpriv is missing", () => {
    stubPlatform("linux");
    __setSetprivProbeForTests(() => false);
    const result = buildSpawnCommand({ command: "node", args: ["foo.js"] });
    expect(result).toEqual({ command: "node", args: ["foo.js"] });
  });

  it("preserves arbitrary commands (not just node)", () => {
    stubPlatform("linux");
    __setSetprivProbeForTests(() => true);
    const result = buildSpawnCommand({ command: "bash", args: ["-c", "echo hi"] });
    expect(result).toEqual({
      command: "setpriv",
      args: ["--pdeathsig", "SIGKILL", "--", "bash", "-c", "echo hi"],
    });
  });
});

describe("hasSetpriv (cache behavior)", () => {
  beforeEach(() => __resetSetprivCacheForTests());
  afterEach(() => __resetSetprivCacheForTests());

  it("memoizes the probe result", () => {
    let calls = 0;
    __setSetprivProbeForTests(() => {
      calls++;
      return true;
    });
    expect(hasSetpriv()).toBe(true);
    expect(hasSetpriv()).toBe(true);
    expect(hasSetpriv()).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("wrapChild", () => {
  it("throws when the child has no pid", () => {
    expect(() =>
      wrapChild({
        pid: undefined,
        stdin: {} as NodeJS.WritableStream,
        stdout: {} as NodeJS.ReadableStream,
        stderr: {} as NodeJS.ReadableStream,
        on: () => {
          /* noop */
        },
      } as unknown as Parameters<typeof wrapChild>[0]),
    ).toThrow(/incomplete ChildProcess/);
  });

  it("throws when stdio is missing", () => {
    expect(() =>
      wrapChild({
        pid: 12345,
        stdin: null,
        stdout: null,
        stderr: null,
        on: () => {
          /* noop */
        },
      } as unknown as Parameters<typeof wrapChild>[0]),
    ).toThrow(/incomplete ChildProcess/);
  });

  it("returns a handle that exposes pid + io", () => {
    const fakeChild = {
      pid: 99999,
      stdin: { write: () => true } as unknown as NodeJS.WritableStream,
      stdout: { on: () => undefined } as unknown as NodeJS.ReadableStream,
      stderr: { on: () => undefined } as unknown as NodeJS.ReadableStream,
      on: () => undefined,
    };
    const handle = wrapChild(fakeChild as unknown as Parameters<typeof wrapChild>[0]);
    expect(handle.pid).toBe(99999);
    expect(handle.stdin).toBe(fakeChild.stdin);
    expect(handle.stdout).toBe(fakeChild.stdout);
    expect(handle.stderr).toBe(fakeChild.stderr);
  });
});
