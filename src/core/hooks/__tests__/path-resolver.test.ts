import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookError, HookErrorCode } from "@rn-dev/module-sdk";
import {
  resolveHookScript,
  checkFingerprint,
} from "../path-resolver.js";

let tmpRoot = "";

beforeEach(() => {
  // realpath here so subsequent comparisons line up on macOS where
  // /var/folders/* is a symlink to /private/var/folders/*.
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "hook-pathres-")));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveHookScript — happy path", () => {
  it("resolves a relative path under the configDir", () => {
    const script = join(tmpRoot, "bin", "pre.sh");
    mkdirSync(join(tmpRoot, "bin"));
    writeFileSync(script, "#!/bin/bash\n");
    const result = resolveHookScript("./bin/pre.sh", tmpRoot);
    expect(result.declaredPath).toBe("./bin/pre.sh");
    expect(result.fingerprint.realPath).toBe(script);
    expect(result.fingerprint.dev).toBeGreaterThan(0);
    expect(result.fingerprint.ino).toBeGreaterThan(0);
  });

  it("accepts an absolute path that lives under configDir", () => {
    const script = join(tmpRoot, "pre.sh");
    writeFileSync(script, "#!/bin/bash\n");
    const result = resolveHookScript(script, tmpRoot);
    expect(result.fingerprint.realPath).toBe(script);
  });
});

describe("resolveHookScript — security rejections", () => {
  it("rejects a `~`-prefixed path outright", () => {
    expect(() => resolveHookScript("~/evil.sh", tmpRoot)).toThrow(HookError);
    try {
      resolveHookScript("~/evil.sh", tmpRoot);
    } catch (err) {
      expect(err).toBeInstanceOf(HookError);
      if (err instanceof HookError) {
        expect(err.code).toBe(HookErrorCode.E_HOOK_PATH_OUTSIDE_PROJECT);
      }
    }
  });

  it("rejects an absolute path outside the configDir", () => {
    const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), "hook-other-")));
    const stranger = join(otherRoot, "stranger.sh");
    writeFileSync(stranger, "#!/bin/bash\n");
    try {
      expect(() => resolveHookScript(stranger, tmpRoot)).toThrow(
        /outside project root/,
      );
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("rejects a relative path that walks above configDir via `..`", () => {
    const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), "hook-other-")));
    const stranger = join(otherRoot, "stranger.sh");
    writeFileSync(stranger, "#!/bin/bash\n");
    try {
      expect(() =>
        resolveHookScript("../" + stranger.split("/").slice(-2).join("/"), tmpRoot),
      ).toThrow(/outside project root|Failed to resolve/);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("rejects a symlink chain that escapes configDir", () => {
    const innerLink = join(tmpRoot, "shim.sh");
    const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), "hook-link-target-")));
    const target = join(otherRoot, "target.sh");
    writeFileSync(target, "#!/bin/bash\n");
    try {
      symlinkSync(target, innerLink);
      expect(() => resolveHookScript("./shim.sh", tmpRoot)).toThrow(
        /outside project root/,
      );
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("rejects when the script path does not exist", () => {
    expect(() => resolveHookScript("./nope.sh", tmpRoot)).toThrow(
      /Failed to resolve/,
    );
  });
});

describe("checkFingerprint", () => {
  it("returns ok=true when the file is unchanged", () => {
    const script = join(tmpRoot, "stable.sh");
    writeFileSync(script, "#!/bin/bash\n");
    const resolved = resolveHookScript("./stable.sh", tmpRoot);
    expect(checkFingerprint(resolved)).toEqual({ ok: true });
  });

  it("returns ok=false when the file is replaced after registration (inode drift)", () => {
    const script = join(tmpRoot, "drift.sh");
    writeFileSync(script, "#!/bin/bash\n");
    const resolved = resolveHookScript("./drift.sh", tmpRoot);
    rmSync(script);
    writeFileSync(script, "#!/bin/bash\necho replaced\n");
    const result = checkFingerprint(resolved);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/inode drift/);
    }
  });

  it("returns ok=false when realpath drifts (symlink swap)", () => {
    const realA = join(tmpRoot, "a.sh");
    const realB = join(tmpRoot, "b.sh");
    const link = join(tmpRoot, "active.sh");
    writeFileSync(realA, "#!/bin/bash\n");
    writeFileSync(realB, "#!/bin/bash\n");
    symlinkSync(realA, link);
    const resolved = resolveHookScript("./active.sh", tmpRoot);
    expect(resolved.fingerprint.realPath).toBe(realA);
    // Swap the symlink target
    rmSync(link);
    symlinkSync(realB, link);
    const result = checkFingerprint(resolved);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/realpath drift/);
    }
  });
});
