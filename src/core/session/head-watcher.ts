// HEAD watcher — surfaces `git checkout` swaps under a live session.
//
// Bug 2026-08-20 anatomy: two agents shared one checkout of the same
// project (~/Documents/GitHub/acme-mobile-app). Agent B ran
// `git checkout <branch>` while Agent A's Metro was serving that
// worktree; from Metro's perspective the file tree changed silently and
// hot-reload pushed the wrong bundle to Agent A's device. Neither side
// saw a signal until a type error surfaced ~10 minutes later. This
// module closes the gap: watch `.git/HEAD`, and on any change resolve
// the current branch and call `onDrift(from, to)`. The daemon turns
// that into a loud warn log fanned across live sessions.
//
// Cheap fs.watch on `.git/HEAD`. Debounced because a checkout writes
// HEAD.lock + renames + reflog updates in quick succession — one drift
// per checkout, not five.

import { promises as fs, watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";

export interface HeadWatcher {
  /** Current branch as last observed by the watcher, or null when unknown. */
  currentBranch(): string | null;
  /** Stop watching. Safe to call multiple times. */
  stop(): void;
}

export interface HeadWatcherOptions {
  /** Worktree root — the parent of the `.git` dir. */
  worktree: string;
  /** Called after every observed HEAD change; not called on the initial read. */
  onDrift: (from: string | null, to: string | null) => void;
  /** Debounce window in ms (default 200). */
  debounceMs?: number;
}

/**
 * Parse the content of `.git/HEAD`. Returns the branch name for a
 * symbolic ref (`ref: refs/heads/<branch>`), or null on detached HEAD /
 * malformed file. Detached HEAD isn't treated as a drift target — the
 * agent's failure mode was a branch swap, not a detach.
 */
export function parseHeadFile(content: string): string | null {
  const line = content.split("\n", 1)[0]?.trim() ?? "";
  const m = line.match(/^ref:\s*refs\/heads\/(.+)$/);
  return m ? m[1]! : null;
}

/**
 * Start watching `.git/HEAD` under `worktree`. When the file changes,
 * fire `onDrift(previous, current)` with the parsed branch names.
 * Silently no-ops when the directory isn't a git checkout (returns a
 * live watcher whose `currentBranch()` is null and whose `stop()` is a
 * no-op). Kept resilient so the daemon boot path never fails on a bare
 * scratch dir.
 */
export async function startHeadWatcher(
  opts: HeadWatcherOptions,
): Promise<HeadWatcher> {
  const gitDir = path.join(opts.worktree, ".git");
  const headPath = path.join(gitDir, "HEAD");
  const debounceMs = opts.debounceMs ?? 200;

  let current: string | null;
  try {
    current = parseHeadFile(await fs.readFile(headPath, "utf8"));
  } catch {
    // Not a git repo (or a submodule .git pointer file we don't support
    // yet). No-op watcher.
    return {
      currentBranch: () => null,
      stop: () => {},
    };
  }

  let stopped = false;
  let watcher: FSWatcher | null = null;
  let pending: NodeJS.Timeout | null = null;

  const check = async (): Promise<void> => {
    if (stopped) return;
    let next: string | null;
    try {
      next = parseHeadFile(await fs.readFile(headPath, "utf8"));
    } catch {
      // HEAD.lock rename race — read the stable file on the next tick.
      return;
    }
    if (next === current) return;
    const previous = current;
    current = next;
    opts.onDrift(previous, next);
  };

  const schedule = (): void => {
    if (stopped) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      void check();
    }, debounceMs);
  };

  try {
    // Watch the .git directory rather than the file itself: `git
    // checkout` writes HEAD.lock, then renames it over HEAD, which on
    // macOS/Linux invalidates a file-target fs.watch handle. The
    // directory watch survives that with a `filename === 'HEAD'`
    // filter.
    watcher = fsWatch(gitDir, { persistent: false }, (_evt, filename) => {
      if (filename !== "HEAD") return;
      schedule();
    });
    watcher.on("error", () => {
      // Best-effort watcher — swallow (e.g. ENOENT if the caller
      // deleted the worktree). The daemon still gets the loud signal
      // from the failure mode that triggered it.
    });
  } catch {
    // fsWatch not supported here → no-op watcher.
    return {
      currentBranch: () => current,
      stop: () => {},
    };
  }

  return {
    currentBranch: () => current,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (pending) clearTimeout(pending);
      pending = null;
      watcher?.close();
      watcher = null;
    },
  };
}
