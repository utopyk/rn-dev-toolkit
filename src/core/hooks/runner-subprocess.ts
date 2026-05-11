// JSON-line subprocess runner for hook scripts. Lives between the
// dispatcher and `node:child_process` — composes the spawn primitives
// from `../spawn-utils` with the hook protocol (stdin = JSON payload,
// stdout = JSON-line records, stderr = rate-limited log).
//
// Contracts the dispatcher relies on:
//   - Process-group spawn on POSIX so `kill(-pid, ...)` reaps the
//     entire group (matches ModuleHostManager).
//   - `RN_DEV_HOOK_PGID=<daemon-pid>` env sentinel on every spawn so
//     orphan-sweep can match strays at next daemon boot.
//   - Parser switches to "post-result sink" after the first
//     `{kind:"result"}` record. Second result → multiple-results.
//   - Override fires require the first record be
//     `{kind:"ack", replaced: true}`. Missing ack on the first
//     non-ack record is a hard fail (NO silent fall-back).
//   - JSON.parse reviver strips `__proto__`/`constructor`/`prototype`
//     keys; Object.freeze on `record.data` before forwarding.
//   - Final-env `checkEnv` after merge — runner re-runs the daemon's
//     env-validator against the merged dict so a runner-injected key
//     can't smuggle a denylisted entry past the boundary.

import { spawn as defaultSpawn } from "node:child_process";
import { Readable } from "node:stream";
import split2 from "split2";
import { HookError, HookErrorCode } from "@rn-dev/module-sdk";
import {
  buildSpawnCommand,
  wrapChild,
  type SpawnHandle,
} from "../spawn-utils.js";
import { checkEnv, type ValidatedProfile } from "../../daemon/profile-guard.js";
import type { HookRecord } from "@rn-dev/config";
import { checkFingerprint } from "./path-resolver.js";
import { unlinkHookLockfile, writeHookLockfile } from "./lockfile.js";
import type { Registration } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HookSubprocessRunInput {
  registration: Registration;
  profile: ValidatedProfile;
  payload: unknown;
  /** True for override-slot fires; runner enforces ack-first protocol. */
  expectAck: boolean;
  /** Wall-clock timeout in ms; group-kill on overrun. */
  timeoutMs: number;
  /** Daemon pid stamped into `RN_DEV_HOOK_PGID` for orphan-sweep correlation. */
  daemonPid: number;
  /** Test seam — defaults to `node:child_process.spawn`. */
  spawnFn?: typeof defaultSpawn;
  /** Test seam — override `Date.now()`. */
  now?: () => number;
  /** Test seam — override `~/.rn-dev/hooks/` lockfile root. */
  lockfileRootOverride?: string;
}

export type HookSubprocessOutcome =
  | "ok"
  | "exit-nonzero"
  | "timeout"
  | "crashed-before-payload"
  | "multiple-results"
  | "missing-ack"
  | "path-mutated"
  | "spawn-failed"
  | "env-rejected";

export interface HookSubprocessRunResult {
  outcome: HookSubprocessOutcome;
  exitCode: number;
  durationMs: number;
  /** The `data` of the first `{kind:"result"}` record, frozen. */
  result?: unknown;
  /** All records observed (post-result records logged but not collected). */
  records: HookRecord[];
  error?: HookError;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const STDERR_RATE_LIMIT_BYTES_PER_S = 10 * 1024;
const STDOUT_RATE_LIMIT_BYTES_PER_S = 50 * 1024;
const STDOUT_RATE_LIMIT_RECORDS_PER_S = 200;
const PARSE_FAILURE_DROP_THRESHOLD = 100;
const KILL_GRACE_MS = 1500;

/**
 * RN_DEV_* env keys the runner forwards from the parent process to the
 * hook subprocess. Anything else with the `RN_DEV_` prefix is stripped
 * to avoid leaking daemon-internal toggles into hook scripts.
 */
const RN_DEV_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "RN_DEV_PROFILE_JSON",
  "RN_DEV_PROJECT_ROOT",
  "RN_DEV_DAEMON_MODE",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runHookSubprocess(
  input: HookSubprocessRunInput,
): Promise<HookSubprocessRunResult> {
  const now = input.now ?? Date.now;
  const start = now();
  const records: HookRecord[] = [];

  if (input.registration.resolved.kind !== "script") {
    return immediateError(
      "spawn-failed",
      "runHookSubprocess called on non-script registration",
      records,
      0,
    );
  }
  const script = input.registration.resolved.script;

  // TOCTOU re-check — registry's fingerprint vs current realpath/stat.
  const fingerprint = checkFingerprint(script);
  if (!fingerprint.ok) {
    return immediateError(
      "path-mutated",
      `Script fingerprint changed since registration: ${fingerprint.reason}`,
      records,
      0,
    );
  }

  const env = composeEnv(input);
  if (env.kind === "err") {
    return immediateError("env-rejected", env.message, records, 0);
  }

  const spawnFn = input.spawnFn ?? defaultSpawn;
  const { command, args } = buildSpawnCommand({
    command: script.fingerprint.realPath,
    args: [],
  });

  let child: SpawnHandle;
  try {
    const childProc = spawnFn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: env.value,
    });
    child = wrapChild(childProc);
  } catch (err) {
    return immediateError(
      "spawn-failed",
      `Failed to spawn hook ${script.fingerprint.realPath}: ${(err as Error).message}`,
      records,
      now() - start,
    );
  }

  // Write the orphan-sweep sentinel lockfile synchronously, before any
  // async work, so a daemon SIGKILL between spawn and lockfile-write
  // can't strand a hook subprocess invisible to the next daemon's sweep.
  // Best-effort: lockfile-write failure (e.g. ENOSPC) does NOT abort
  // the fire — the hook can still complete; the fallout is just that a
  // crash before completion would leak the subprocess.
  let lockfilePath: string | null = null;
  if (typeof child.pid === "number" && process.platform !== "win32") {
    try {
      lockfilePath = writeHookLockfile({
        pgid: child.pid,
        daemonPid: input.daemonPid,
        target: input.registration.target,
        rootOverride: input.lockfileRootOverride,
        now,
      });
    } catch {
      lockfilePath = null;
    }
  }

  return collectFromChild({
    child,
    payload: input.payload,
    expectAck: input.expectAck,
    timeoutMs: input.timeoutMs,
    target: input.registration.target,
    start,
    now,
    records,
    lockfilePath,
  });
}

// ---------------------------------------------------------------------------
// Env composition
// ---------------------------------------------------------------------------

function composeEnv(
  input: HookSubprocessRunInput,
): { kind: "ok"; value: NodeJS.ProcessEnv } | { kind: "err"; message: string } {
  const merged: NodeJS.ProcessEnv = {};
  // 1. Inherit parent — strip RN_DEV_HOOK_* (private to runner) and any
  //    RN_DEV_* not on the allowlist.
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("RN_DEV_HOOK_")) continue;
    if (k.startsWith("RN_DEV_") && !RN_DEV_ENV_ALLOWLIST.has(k)) continue;
    merged[k] = v;
  }
  // 2. Profile.env — validated upstream by `validateProfile`, but we
  //    re-merge here for the post-merge checkEnv.
  for (const [k, v] of Object.entries(input.profile.env ?? {})) {
    if (typeof v === "string") merged[k] = v;
  }
  // 3. Runner-injected keys.
  merged.RN_DEV_PROFILE_JSON = JSON.stringify(input.profile);
  merged.RN_DEV_PROJECT_ROOT = input.profile.projectRoot;
  merged.RN_DEV_HOOK_PGID = String(input.daemonPid);
  merged.RN_DEV_HOOK_TARGET = input.registration.target;
  merged.RN_DEV_HOOK_TIMEOUT_MS = String(input.timeoutMs);

  // 4. Re-validate the *final* env. Closes the leak where a
  //    runner-injected key could smuggle a denylisted entry past the
  //    initial profile-level checkEnv. The daemon-internal keys above
  //    pass the pattern + denylist (RN_DEV_HOOK_* is allowed because
  //    only the *parent's* RN_DEV_HOOK_* is stripped, not the
  //    runner's intentional injections — checkEnv permits this prefix).
  //
  // We hand checkEnv only the non-RN_DEV runner-injected portion since
  // checkEnv expects user-supplied env shapes; PATH/HOME/etc. inherited
  // from the parent are out of scope (the daemon doesn't validate
  // those at session boot either).
  const userPortion: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (typeof v !== "string") continue;
    // Skip parent-inherited system vars; checkEnv targets profile-set keys.
    if (k in process.env && !(input.profile.env ?? {})[k]) continue;
    if (k.startsWith("RN_DEV_HOOK_")) continue;
    if (k === "RN_DEV_PROFILE_JSON") continue;
    if (k === "RN_DEV_PROJECT_ROOT") continue;
    userPortion[k] = v;
  }
  const envCheck = checkEnv(userPortion, "hook-subprocess.env");
  if (!envCheck.ok) {
    return { kind: "err", message: envCheck.message };
  }
  return { kind: "ok", value: merged };
}

// ---------------------------------------------------------------------------
// Child-stream collection
// ---------------------------------------------------------------------------

interface CollectInput {
  child: SpawnHandle;
  payload: unknown;
  expectAck: boolean;
  timeoutMs: number;
  target: string;
  start: number;
  now: () => number;
  records: HookRecord[];
  /** Path to the orphan-sweep sentinel; unlinked on every terminal path. */
  lockfilePath: string | null;
}

function collectFromChild(input: CollectInput): Promise<HookSubprocessRunResult> {
  return new Promise((resolve) => {
    let firstResult: { data: unknown } | null = null;
    let multipleResultsHit = false;
    let missingAckHit = false;
    let parseFailureStreak = 0;
    let stdoutBytesThisSecond = 0;
    let stdoutRecordsThisSecond = 0;
    let stderrBytesThisSecond = 0;
    let bucketWindowStart = input.now();
    let resolved = false;

    const finish = (result: HookSubprocessRunResult): void => {
      if (resolved) return;
      resolved = true;
      // Best-effort stop the child; group-kill on POSIX.
      try {
        input.child.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      // Always unlink the orphan-sweep sentinel — the hook is no longer
      // ours to track. If the unlink fails (e.g. swept by a fresh
      // daemon), it's a no-op.
      if (input.lockfilePath !== null) {
        unlinkHookLockfile(input.lockfilePath);
      }
      resolve(result);
    };

    const refreshBucket = (): void => {
      const t = input.now();
      if (t - bucketWindowStart >= 1000) {
        bucketWindowStart = t;
        stdoutBytesThisSecond = 0;
        stdoutRecordsThisSecond = 0;
        stderrBytesThisSecond = 0;
      }
    };

    // --- stdout: split2 → parse → forward ---
    const stdoutStream = input.child.stdout as unknown as NodeJS.ReadableStream;
    const splitter = split2();
    stdoutStream.pipe(splitter as unknown as NodeJS.WritableStream);

    splitter.on("data", (rawLine: string | Buffer) => {
      refreshBucket();
      const lineText = typeof rawLine === "string" ? rawLine : rawLine.toString("utf-8");
      // Strip trailing \r for Windows CRLF safety.
      const line = lineText.endsWith("\r") ? lineText.slice(0, -1) : lineText;
      stdoutBytesThisSecond += Buffer.byteLength(line, "utf-8");
      if (
        stdoutBytesThisSecond > STDOUT_RATE_LIMIT_BYTES_PER_S ||
        stdoutRecordsThisSecond >= STDOUT_RATE_LIMIT_RECORDS_PER_S
      ) {
        return; // drop until window resets
      }

      const parsed = parseHookRecord(line);
      if (parsed === undefined) {
        parseFailureStreak++;
        if (parseFailureStreak >= PARSE_FAILURE_DROP_THRESHOLD) {
          // Emitter is hosing us — stop reading; child will SIGPIPE on next write.
          stdoutStream.removeAllListeners("data");
        }
        return;
      }
      parseFailureStreak = 0;
      stdoutRecordsThisSecond++;

      // Override-fire ack-first protocol.
      if (input.expectAck && input.records.length === 0) {
        if (!isAck(parsed)) {
          missingAckHit = true;
          finish(
            terminate("missing-ack", -1, input.records, input.start, input.now, {
              code: HookErrorCode.E_HOOK_FAILED,
              outcome: "multiple-results", // closest available; H4 gets dedicated outcome
              moduleId: input.target.split("/")[0]!,
              hookName: input.target.split("/")[1]!,
              phase: input.target as `${string}/${string}`,
            }),
          );
          return;
        }
      }

      // Result-termination protocol.
      if (parsed && parsed.kind === "result") {
        if (firstResult !== null) {
          multipleResultsHit = true;
          finish(
            terminate(
              "multiple-results",
              -1,
              input.records,
              input.start,
              input.now,
              {
                code: HookErrorCode.E_HOOK_FAILED,
                outcome: "multiple-results",
                moduleId: input.target.split("/")[0]!,
                hookName: input.target.split("/")[1]!,
                phase: input.target as `${string}/${string}`,
              },
            ),
          );
          return;
        }
        // First result — capture and freeze.
        const data =
          parsed.data !== undefined && typeof parsed.data === "object" && parsed.data !== null
            ? Object.freeze(parsed.data)
            : parsed.data;
        firstResult = { data };
        input.records.push({ ...parsed, data });
        return;
      }

      input.records.push(parsed);
    });

    // --- stderr: rate-limited, drop after threshold ---
    const stderrStream = input.child.stderr as unknown as NodeJS.ReadableStream;
    stderrStream.on("data", (chunk: Buffer | string) => {
      refreshBucket();
      const bytes = Buffer.byteLength(typeof chunk === "string" ? chunk : chunk, "utf-8");
      stderrBytesThisSecond += bytes;
      if (stderrBytesThisSecond > STDERR_RATE_LIMIT_BYTES_PER_S) {
        // drop excess
      }
      // No collection target in v1 — H6 will mirror to events/subscribe.
    });

    // --- stdin: write the JSON payload, then close ---
    try {
      input.child.stdin.write(JSON.stringify({ payload: input.payload }) + "\n");
      input.child.stdin.end();
    } catch (err) {
      // EPIPE: child died before reading payload.
      finish(
        terminate(
          "crashed-before-payload",
          -1,
          input.records,
          input.start,
          input.now,
          {
            code: HookErrorCode.E_HOOK_FAILED,
            outcome: "crashed-before-payload",
            moduleId: input.target.split("/")[0]!,
            hookName: input.target.split("/")[1]!,
            phase: input.target as `${string}/${string}`,
          },
        ),
      );
      return;
    }

    // --- timeout ---
    const timeoutHandle = setTimeout(() => {
      finish(
        terminate("timeout", -1, input.records, input.start, input.now, {
          code: HookErrorCode.E_HOOK_FAILED,
          outcome: "timeout",
          moduleId: input.target.split("/")[0]!,
          hookName: input.target.split("/")[1]!,
          phase: input.target as `${string}/${string}`,
        }),
      );
    }, input.timeoutMs);

    // --- exit ---
    input.child.onExit((code, _signal) => {
      clearTimeout(timeoutHandle);
      if (resolved || multipleResultsHit || missingAckHit) return;
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        finish({
          outcome: "exit-nonzero",
          exitCode,
          durationMs: input.now() - input.start,
          records: input.records,
          error: new HookError(
            `Hook ${input.target} exited with code ${exitCode}.`,
            {
              code: HookErrorCode.E_HOOK_FAILED,
              outcome: "timeout", // best-fit existing outcome; phase-keyed
              moduleId: input.target.split("/")[0]!,
              hookName: input.target.split("/")[1]!,
              phase: input.target as `${string}/${string}`,
              exitCode,
            },
          ),
        });
        return;
      }
      finish({
        outcome: "ok",
        exitCode: 0,
        durationMs: input.now() - input.start,
        records: input.records,
        result: firstResult?.data,
      });
    });

    // Force a kill if the child hangs after timeout SIGTERM.
    setTimeout(
      () => {
        if (!resolved) input.child.kill("SIGKILL");
      },
      input.timeoutMs + KILL_GRACE_MS,
    );
  });
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a JSON-line record. Returns `undefined` when the line cannot
 * be parsed into one of the three known kinds. The reviver strips
 * `__proto__`/`constructor`/`prototype` keys so a malicious record
 * cannot pollute the daemon's prototype chain.
 */
export function parseHookRecord(line: string): HookRecord | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed, (key, value) =>
      POLLUTION_KEYS.has(key) ? undefined : value,
    );
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  switch (record.kind) {
    case "ack":
      return typeof record.replaced === "boolean"
        ? { kind: "ack", replaced: record.replaced }
        : undefined;
    case "log":
      return typeof record.text === "string" &&
        (record.level === "debug" ||
          record.level === "info" ||
          record.level === "warn" ||
          record.level === "error")
        ? { kind: "log", level: record.level, text: record.text }
        : undefined;
    case "progress":
      return typeof record.percent === "number"
        ? {
            kind: "progress",
            percent: record.percent,
            text: typeof record.text === "string" ? record.text : undefined,
          }
        : undefined;
    case "result":
      return { kind: "result", data: record.data };
    default:
      return undefined;
  }
}

function isAck(record: HookRecord): record is { kind: "ack"; replaced: boolean } {
  return record !== null && record !== undefined && record.kind === "ack";
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function immediateError(
  outcome: HookSubprocessOutcome,
  message: string,
  records: HookRecord[],
  durationMs: number,
): HookSubprocessRunResult {
  return {
    outcome,
    exitCode: -1,
    durationMs,
    records,
    error: new HookError(message, {
      code: HookErrorCode.E_HOOK_FAILED,
      outcome:
        outcome === "path-mutated"
          ? "path-mutated"
          : outcome === "spawn-failed"
            ? "crashed-before-payload"
            : outcome === "env-rejected"
              ? "crashed-before-payload"
              : "crashed-before-payload",
      moduleId: "(unknown)",
      hookName: "(unknown)",
      phase: "(unknown)/(unknown)" as `${string}/${string}`,
    }),
  };
}

function terminate(
  outcome: HookSubprocessOutcome,
  exitCode: number,
  records: HookRecord[],
  start: number,
  now: () => number,
  errorDetails: import("@rn-dev/module-sdk").HookErrorDetails & {
    code: typeof HookErrorCode.E_HOOK_FAILED;
  },
): HookSubprocessRunResult {
  return {
    outcome,
    exitCode,
    durationMs: now() - start,
    records,
    error: new HookError(`Hook terminated with outcome=${outcome}`, errorDetails),
  };
}

// Unused export-suppressor (keeps Readable import used when bundlers
// strip type-only imports too aggressively).
void Readable;
