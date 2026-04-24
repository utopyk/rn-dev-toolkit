// HMAC-chained append-only audit log for privileged host actions.
//
// Writes to `~/.rn-dev/audit.log` (NDJSON — one JSON entry per line).
// Each entry carries an HMAC-SHA256 chain: `hash = HMAC(key, canonical(entry
// without hash) + prevHash)`. Tampering any prior entry invalidates every
// entry after it.
//
// Threat model:
//   - **In scope:** post-hoc tamper detection. If an attacker (or a bug)
//     rewrites a middle line, `verify()` reports the first broken entry.
//   - **Out of scope:** preventing a local attacker with read access from
//     forging a fresh log. The HMAC key lives at `~/.rn-dev/audit.key`
//     (mode 600); a process running as the user can read it. That's
//     fine — this is a compliance/breadcrumb log, not a capabilities
//     boundary. The sandboxing story is curated registry + subprocess
//     isolation + consent UI (unchanged from Phase 6).
//
// Concurrency: two levels.
//   - In-process: `appendFileSync` is a blocking syscall, so synchronous
//     callers on the same tick can't interleave — the earlier call's
//     lastHash/seq updates complete before the later call reads them.
//   - Cross-process (Phase 13 multi-daemon): before each append the
//     writer acquires an O_EXCL lockfile at `<audit.log>.lock`, re-reads
//     the tail under the lock, builds the entry, appends, and unlinks
//     the lock. Two daemons writing concurrently serialize via the
//     lockfile instead of corrupting the HMAC chain by both reading
//     the same tail. Stale locks (crashed writer) expire after
//     `LOCK_STALE_MS` and are force-reclaimed.
//
// Rotation: when the active log exceeds `rotateBytes` (default 10MB), the
// NEXT append rotates. Rotation shifts files up the numbered suffix:
//   audit.log.2 → audit.log.3
//   audit.log.1 → audit.log.2
//   audit.log   → audit.log.1
// Retention is bounded by `rotateKeep` (default 3) so a chatty daemon
// doesn't fill the disk; the oldest file is deleted when the shift would
// otherwise create a new suffix past the limit. Fresh `audit.log` starts
// with the rotated tail's hash as `prevHash`, so the chain continues
// across rotation boundaries — `verify()` walks the pair by feeding the
// `audit.log.1` tail hash into the `audit.log` head verification.

import { createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { canonicalize, AuditCanonicalizationError } from "./canonicalize.js";

// Re-export so downstream importers that catch `AuditCanonicalizationError`
// by reaching into this module keep working. Phase 11 Simplicity P2.
export { AuditCanonicalizationError };

export type AuditOutcome = "ok" | "error" | "denied";

/**
 * Discriminated union over `kind` so every subsystem's audit payload is
 * typed at the call site and exhaustively handled by `formatAuditEntry`
 * + post-mortem tools. Satisfies the project rule "no `Record<string,
 * unknown>` in production" — each kind's extra fields are declared
 * explicitly. New subsystems add a variant here; canonicalization +
 * HMAC are structure-agnostic and keep working.
 */
export type AuditEntryInput =
  | AuditInstallInput
  | AuditUninstallInput
  | AuditHostCallInput
  | AuditConfigSetInput
  | AuditPanelBridgeInput;

export interface AuditInstallInput {
  kind: "install";
  /** 3p module id from the curated registry. */
  moduleId: string;
  outcome: AuditOutcome;
  code?: string;
  /** Version from the installed manifest — absent on error paths. */
  version?: string;
}

export interface AuditUninstallInput {
  kind: "uninstall";
  moduleId: string;
  outcome: AuditOutcome;
  code?: string;
}

export interface AuditHostCallInput {
  kind: "host-call";
  moduleId: string;
  outcome: AuditOutcome;
  /** Capability id resolved via `host.capability<T>(id)`. */
  capabilityId: string;
  method: string;
}

export interface AuditConfigSetInput {
  kind: "config-set";
  moduleId: string;
  outcome: AuditOutcome;
  code?: string;
  /** Worktree key or `"global"`; omitted for the default. */
  scopeUnit?: string;
  /** Keys from the patch object — never values (config may be sensitive). */
  patchKeys: string[];
}

export interface AuditPanelBridgeInput {
  kind: "panel-bridge";
  moduleId: string;
  outcome: AuditOutcome;
  /** `"register"` / `"unregister"` / `"show"` / `"hide"`. */
  action: string;
  panelId: string;
}

export type AuditEntry = AuditEntryInput & {
  /** Epoch ms — `Date.now()` at append time. */
  ts: number;
  /** Monotonic sequence number within the active file. Reset on rotation. */
  seq: number;
  /** Previous entry's `hash`; `""` for the first entry of a fresh file. */
  prevHash: string;
  /** HMAC-SHA256(key, canonical(entry without hash) + prevHash). Hex. */
  hash: string;
};

export interface AuditLogOptions {
  /** Override the log file path. Defaults to `~/.rn-dev/audit.log`. */
  path?: string;
  /** Override the key file path. Defaults to `~/.rn-dev/audit.key`. */
  keyPath?: string;
  /**
   * Supply a key directly (tests). When omitted, read or generate a key
   * at `keyPath`. A provided key bypasses all filesystem key handling.
   */
  key?: Buffer;
  /** Size in bytes that triggers rotation. Defaults to 10 MiB. */
  rotateBytes?: number;
  /**
   * Number of rotated-file generations to retain. The active
   * `audit.log` plus `audit.log.1` ... `audit.log.N` are kept; files
   * older than `audit.log.N` are deleted on rotation. Defaults to 3.
   * Operators wanting long-term retention should archive to a
   * dedicated pipeline on each rotation (e.g. a syslog bridge
   * subscribing to `rotated`).
   */
  rotateKeep?: number;
  /** Clock override (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export class AuditLog extends EventEmitter {
  private readonly path: string;
  private readonly keyPath: string;
  private readonly rotateBytes: number;
  private readonly rotateKeep: number;
  private readonly now: () => number;
  private key: Buffer | null = null;
  private seq = 0;
  private lastHash = "";
  private initialized = false;
  /**
   * File size we last observed the active log to be. Cross-process
   * writers bump the real size past this value; matching size → nobody
   * else wrote since we did → cached lastHash/seq are still valid and
   * we can skip re-reading the tail. Keeps the same-process append
   * path O(1) even with the lockfile wrapper around it.
   */
  private lastObservedSize = 0;

  constructor(opts: AuditLogOptions = {}) {
    super();
    this.path = opts.path ?? defaultLogPath();
    this.keyPath = opts.keyPath ?? defaultKeyPath();
    this.rotateBytes = opts.rotateBytes ?? 10 * 1024 * 1024;
    this.rotateKeep = opts.rotateKeep ?? 3;
    this.now = opts.now ?? (() => Date.now());
    if (opts.key) this.key = opts.key;
  }

  /**
   * Append an entry. Emits `"appended"` with the full entry (including
   * `hash`) so listeners (e.g. the Electron service-log mirror) can
   * react without re-reading the file.
   *
   * Cross-process serialization: the critical section runs under an
   * O_EXCL lockfile at `<path>.lock`. Under the lock we re-read the
   * tail hash + seq from disk — another writer may have appended
   * since we last cached them — then build, append, unlink lock.
   * `appendFileSync` itself is blocking so in-process concurrency is
   * already serialized by Node's event loop.
   *
   * Emits `append-failed` on write error so the Electron service-log
   * mirror can surface the failure; the audit record is dropped on
   * error but the emitter keeps UI visibility intact.
   */
  async append(input: AuditEntryInput): Promise<AuditEntry> {
    this.ensureInitialized();
    return withAuditLock(this.lockPath(), () => {
      // Another process may have appended since we last read — rebase
      // on the current tail before building our entry so the HMAC
      // chain stays unbroken.
      this.refreshTailState();
      // Rotate BEFORE building so the new entry's `seq` reflects the
      // fresh file (reset to 1) instead of continuing the pre-rotation
      // counter. The chain (prevHash) continues across rotation; seq
      // resets per-file so operators can locate entries within a
      // single log.
      this.rotateIfNeeded();
      const entry = this.buildEntry(input);
      try {
        appendFileSync(this.path, JSON.stringify(entry) + "\n", { mode: 0o600 });
      } catch (err) {
        this.emit("append-failed", { entry, error: err });
        throw err;
      }
      this.lastHash = entry.hash;
      this.seq = entry.seq;
      // Cache the new size so the next same-process append skips the
      // tail re-read. Out of line with the actual append rather than
      // stat()ing because the canonical JSON is exactly what we wrote.
      try {
        this.lastObservedSize = statSync(this.path).size;
      } catch {
        this.lastObservedSize = 0;
      }
      this.emit("appended", entry);
      return entry;
    });
  }

  /** Lock file path — one per audit log file, next to the log itself. */
  private lockPath(): string {
    return `${this.path}.lock`;
  }

  /**
   * Re-read the active file's tail so `lastHash`/`seq` reflect the
   * state another daemon may have written since our cached values were
   * captured. Called under the append lock.
   *
   * Fast path: if the file size matches what we last observed, nobody
   * else has appended and the cached state is still current. Skipping
   * the re-read keeps the common same-process-sequential append path
   * O(1); cross-process contention pays the tail-read cost only when
   * it actually happens.
   */
  private refreshTailState(): void {
    const curSize = existsSync(this.path) ? statSync(this.path).size : 0;
    if (curSize === this.lastObservedSize) return;
    if (curSize === 0) {
      this.lastHash = "";
      this.seq = 0;
      this.lastObservedSize = 0;
      return;
    }
    const raw = readFileSync(this.path, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const last = lines[lines.length - 1];
    if (!last) {
      this.lastHash = "";
      this.seq = 0;
      this.lastObservedSize = curSize;
      return;
    }
    try {
      const entry = JSON.parse(last) as AuditEntry;
      this.lastHash = entry.hash;
      this.seq = entry.seq;
    } catch {
      /* keep existing in-memory values — verify() will flag the gap */
    }
    this.lastObservedSize = curSize;
  }

  /**
   * Read the entire log and verify the HMAC chain. Returns `{ ok: true }`
   * if every entry verifies + the chain is unbroken, otherwise
   * `{ ok: false, failedAt: seq }`. Used by tests + post-mortem tools.
   *
   * Paired rotation files: call `verify({ tailHash })` on the fresh log
   * with the `tailHash` from the rotated file's verification to continue
   * the chain.
   *
   * Streams line-by-line via `createReadStream` + `readline` so memory
   * stays bounded even on multi-hundred-MB logs (Phase 8 review flagged
   * the whole-file read as a DoS risk on a long-running daemon). The
   * return shape is unchanged — callers just `await` now.
   */
  async verify(options: { tailHash?: string } = {}): Promise<VerifyResult> {
    this.ensureInitialized();
    if (!existsSync(this.path)) {
      return { ok: true, entriesRead: 0, tailHash: options.tailHash ?? "" };
    }

    let prevHash = options.tailHash ?? "";
    let entriesRead = 0;

    const stream = createReadStream(this.path, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (line.length === 0) continue;
        let entry: AuditEntry;
        try {
          entry = JSON.parse(line) as AuditEntry;
        } catch {
          return { ok: false, failedAt: entriesRead, reason: "invalid JSON" };
        }
        if (entry.prevHash !== prevHash) {
          return {
            ok: false,
            failedAt: entry.seq,
            reason: `prevHash mismatch (expected "${prevHash}", got "${entry.prevHash}")`,
          };
        }
        // Canonicalize the entry WITHOUT its own `hash` field — otherwise
        // the HMAC includes its own output and verify can never match
        // append's computation. `Omit<AuditEntry, "hash">` is a type-level
        // hint, not a runtime strip; destructure explicitly.
        const { hash: _stored, ...withoutHash } = entry;
        const expectedHash = this.computeHash(withoutHash, entry.prevHash);
        if (entry.hash !== expectedHash) {
          return {
            ok: false,
            failedAt: entry.seq,
            reason: "hash mismatch — entry has been tampered",
          };
        }
        prevHash = entry.hash;
        entriesRead++;
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    return { ok: true, entriesRead, tailHash: prevHash };
  }

  /** Active file size. Public so callers can introspect rotation state. */
  currentBytes(): number {
    if (!existsSync(this.path)) return 0;
    return statSync(this.path).size;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (this.initialized) return;
    if (!this.key) {
      this.key = loadOrGenerateKey(this.keyPath);
    }
    // Resume from existing log: read tail hash + seq so appends continue
    // the chain instead of restarting it.
    if (existsSync(this.path)) {
      const raw = readFileSync(this.path, "utf-8");
      const lines = raw.split("\n").filter((l) => l.length > 0);
      const last = lines[lines.length - 1];
      if (last) {
        try {
          const entry = JSON.parse(last) as AuditEntry;
          this.lastHash = entry.hash;
          this.seq = entry.seq;
        } catch {
          // Tail line is garbage; chain continues from empty — `verify()`
          // will flag the gap but append keeps working.
        }
      }
      try {
        this.lastObservedSize = statSync(this.path).size;
      } catch {
        this.lastObservedSize = 0;
      }
    }
    this.initialized = true;
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.path)) return;
    const size = statSync(this.path).size;
    if (size < this.rotateBytes) return;
    // Shift generations up one slot: .(keep-1) → .keep, ... .1 → .2.
    // The file currently at .keep would shift off the end of the kept
    // window, so drop it instead. Active → .1 after the shift.
    for (let i = this.rotateKeep; i >= 1; i--) {
      const from = `${this.path}.${i}`;
      if (!existsSync(from)) continue;
      try {
        if (i === this.rotateKeep) {
          // Past the retention limit — delete rather than rename.
          rmSync(from, { force: true });
        } else {
          renameSync(from, `${this.path}.${i + 1}`);
        }
      } catch {
        /* best-effort — rotation should never block an append */
      }
    }
    renameSync(this.path, `${this.path}.1`);
    this.emit("rotated", { active: this.path, rotatedTo: `${this.path}.1` });
    // Next append starts fresh — `lastHash` carries across so the chain
    // continues. Seq resets per-file so operators can locate entries
    // within the active log. The active file is empty post-rotation, so
    // reset `lastObservedSize` too; without this, the next append's
    // size-equality check would incorrectly skip the tail refresh.
    this.seq = 0;
    this.lastObservedSize = 0;
  }

  private buildEntry(input: AuditEntryInput): AuditEntry {
    // Spread the input verbatim so each discriminated-union variant's
    // extra fields (version, capabilityId, method, scopeUnit, patchKeys,
    // action, panelId) land on the entry. Canonicalization sorts keys
    // so the field order of the spread doesn't affect the HMAC.
    const base = {
      ...input,
      ts: this.now(),
      seq: this.seq + 1,
      prevHash: this.lastHash,
    } as Omit<AuditEntry, "hash">;
    const hash = this.computeHash(base, base.prevHash);
    return { ...base, hash } as AuditEntry;
  }

  private computeHash(entry: Omit<AuditEntry, "hash">, prevHash: string): string {
    if (!this.key) {
      throw new Error("AuditLog: key not initialized");
    }
    const canonical = canonicalize(entry);
    return createHmac("sha256", this.key)
      .update(canonical)
      .update(prevHash)
      .digest("hex");
  }
}

export interface VerifyResult {
  ok: boolean;
  /** Count of entries that verified successfully before any failure. */
  entriesRead?: number;
  /** On failure, the `seq` of the first bad entry. */
  failedAt?: number;
  /** Human-readable failure reason. */
  reason?: string;
  /** Last good entry's hash — feed into the paired file's `verify({tailHash})`. */
  tailHash?: string;
}

// ---------------------------------------------------------------------------
// Module-scoped default instance
// ---------------------------------------------------------------------------

let cachedDefault: AuditLog | null = null;

/**
 * Lazy-initialized default instance rooted at `~/.rn-dev/audit.log`.
 * Use this from Electron/daemon glue code. Tests construct their own
 * `AuditLog` with overridden paths + keys.
 */
export function getDefaultAuditLog(): AuditLog {
  if (!cachedDefault) cachedDefault = new AuditLog();
  return cachedDefault;
}

/** Reset the default instance (tests only). */
export function resetDefaultAuditLogForTests(): void {
  cachedDefault = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultLogPath(): string {
  return join(homedir(), ".rn-dev", "audit.log");
}

function defaultKeyPath(): string {
  return join(homedir(), ".rn-dev", "audit.key");
}

function loadOrGenerateKey(keyPath: string): Buffer {
  if (existsSync(keyPath)) {
    const bytes = readFileSync(keyPath);
    if (bytes.length < 32) {
      // Too-short key — regenerate rather than accept a weak HMAC.
      return generateKey(keyPath);
    }
    return bytes;
  }
  return generateKey(keyPath);
}

function generateKey(keyPath: string): Buffer {
  mkdirSync(dirname(keyPath), { recursive: true });
  const key = randomBytes(64);
  writeFileSync(keyPath, key, { mode: 0o600 });
  // writeFileSync's mode is advisory on some platforms (umask can widen).
  // chmod explicitly to be sure.
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* best-effort */
  }
  return key;
}

// Phase 11 Simplicity P2 — `canonicalize` + `AuditCanonicalizationError`
// moved to `./canonicalize.js` as a pure helper. The `AuditCanonicalizationError`
// re-export above preserves the public API; tests that used to reach for
// `_canonicalizeForTests` now import `canonicalize` directly from the new
// module (the test-only re-export smell is gone).

// ---------------------------------------------------------------------------
// Cross-process lockfile (Phase 13.2)
// ---------------------------------------------------------------------------

const LOCK_POLL_MS = 10;
const LOCK_MAX_ATTEMPTS = 300; // ~3s total before we treat the attempt as failed

/**
 * Acquire an O_EXCL lockfile, write our pid into it, run `fn`, release.
 *
 * Stale-lock reclaim: the holder's pid is read from the lockfile body
 * and probed with `kill(pid, 0)`. Only if the holder is actually dead
 * do we unlink and retake. An mtime-threshold-based reclaim (which the
 * first draft used) is unsafe — a slow writer on NFS or a writer
 * traversing a large file under the lock can exceed any threshold
 * without being stuck, and concurrent reclaim creates two writers
 * reading the same tail and corrupting the HMAC chain. Security
 * reviewer P1 on this was the blocker.
 */
async function withAuditLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    let fd: number;
    try {
      fd = openSync(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Read the holder's pid and check liveness. Only a dead holder
      // gets reclaimed; a live (possibly slow) holder makes us wait.
      const holder = readLockHolder(lockPath);
      if (holder === null || isPidDead(holder)) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* race with another reclaimer — fall through to backoff */
        }
        continue;
      }
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
      continue;
    }

    // Record our pid so another writer can probe it if we crash.
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 });
    } catch {
      /* best-effort — if the write fails, reclaim-by-pid falls back to
         the "holder === null" path which unlinks as stale */
    }
    try {
      return await fn();
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* best-effort — may have been reclaimed by a stale sweep */
      }
    }
  }
  throw new Error(
    `AuditLog: timed out acquiring lock at ${lockPath} after ${LOCK_MAX_ATTEMPTS * LOCK_POLL_MS}ms`,
  );
}

function readLockHolder(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, "utf-8").trim();
    if (!raw) return null;
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = exists but we lack permission to signal — treat as alive.
    if (code === "EPERM") return false;
    return true;
  }
}
