import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHeadFile,
  startHeadWatcher,
} from "../head-watcher.js";

describe("parseHeadFile", () => {
  it("returns the branch name for an attached HEAD", () => {
    expect(parseHeadFile("ref: refs/heads/main\n")).toBe("main");
    expect(parseHeadFile("ref: refs/heads/feat/foo\n")).toBe("feat/foo");
  });

  it("returns null for detached HEAD (raw SHA)", () => {
    expect(parseHeadFile("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n")).toBeNull();
  });

  it("returns null on garbage", () => {
    expect(parseHeadFile("")).toBeNull();
    expect(parseHeadFile("something unrelated\n")).toBeNull();
  });
});

describe("startHeadWatcher", () => {
  function makeRepo(initialBranch: string): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "rn-dev-head-watch-"));
    const git = (cmd: string) =>
      execSync(cmd, { cwd: dir, stdio: "pipe" });
    git(`git init -q -b ${initialBranch}`);
    git("git config user.email test@rn-dev.local");
    git("git config user.name rn-dev-test");
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    git("git add seed.txt");
    git('git commit -q -m "seed"');
    return {
      dir,
      cleanup: () => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      },
    };
  }

  it("no-ops on a non-git directory (currentBranch === null, stop is safe)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rn-dev-head-watch-nogit-"));
    try {
      const drifts: Array<[string | null, string | null]> = [];
      const w = await startHeadWatcher({
        worktree: dir,
        onDrift: (from, to) => drifts.push([from, to]),
      });
      expect(w.currentBranch()).toBeNull();
      w.stop();
      w.stop(); // idempotent
      expect(drifts).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fires onDrift when the checkout moves to a new branch", async () => {
    const { dir, cleanup } = makeRepo("feat/upload-center-diagnostics");
    try {
      const drifts: Array<[string | null, string | null]> = [];
      const w = await startHeadWatcher({
        worktree: dir,
        onDrift: (from, to) => drifts.push([from, to]),
        debounceMs: 20,
      });
      try {
        expect(w.currentBranch()).toBe("feat/upload-center-diagnostics");

        // Regression: bug 2026-08-20 — Agent B ran this exact shape of
        // command in Agent A's live-session worktree. Without the
        // watcher, Metro kept serving with zero signal to either client.
        execSync("git checkout -q -b fix/android-sent-images-white-rect", {
          cwd: dir,
          stdio: "pipe",
        });

        // Wait for debounce + watcher tick to fire.
        await new Promise((r) => setTimeout(r, 500));
        expect(drifts).toEqual([
          ["feat/upload-center-diagnostics", "fix/android-sent-images-white-rect"],
        ]);
        expect(w.currentBranch()).toBe(
          "fix/android-sent-images-white-rect",
        );
      } finally {
        w.stop();
      }
    } finally {
      cleanup();
    }
  });

  it("collapses the write burst of one checkout into one drift event", async () => {
    // A single `git checkout` writes .git/HEAD.lock, renames it over HEAD,
    // and updates a few adjacent refs — the FS watch fires several times.
    // We must observe exactly one drift call for one branch move, or the
    // "loud" warning becomes noise agents learn to ignore.
    const { dir, cleanup } = makeRepo("main");
    try {
      const drifts: Array<[string | null, string | null]> = [];
      const w = await startHeadWatcher({
        worktree: dir,
        onDrift: (from, to) => drifts.push([from, to]),
        debounceMs: 30,
      });
      try {
        execSync("git checkout -q -b other", { cwd: dir, stdio: "pipe" });
        await new Promise((r) => setTimeout(r, 300));
        expect(drifts).toHaveLength(1);
      } finally {
        w.stop();
      }
    } finally {
      cleanup();
    }
  });

  it("stop() detaches — no drift is delivered after stop", async () => {
    const { dir, cleanup } = makeRepo("main");
    try {
      const drifts: Array<[string | null, string | null]> = [];
      const w = await startHeadWatcher({
        worktree: dir,
        onDrift: (from, to) => drifts.push([from, to]),
        debounceMs: 20,
      });
      w.stop();
      execSync("git checkout -q -b other", { cwd: dir, stdio: "pipe" });
      await new Promise((r) => setTimeout(r, 200));
      expect(drifts).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
