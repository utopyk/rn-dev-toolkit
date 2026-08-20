import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { execAsync } from "./exec-async.js";

// ---------------------------------------------------------------------------
// detectProjectRoot
// ---------------------------------------------------------------------------

/**
 * Walk up from `fromDir` looking for a package.json that lists react-native
 * in `dependencies` or `devDependencies`. Returns the directory containing
 * the matching package.json, or null if none is found.
 */
export function detectProjectRoot(fromDir: string): string | null {
  let current = fromDir;

  while (true) {
    const pkgPath = join(current, "package.json");

    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };

        const inDeps = pkg.dependencies?.["react-native"] !== undefined;
        const inDevDeps = pkg.devDependencies?.["react-native"] !== undefined;

        if (inDeps || inDevDeps) {
          return current;
        }
      } catch {
        // malformed package.json – keep walking up
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root
      return null;
    }
    current = parent;
  }
}

// ---------------------------------------------------------------------------
// isGitRepo
// ---------------------------------------------------------------------------

/**
 * Returns true if `dir` is inside a git repository (uses
 * `git rev-parse --is-inside-work-tree`).
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const result = await execAsync("git rev-parse --is-inside-work-tree", {
      cwd: dir,
      timeout: 15000,
    });
    return result.trim() === "true";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// getCurrentBranch
// ---------------------------------------------------------------------------

/**
 * Returns the current git branch name, or null if not in a git repo or in
 * a detached HEAD state.
 */
export async function getCurrentBranch(dir: string): Promise<string | null> {
  try {
    const result = await execAsync("git rev-parse --abbrev-ref HEAD", {
      cwd: dir,
      timeout: 15000,
    });
    const branch = result.trim();

    // "HEAD" is returned for detached HEAD state
    return branch.length > 0 && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// getHeadSha
// ---------------------------------------------------------------------------

/**
 * Returns the short (7-char) HEAD commit SHA, or null when the directory
 * isn't a git repo. Cheap on every filesystem — safe to call on the hot
 * path of `sessions/list`.
 */
export async function getHeadSha(dir: string): Promise<string | null> {
  try {
    const result = await execAsync("git rev-parse --short HEAD", {
      cwd: dir,
      timeout: 15000,
    });
    const sha = result.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// getWorktrees
// ---------------------------------------------------------------------------

interface Worktree {
  path: string;
  branch: string;
  isMain: boolean;
}

/**
 * Parse `git worktree list --porcelain` output and return a structured list
 * of worktrees. Returns an empty array if not in a git repo.
 */
export async function getWorktrees(dir: string): Promise<Worktree[]> {
  try {
    const output = await execAsync("git worktree list --porcelain", {
      cwd: dir,
      timeout: 15000,
    });

    const worktrees: Worktree[] = [];
    let current: Partial<Worktree> = {};
    let isFirst = true;

    for (const rawLine of output.split("\n")) {
      const line = rawLine.trim();

      if (line === "") {
        // Blank line separates worktree blocks
        if (current.path !== undefined) {
          worktrees.push({
            path: current.path,
            branch: current.branch ?? "(detached)",
            isMain: current.isMain ?? false,
          });
          current = {};
          isFirst = false;
        }
        continue;
      }

      if (line.startsWith("worktree ")) {
        current.path = line.slice("worktree ".length);
        // The first worktree in the list is always the main one
        current.isMain = isFirst;
      } else if (line.startsWith("branch ")) {
        // branch refs/heads/main  →  main
        const ref = line.slice("branch ".length);
        current.branch = ref.replace(/^refs\/heads\//, "");
      } else if (line === "bare") {
        current.branch = "(bare)";
      }
      // We intentionally ignore the "HEAD <sha>" and "locked"/"prunable" lines
    }

    // Handle trailing block without trailing blank line
    if (current.path !== undefined) {
      worktrees.push({
        path: current.path,
        branch: current.branch ?? "(detached)",
        isMain: current.isMain ?? false,
      });
    }

    return worktrees;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// getRnVersion
// ---------------------------------------------------------------------------

/**
 * Read the react-native version from the package.json at `projectRoot`.
 * Checks `dependencies` first, then `devDependencies`.
 * Returns null if not found or the file doesn't exist.
 */
export function getRnVersion(projectRoot: string): string | null {
  const pkgPath = join(projectRoot, "package.json");

  if (!existsSync(pkgPath)) {
    return null;
  }

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    return (
      pkg.dependencies?.["react-native"] ??
      pkg.devDependencies?.["react-native"] ??
      null
    );
  } catch {
    return null;
  }
}
