// Startup orphan sweep. When a previous daemon crashed without
// `ModuleHostManager.shutdownAll()`, its spawned module subprocesses
// inherit PPID=1 (init) and keep running with a stale lockfile pointing
// at them. A fresh daemon on boot must kill them so the next acquire()
// starts a clean subprocess instead of re-attaching to an orphan.
//
// Mechanism:
//   1. Scan `~/.rn-dev/modules/<id>/.lock` lockfiles.
//   2. For each entry, read the recorded pid.
//   3. Probe liveness (`kill(pid, 0)`). Dead → skip; ModuleLockfile will
//      treat the entry as stale at next acquire().
//   4. Alive → read the process's current parent pid. PPID=1 means the
//      original parent died and init reaped the module — this is an
//      orphan. Kill the process group and unlink the lockfile.
//   5. PPID != 1 → leave alone; another live daemon still owns it
//      (shared `global`-scope module).
//
// Platform notes:
//   - Linux: read /proc/<pid>/stat (field 4 is PPID).
//   - macOS: `ps -o ppid= -p <pid>` (pipe-safe scalar output).
//   - Windows: not supported in v1 (same posture as the rest of
//     module-host — detached process groups are POSIX-only).
//
// Complementary to PR_SET_PDEATHSIG on Linux (next daemon cycle) and to
// process-group kill in ModuleHostManager on graceful shutdown (current
// daemon). See docs/plans/2026-04-24-next-session-prompt-phase-13-2.md
// §"Orphan module subprocess mitigations".

import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { join } from "node:path";

export interface SweepResult {
  scanned: number;
  killed: number;
  /** IDs of modules whose lockfiles were unlinked as orphans. */
  cleared: string[];
}

export interface SweepOptions {
  /** Override the default `~/.rn-dev/modules` root (tests). */
  modulesRoot?: string;
  /**
   * Log callback for operator visibility. Defaults to no-op; production
   * daemon wires this to stdout.
   */
  log?: (line: string) => void;
}

export function sweepOrphanModules(opts: SweepOptions = {}): SweepResult {
  const modulesRoot = opts.modulesRoot ?? join(homedir(), ".rn-dev", "modules");
  const log = opts.log ?? (() => {});

  if (!existsSync(modulesRoot)) {
    return { scanned: 0, killed: 0, cleared: [] };
  }

  let scanned = 0;
  let killed = 0;
  const cleared: string[] = [];

  const entries = readdirSync(modulesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const moduleId = entry.name;
    const lockPath = join(modulesRoot, moduleId, ".lock");
    if (!existsSync(lockPath)) continue;
    scanned++;

    let pid: number | null = null;
    try {
      const raw = readFileSync(lockPath, "utf-8");
      const parsed = JSON.parse(raw) as { pid?: number };
      if (typeof parsed.pid === "number") pid = parsed.pid;
    } catch {
      continue;
    }
    if (pid === null) continue;
    if (!isPidAlive(pid)) continue;

    const ppid = readParentPid(pid);
    // PPID=1 → original parent died and init reaped. Anything else → a
    // living daemon still owns this. Skip in both ambiguous cases
    // (couldn't read PPID, or PPID != 1).
    if (ppid !== 1) continue;

    try {
      process.kill(-pid, "SIGKILL");
      killed++;
    } catch {
      try {
        process.kill(pid, "SIGKILL");
        killed++;
      } catch {
        /* process may have exited between liveness check and kill */
      }
    }
    try {
      unlinkSync(lockPath);
      cleared.push(moduleId);
    } catch {
      /* lockfile may be unlinked by a racing daemon */
    }
    log(
      `rn-dev daemon: orphan-swept module ${moduleId} (pid=${pid}) — previous daemon crashed`,
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

function readParentPid(pid: number): number | null {
  if (process.platform === "linux") {
    const statPath = `/proc/${pid}/stat`;
    try {
      const raw = readFileSync(statPath, "utf-8");
      // Format: `pid (comm) state ppid ...` but (comm) may contain spaces
      // and parens. Slice past the LAST ')' and split the remainder.
      const lastParen = raw.lastIndexOf(")");
      if (lastParen < 0) return null;
      const fields = raw.slice(lastParen + 2).split(" ");
      // After the `)`, field[0] = state, field[1] = ppid.
      const ppid = Number(fields[1]);
      return Number.isFinite(ppid) ? ppid : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const out = execSync(`ps -o ppid= -p ${pid}`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const ppid = Number(out);
      return Number.isFinite(ppid) ? ppid : null;
    } catch {
      return null;
    }
  }
  return null;
}
