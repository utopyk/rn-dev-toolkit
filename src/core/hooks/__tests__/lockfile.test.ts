import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hookLockfilePath,
  hookLockfilesRoot,
  readHookLockfile,
  unlinkHookLockfile,
  writeHookLockfile,
} from "../lockfile.js";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "hook-lock-")));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("hookLockfilesRoot / hookLockfilePath", () => {
  it("uses the override when provided", () => {
    expect(hookLockfilesRoot(tmpRoot)).toBe(tmpRoot);
    expect(hookLockfilePath(42, tmpRoot)).toBe(join(tmpRoot, "42.lock"));
  });

  it("falls back to RN_DEV_HOOKS_ROOT when no explicit override", () => {
    const prev = process.env.RN_DEV_HOOKS_ROOT;
    process.env.RN_DEV_HOOKS_ROOT = tmpRoot;
    try {
      expect(hookLockfilesRoot()).toBe(tmpRoot);
    } finally {
      if (prev === undefined) delete process.env.RN_DEV_HOOKS_ROOT;
      else process.env.RN_DEV_HOOKS_ROOT = prev;
    }
  });

  it("ignores empty RN_DEV_HOOKS_ROOT", () => {
    const prev = process.env.RN_DEV_HOOKS_ROOT;
    process.env.RN_DEV_HOOKS_ROOT = "";
    try {
      expect(hookLockfilesRoot().endsWith(".rn-dev/hooks")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.RN_DEV_HOOKS_ROOT;
      else process.env.RN_DEV_HOOKS_ROOT = prev;
    }
  });

  it("defaults to ~/.rn-dev/hooks when no override and env unset", () => {
    const prev = process.env.RN_DEV_HOOKS_ROOT;
    delete process.env.RN_DEV_HOOKS_ROOT;
    try {
      expect(hookLockfilesRoot().endsWith(".rn-dev/hooks")).toBe(true);
    } finally {
      if (prev !== undefined) process.env.RN_DEV_HOOKS_ROOT = prev;
    }
  });
});

describe("writeHookLockfile", () => {
  it("creates the file with the recorded triple", () => {
    const path = writeHookLockfile({
      pgid: 1234,
      daemonPid: 5678,
      target: "session/init",
      rootOverride: tmpRoot,
      now: () => 9999,
    });
    expect(path).toBe(join(tmpRoot, "1234.lock"));
    expect(readHookLockfile(path)).toEqual({
      daemonPid: 5678,
      target: "session/init",
      ts: 9999,
    });
  });

  it("creates the parent directory when missing", () => {
    const sub = join(tmpRoot, "nested", "hooks");
    const path = writeHookLockfile({
      pgid: 7,
      daemonPid: 8,
      target: "x/y",
      rootOverride: sub,
    });
    expect(existsSync(path)).toBe(true);
  });

  it("writes the lockfile mode 0600 (no other-readable leakage)", () => {
    const path = writeHookLockfile({
      pgid: 1,
      daemonPid: 2,
      target: "x/y",
      rootOverride: tmpRoot,
    });
    const stat = statSync(path);
    // 0o600: rw-------, no group/other access. Other bits (file-type)
    // live above; mask to permission bits before comparing.
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("unlinkHookLockfile", () => {
  it("removes the lockfile when it exists", () => {
    const path = writeHookLockfile({
      pgid: 1,
      daemonPid: 2,
      target: "x/y",
      rootOverride: tmpRoot,
    });
    unlinkHookLockfile(path);
    expect(existsSync(path)).toBe(false);
  });

  it("is a no-op when the lockfile is already gone", () => {
    const path = join(tmpRoot, "missing.lock");
    expect(() => unlinkHookLockfile(path)).not.toThrow();
  });
});

describe("readHookLockfile — input validation", () => {
  it("returns null for a missing path", () => {
    expect(readHookLockfile(join(tmpRoot, "nope.lock"))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const path = join(tmpRoot, "bad.lock");
    writeFileSync(path, "not json", "utf-8");
    expect(readHookLockfile(path)).toBeNull();
  });

  it("returns null when daemonPid is missing or wrong type", () => {
    const path = join(tmpRoot, "1.lock");
    writeFileSync(
      path,
      JSON.stringify({ target: "x/y", ts: 1 }),
      "utf-8",
    );
    expect(readHookLockfile(path)).toBeNull();
    writeFileSync(
      path,
      JSON.stringify({ daemonPid: "1", target: "x/y", ts: 1 }),
      "utf-8",
    );
    expect(readHookLockfile(path)).toBeNull();
  });

  it("returns null when target is missing or wrong type", () => {
    const path = join(tmpRoot, "1.lock");
    writeFileSync(
      path,
      JSON.stringify({ daemonPid: 1, ts: 1 }),
      "utf-8",
    );
    expect(readHookLockfile(path)).toBeNull();
  });
});
