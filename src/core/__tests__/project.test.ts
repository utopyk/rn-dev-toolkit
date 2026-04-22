import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import {
  detectProjectRoot,
  isGitRepo,
  getCurrentBranch,
  getWorktrees,
  getRnVersion,
} from "../project.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rn-dev-cli-project-"));
}

function writePackageJson(dir: string, content: object): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify(content, null, 2));
}

// ---------------------------------------------------------------------------
// detectProjectRoot
// ---------------------------------------------------------------------------

describe("detectProjectRoot", () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpDir();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the directory itself when package.json has react-native in dependencies", () => {
    writePackageJson(root, {
      name: "my-rn-app",
      dependencies: { "react-native": "0.73.0" },
    });

    const result = detectProjectRoot(root);
    expect(result).toBe(root);
  });

  it("returns the directory when react-native is in devDependencies", () => {
    writePackageJson(root, {
      name: "my-rn-app",
      devDependencies: { "react-native": "0.73.0" },
    });

    const result = detectProjectRoot(root);
    expect(result).toBe(root);
  });

  it("walks up to find the project root from a nested directory", () => {
    writePackageJson(root, {
      name: "my-rn-app",
      dependencies: { "react-native": "0.73.0" },
    });

    const nested = join(root, "src", "screens", "Home");
    mkdirSync(nested, { recursive: true });

    const result = detectProjectRoot(nested);
    expect(result).toBe(root);
  });

  it("returns null when no package.json with react-native is found", () => {
    // root has a package.json but without react-native
    writePackageJson(root, {
      name: "plain-node-app",
      dependencies: { express: "4.0.0" },
    });

    const result = detectProjectRoot(root);
    expect(result).toBeNull();
  });

  it("returns null when there is no package.json at all", () => {
    // Completely empty temp dir
    const emptyDir = makeTmpDir();
    try {
      const result = detectProjectRoot(emptyDir);
      expect(result).toBeNull();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("returns null when package.json exists but has neither dependencies nor devDependencies", () => {
    writePackageJson(root, { name: "bare-package" });

    const result = detectProjectRoot(root);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isGitRepo
// ---------------------------------------------------------------------------

describe("isGitRepo", () => {
  it("returns true for the current project directory (which is a git repo)", async () => {
    // The rn-dev-cli project itself is a git repo
    const result = await isGitRepo(process.cwd());
    expect(result).toBe(true);
  });

  it("returns false for a plain temp directory (not a git repo)", async () => {
    const tmpDir = makeTmpDir();
    try {
      const result = await isGitRepo(tmpDir);
      expect(result).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns true for a subdirectory inside a git repo", async () => {
    // node_modules itself is inside the git repo
    const subDir = join(process.cwd(), "src", "core");
    const result = await isGitRepo(subDir);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getCurrentBranch
// ---------------------------------------------------------------------------

describe("getCurrentBranch", () => {
  it("returns a non-empty string for the current project (which is on a branch)", async () => {
    const branch = await getCurrentBranch(process.cwd());
    expect(typeof branch).toBe("string");
    expect(branch!.length).toBeGreaterThan(0);
  });

  it("returns null for a directory that is not a git repo", async () => {
    const tmpDir = makeTmpDir();
    try {
      const branch = await getCurrentBranch(tmpDir);
      expect(branch).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// getWorktrees
// ---------------------------------------------------------------------------

describe("getWorktrees", () => {
  it("returns an array with at least one entry for the current project", async () => {
    const worktrees = await getWorktrees(process.cwd());
    expect(Array.isArray(worktrees)).toBe(true);
    expect(worktrees.length).toBeGreaterThan(0);
  });

  it("each worktree entry has path, branch, and isMain fields", async () => {
    const worktrees = await getWorktrees(process.cwd());
    for (const wt of worktrees) {
      expect(typeof wt.path).toBe("string");
      expect(typeof wt.branch).toBe("string");
      expect(typeof wt.isMain).toBe("boolean");
    }
  });

  it("marks exactly one worktree as main", async () => {
    const worktrees = await getWorktrees(process.cwd());
    const mainWorktrees = worktrees.filter((wt) => wt.isMain);
    expect(mainWorktrees).toHaveLength(1);
  });

  it("returns empty array for non-git directory", async () => {
    const tmpDir = makeTmpDir();
    try {
      const worktrees = await getWorktrees(tmpDir);
      expect(worktrees).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// getRnVersion
// ---------------------------------------------------------------------------

describe("getRnVersion", () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpDir();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the react-native version from dependencies", () => {
    writePackageJson(root, {
      name: "my-app",
      dependencies: { "react-native": "0.73.4" },
    });

    const version = getRnVersion(root);
    expect(version).toBe("0.73.4");
  });

  it("returns the react-native version from devDependencies", () => {
    writePackageJson(root, {
      name: "my-app",
      devDependencies: { "react-native": "0.72.0" },
    });

    const version = getRnVersion(root);
    expect(version).toBe("0.72.0");
  });

  it("prefers dependencies over devDependencies", () => {
    writePackageJson(root, {
      name: "my-app",
      dependencies: { "react-native": "0.73.0" },
      devDependencies: { "react-native": "0.72.0" },
    });

    const version = getRnVersion(root);
    expect(version).toBe("0.73.0");
  });

  it("returns null when react-native is not listed", () => {
    writePackageJson(root, {
      name: "my-app",
      dependencies: { express: "4.0.0" },
    });

    const version = getRnVersion(root);
    expect(version).toBeNull();
  });

  it("returns null when package.json does not exist", () => {
    const emptyDir = makeTmpDir();
    try {
      const version = getRnVersion(emptyDir);
      expect(version).toBeNull();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
