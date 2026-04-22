import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ModuleLockfile } from "../lockfile.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rn-dev-lockfile-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lockPath(): string {
  return join(dir, ".lock");
}

// ---------------------------------------------------------------------------
// acquire / release — single holder
// ---------------------------------------------------------------------------

describe("ModuleLockfile — acquire (fresh)", () => {
  it("acquires an unheld lock and reports 'acquired'", () => {
    const lf = new ModuleLockfile(lockPath());
    const result = lf.acquire({ pid: process.pid, uid: process.getuid?.() ?? 0 });
    expect(result.kind).toBe("acquired");
    expect(result.holder.pid).toBe(process.pid);
    expect(existsSync(lockPath())).toBe(true);
  });

  it("writes a JSON payload containing pid, uid, acquiredAt", () => {
    const lf = new ModuleLockfile(lockPath());
    lf.acquire({ pid: 12345, uid: 501 });
    const raw = readFileSync(lockPath(), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.pid).toBe(12345);
    expect(parsed.uid).toBe(501);
    expect(typeof parsed.acquiredAt).toBe("number");
  });

  it("accepts an optional socketPath for cross-process proxy routing", () => {
    const lf = new ModuleLockfile(lockPath());
    lf.acquire({
      pid: 12345,
      uid: 501,
      socketPath: "/tmp/rn-dev-module.sock",
    });
    const parsed = JSON.parse(readFileSync(lockPath(), "utf-8"));
    expect(parsed.socketPath).toBe("/tmp/rn-dev-module.sock");
  });
});

describe("ModuleLockfile — acquire (contention)", () => {
  it("second acquire while a live holder exists returns 'held-by-other'", () => {
    const first = new ModuleLockfile(lockPath());
    first.acquire({ pid: process.pid, uid: 0 });

    const second = new ModuleLockfile(lockPath());
    const result = second.acquire({ pid: 99999, uid: 0 });

    expect(result.kind).toBe("held-by-other");
    expect(result.holder.pid).toBe(process.pid);
  });

  it("steals a stale lockfile (dead PID) and becomes the new holder", () => {
    // Write a lockfile pointing at a PID that almost certainly isn't running.
    // PID 2^31 - 1 is far above any OS-assignable PID.
    const stalePid = 2 ** 31 - 1;
    writeFileSync(
      lockPath(),
      JSON.stringify({
        pid: stalePid,
        uid: 0,
        acquiredAt: Date.now() - 86_400_000,
      }),
    );

    const lf = new ModuleLockfile(lockPath());
    const result = lf.acquire({ pid: process.pid, uid: 0 });
    expect(result.kind).toBe("acquired");
    expect(result.holder.pid).toBe(process.pid);

    const re = JSON.parse(readFileSync(lockPath(), "utf-8"));
    expect(re.pid).toBe(process.pid);
  });

  it("rejects a corrupt lockfile (non-JSON) by treating it as stale", () => {
    writeFileSync(lockPath(), "not valid json at all");
    const lf = new ModuleLockfile(lockPath());
    const result = lf.acquire({ pid: process.pid, uid: 0 });
    expect(result.kind).toBe("acquired");
  });
});

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

describe("ModuleLockfile — release", () => {
  it("release() removes the lockfile and returns true when we held it", () => {
    const lf = new ModuleLockfile(lockPath());
    lf.acquire({ pid: process.pid, uid: 0 });
    expect(lf.release()).toBe(true);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("release() returns false when the lockfile does not exist", () => {
    const lf = new ModuleLockfile(lockPath());
    expect(lf.release()).toBe(false);
  });

  it("release() refuses to remove a lockfile held by another live PID", () => {
    // Forge a lockfile pointing at PID 1 (init/launchd — always alive).
    // We're in the current process; we should NOT be able to release
    // someone else's valid lockfile.
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: 1, uid: 0, acquiredAt: Date.now() }),
    );

    const lf = new ModuleLockfile(lockPath());
    expect(lf.release()).toBe(false);
    expect(existsSync(lockPath())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// peek
// ---------------------------------------------------------------------------

describe("ModuleLockfile — peek", () => {
  it("peek() returns null when no lockfile exists", () => {
    const lf = new ModuleLockfile(lockPath());
    expect(lf.peek()).toBeNull();
  });

  it("peek() returns the holder for a live lockfile", () => {
    const lf = new ModuleLockfile(lockPath());
    lf.acquire({ pid: process.pid, uid: 0, socketPath: "/tmp/x.sock" });
    const peeked = lf.peek();
    expect(peeked?.pid).toBe(process.pid);
    expect(peeked?.socketPath).toBe("/tmp/x.sock");
  });

  it("peek() returns null for a stale lockfile (dead PID)", () => {
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: 2 ** 31 - 1, uid: 0, acquiredAt: 0 }),
    );
    const lf = new ModuleLockfile(lockPath());
    expect(lf.peek()).toBeNull();
  });

  it("peek() returns null for corrupt JSON", () => {
    writeFileSync(lockPath(), "{{{{");
    const lf = new ModuleLockfile(lockPath());
    expect(lf.peek()).toBeNull();
  });
});
