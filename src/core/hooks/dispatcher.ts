// Fires hooks against the pre-baked sorted registrations from
// HookRegistry. Owns the in-process vs subprocess routing decision
// (registration's `resolved.kind`), the concurrent-fire queue cap,
// the empty-registry fast path, and the `onFail` policy that decides
// what happens when a registration errors.
//
// Audit policy lives entirely in HookAuditWriter; the dispatcher just
// hands it `{ outcome, durationMs, exitCode }` after each fire and lets
// the writer decide what (if anything) hits ~/.rn-dev/audit.log.

import { HookError, HookErrorCode } from "@rn-dev/module-sdk";
import type { HookPhase } from "@rn-dev/config";
import type { ValidatedProfile } from "../../daemon/profile-guard.js";
import type { HookAuditWriter } from "./audit-writer.js";
import type { HookRegistry } from "./registry.js";
import type { Registration } from "./types.js";
import {
  runHookSubprocess,
  type HookSubprocessRunResult,
} from "./runner-subprocess.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FireOutcome {
  /** "ok" iff every non-orphaned registration in the slot succeeded. */
  ok: boolean;
  fired: number;
  skipped: number;
  failures: FireFailure[];
}

export interface FireFailure {
  registration: Registration;
  reason: "subprocess" | "in-process-throw" | "path-mutated" | "queue-full";
  error: HookError;
}

export interface HookDispatcherOptions {
  registry: HookRegistry;
  auditWriter: HookAuditWriter;
  daemonPid: number;
  /** Wall-clock per-registration default. Per-entry `timeoutMs` overrides. */
  defaultTimeoutMs?: number;
  /** Max concurrent fires across the dispatcher. Overflow → queue-full audit. */
  concurrentFireCap?: number;
  /** Test seam — replaces `runHookSubprocess`. */
  runSubprocess?: typeof runHookSubprocess;
  /** Test seam — `Date.now`. */
  now?: () => number;
}

export interface FireInput {
  target: HookPhase;
  payload: unknown;
  profile: ValidatedProfile;
}

// ---------------------------------------------------------------------------
// HookDispatcher
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENT_CAP = 10;

export class HookDispatcher {
  private readonly registry: HookRegistry;
  private readonly auditWriter: HookAuditWriter;
  private readonly daemonPid: number;
  private readonly defaultTimeoutMs: number;
  private readonly concurrentFireCap: number;
  private readonly runSubprocess: typeof runHookSubprocess;
  private readonly now: () => number;
  private inflight = 0;

  constructor(opts: HookDispatcherOptions) {
    this.registry = opts.registry;
    this.auditWriter = opts.auditWriter;
    this.daemonPid = opts.daemonPid;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.concurrentFireCap = opts.concurrentFireCap ?? DEFAULT_CONCURRENT_CAP;
    this.runSubprocess = opts.runSubprocess ?? runHookSubprocess;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Fire `target` with `payload`. Returns `{ ok, fired, skipped, failures }`.
   * Empty-registry fast path: when no registrations exist, returns the
   * zero-cost result without awaiting, auditing, or emitting events.
   *
   * The dispatcher does NOT throw on registration failures — the
   * `failures[]` array tells the caller what went wrong, and the
   * caller (typically `HookManager.fire`) decides whether the
   * `onFail: "hard"` policy escalates into a thrown HookError.
   */
  async fire(input: FireInput): Promise<FireOutcome> {
    const registrations = this.registry.registrationsFor(input.target);
    if (registrations.length === 0) {
      return { ok: true, fired: 0, skipped: 0, failures: [] };
    }
    if (this.inflight >= this.concurrentFireCap) {
      // Audit one queue-full per blocked target (no per-registration noise).
      await this.auditWriter.writeQueueFull(registrations[0]!);
      return {
        ok: false,
        fired: 0,
        skipped: 0,
        failures: [
          {
            registration: registrations[0]!,
            reason: "queue-full",
            error: new HookError(
              `Hook fire queue full (cap=${this.concurrentFireCap}); skipping ${input.target}.`,
              {
                code: HookErrorCode.E_HOOK_FAILED,
                outcome: "queue-full",
                moduleId: parseModuleId(input.target),
                hookName: parseHookName(input.target),
                phase: input.target,
              },
            ),
          },
        ],
      };
    }
    this.inflight++;
    try {
      return await this.dispatchAll(registrations, input);
    } finally {
      this.inflight--;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async dispatchAll(
    registrations: readonly Registration[],
    input: FireInput,
  ): Promise<FireOutcome> {
    let fired = 0;
    let skipped = 0;
    const failures: FireFailure[] = [];

    for (const reg of registrations) {
      if (reg.orphaned) {
        skipped++;
        continue;
      }
      const failure = await this.dispatchOne(reg, input);
      if (failure) failures.push(failure);
      else fired++;
    }
    return {
      ok: failures.length === 0,
      fired,
      skipped,
      failures,
    };
  }

  private async dispatchOne(
    reg: Registration,
    input: FireInput,
  ): Promise<FireFailure | null> {
    if (reg.resolved.kind === "fn") {
      return await this.dispatchFn(reg, input);
    }
    return await this.dispatchSubprocess(reg, input);
  }

  private async dispatchFn(
    reg: Registration,
    input: FireInput,
  ): Promise<FireFailure | null> {
    const start = this.now();
    try {
      await Promise.resolve(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        (reg.resolved as Extract<Registration["resolved"], { kind: "fn" }>).fn(
          input.payload,
        ),
      );
      // Successful in-process fires are NOT audited (volume).
      return null;
    } catch (err) {
      const durationMs = this.now() - start;
      const error =
        err instanceof HookError
          ? err
          : new HookError(
              `In-process hook ${reg.target} threw: ${(err as Error).message ?? String(err)}`,
              {
                code: HookErrorCode.E_HOOK_FAILED,
                outcome: "crashed-before-payload",
                moduleId: parseModuleId(reg.target),
                hookName: parseHookName(reg.target),
                phase: reg.target,
              },
            );
      await this.auditWriter.writeFailure(reg, {
        outcome: "error",
        durationMs,
        exitCode: -1,
      });
      return { registration: reg, reason: "in-process-throw", error };
    }
  }

  private async dispatchSubprocess(
    reg: Registration,
    input: FireInput,
  ): Promise<FireFailure | null> {
    const result: HookSubprocessRunResult = await this.runSubprocess({
      registration: reg,
      profile: input.profile,
      payload: input.payload,
      expectAck: reg.isOverride,
      timeoutMs: reg.timeoutMs ?? this.defaultTimeoutMs,
      daemonPid: this.daemonPid,
      now: this.now,
    });

    if (result.outcome === "ok") {
      // Successful subprocess fire — silent on the audit log.
      return null;
    }

    const reason: FireFailure["reason"] =
      result.outcome === "path-mutated" ? "path-mutated" : "subprocess";
    await this.auditWriter.writeFailure(reg, {
      outcome: result.outcome === "path-mutated" ? "denied" : "error",
      durationMs: result.durationMs,
      exitCode: result.exitCode,
    });
    return {
      registration: reg,
      reason,
      error:
        result.error ??
        new HookError(`Subprocess hook ${reg.target} failed.`, {
          code: HookErrorCode.E_HOOK_FAILED,
          outcome: "crashed-before-payload",
          moduleId: parseModuleId(reg.target),
          hookName: parseHookName(reg.target),
          phase: reg.target,
        }),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseModuleId(target: HookPhase): string {
  const slash = target.indexOf("/");
  return slash > 0 ? target.slice(0, slash) : "(unknown)";
}

function parseHookName(target: HookPhase): string {
  const slash = target.indexOf("/");
  return slash > 0 ? target.slice(slash + 1) : "(unknown)";
}
