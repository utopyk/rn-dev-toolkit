import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";

export interface LockHolderInput {
  pid: number;
  uid: number;
  /** Optional — path to a Unix-domain socket other processes can proxy to. */
  socketPath?: string;
}

export interface LockHolder extends LockHolderInput {
  acquiredAt: number;
}

export type LockAcquisition =
  | { kind: "acquired"; holder: LockHolder }
  | { kind: "held-by-other"; holder: LockHolder };

/**
 * On-disk advisory lock for `global`-scope module subprocesses.
 *
 * Semantics:
 *   - `acquire(input)` writes a JSON payload {pid,uid,acquiredAt,socketPath?}
 *     to the lockfile path. If a lockfile exists, we:
 *       - parse it, then
 *       - check whether the holding PID is still alive (`kill(pid, 0)`);
 *       - if alive → return `{kind:'held-by-other'}` with that holder;
 *       - if dead or corrupt → treat as stale, overwrite, return `{kind:'acquired'}`.
 *   - `release()` removes the lockfile if we are the current live holder;
 *     refuses (returns false) if another live process holds it.
 *   - `peek()` returns the live holder or null (treats stale/corrupt as null).
 *
 * No in-memory "I own this" flag — `release()` decides from disk state each
 * time. Simpler, and robust to crashes that leave the in-memory flag stale.
 */
export class ModuleLockfile {
  constructor(private readonly path: string) {}

  acquire(input: LockHolderInput): LockAcquisition {
    const existing = this.readLive();
    if (existing) {
      return { kind: "held-by-other", holder: existing };
    }

    const holder: LockHolder = {
      pid: input.pid,
      uid: input.uid,
      acquiredAt: Date.now(),
      ...(input.socketPath !== undefined && { socketPath: input.socketPath }),
    };

    // Ensure parent dir exists.
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* ignore — writeFileSync will surface a useful error if truly broken */
    }

    writeFileSync(this.path, JSON.stringify(holder), "utf-8");
    return { kind: "acquired", holder };
  }

  release(): boolean {
    if (!existsSync(this.path)) return false;
    const live = this.readLive();
    // If someone else holds a live lock here, refuse to delete.
    if (live && live.pid !== process.pid) {
      return false;
    }
    try {
      unlinkSync(this.path);
      return true;
    } catch {
      return false;
    }
  }

  peek(): LockHolder | null {
    return this.readLive();
  }

  /** Read the lockfile and return holder only if the PID is alive. */
  private readLive(): LockHolder | null {
    if (!existsSync(this.path)) return null;

    let raw: string;
    try {
      raw = readFileSync(this.path, "utf-8");
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    if (!isHolderShape(parsed)) return null;

    if (!isPidAlive(parsed.pid)) return null;

    return parsed;
  }
}

function isHolderShape(value: unknown): value is LockHolder {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pid === "number" &&
    typeof v.uid === "number" &&
    typeof v.acquiredAt === "number"
  );
}

/**
 * `kill(pid, 0)` is the POSIX idiom for "does this PID exist without
 * actually signaling it". Throws ESRCH when the process is gone.
 *
 * On Windows this is less reliable; v1 is POSIX-only — Windows falls back
 * to treating any parseable lockfile as live (documented in the Phase 2
 * handoff).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = exists but we lack permission to signal — still alive.
    if (code === "EPERM") return true;
    return false;
  }
}
