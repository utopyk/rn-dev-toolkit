// Hook orphan sweep. Mirrors `src/daemon/orphan-sweep.ts` (modules) but
// keyed on hook subprocess pgid rather than module id, and gates on the
// recorded daemonPid rather than PPID.
//
// Mechanism:
//   1. Scan `~/.rn-dev/hooks/*.lock` lockfiles.
//   2. For each entry, the file basename is the hook's pgid; the JSON
//      payload includes `{ daemonPid, target, ts }`.
//   3. If `daemonPid` is alive → leave alone (its owner is still
//      driving the hook and will unlink the lockfile on exit).
//   4. If `daemonPid` is dead → `process.kill(-pgid, "SIGKILL")` to
//      reap the entire process group, then unlink the lockfile.
//
// Why this is simpler than the module sweep: hooks self-stamp their
// owning daemonPid into the lockfile, so we don't have to read another
// process's PPID via /proc or `ps`. Lockfile-content alone settles
// ownership.
//
// Platform: process-group kill is POSIX-only. On Windows the runner
// never writes a lockfile (see `runHookSubprocess`), so the sweep
// directory stays empty and `scanned === 0`.

import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { hookLockfilesRoot } from "../core/hooks/lockfile.js";

export interface HookSweepResult {
  scanned: number;
  killed: number;
  /** pgids of hook subprocesses whose lockfiles were unlinked as orphans. */
  cleared: number[];
}

export interface HookSweepOptions {
  /** Override the default `~/.rn-dev/hooks` root (tests). */
  hooksRoot?: string;
  /**
   * Log callback for operator visibility. Defaults to no-op; production
   * daemon wires this to stdout.
   */
  log?: (line: string) => void;
}

export function sweepOrphanHooks(opts: HookSweepOptions = {}): HookSweepResult {
  // Centralize root resolution in hookLockfilesRoot so the writer (in
  // runHookSubprocess) and the sweeper can never disagree on the
  // `RN_DEV_HOOKS_ROOT` precedence.
  const hooksRoot = hookLockfilesRoot(opts.hooksRoot);
  const log = opts.log ?? (() => {});

  if (!existsSync(hooksRoot)) {
    return { scanned: 0, killed: 0, cleared: [] };
  }

  let scanned = 0;
  let killed = 0;
  const cleared: number[] = [];

  const entries = readdirSync(hooksRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".lock")) continue;

    const pgid = Number(entry.name.slice(0, -".lock".length));
    if (!Number.isInteger(pgid) || pgid <= 0) {
      // Defense-in-depth: a tampered filename shouldn't trick us into
      // signaling pid 0 (every-process broadcast on POSIX) or negative
      // pids unrelated to our hook tree.
      continue;
    }
    scanned++;

    const lockPath = join(hooksRoot, entry.name);
    let daemonPid: number | null = null;
    let target = "(unknown)";
    try {
      const raw = readFileSync(lockPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        daemonPid?: number;
        target?: string;
      };
      if (typeof parsed.daemonPid === "number") daemonPid = parsed.daemonPid;
      if (typeof parsed.target === "string") target = parsed.target;
    } catch {
      // Corrupt lockfile — best-effort unlink + skip; we can't make a
      // signaling decision without the daemonPid.
      try {
        unlinkSync(lockPath);
      } catch {
        /* lockfile may be unlinked by a racing daemon */
      }
      continue;
    }
    if (daemonPid === null) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* best-effort */
      }
      continue;
    }
    // Owner still alive → leave alone; the runner's onExit will unlink.
    if (isPidAlive(daemonPid)) continue;

    // Orphan: the daemon that owned this fire is gone. Kill the
    // process group, then unlink the sentinel.
    try {
      process.kill(-pgid, "SIGKILL");
      killed++;
    } catch {
      try {
        process.kill(pgid, "SIGKILL");
        killed++;
      } catch {
        /* process may have exited between liveness check and kill */
      }
    }
    try {
      unlinkSync(lockPath);
      cleared.push(pgid);
    } catch {
      /* lockfile may be unlinked by a racing daemon */
    }
    log(
      `rn-dev daemon: orphan-swept hook pgid=${pgid} target=${target} (previous daemon ${daemonPid} crashed)`,
    );
  }

  return { scanned, killed, cleared };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}
