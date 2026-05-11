// Concentrates the "should this fire produce an audit entry?" decisions
// in one reviewable place. The dispatcher fires the hook, then asks the
// writer to record it; the writer applies the policy and forwards to
// the host's `AuditLog`. Modules NEVER touch `AuditLog` directly.
//
// Policy (Phase H1):
//   - Successful additive fires: NOT audited. Volume too high; build/clean
//     log already captures stdout/stderr.
//   - Failures (hard or warn-escalated): ALWAYS audited.
//   - Override registrations: ALWAYS audited at registration time, success
//     or denial. Records when a 3p module gained the right to replace a
//     built-in step.
//   - Queue overflow: ALWAYS audited (security-sentinel finding 10).
//   - Override fires: H4 will route through here too once the override
//     dispatch path lands; H1 only audits the registration event.

import type { AuditLog, AuditOutcome } from "../audit-log.js";
import type { Registration } from "./types.js";

export interface FireResult {
  outcome: AuditOutcome;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Subprocess exit code. `-1` for in-process or unspawned hooks. */
  exitCode: number;
}

export class HookAuditWriter {
  constructor(private readonly auditLog: AuditLog) {}

  /**
   * Audit a fire that failed. Does NOTHING for `outcome: "ok"` — the
   * dispatcher must call the right method for the right outcome.
   * Returns the registered ts so callers can correlate with events.
   */
  async writeFailure(
    registration: Registration,
    result: FireResult,
  ): Promise<void> {
    if (result.outcome === "ok") return;
    await this.auditLog.append({
      kind: "hook",
      phase: registration.target,
      source: sourceTag(registration),
      scriptOrSymbol: scriptOrSymbol(registration),
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      outcome: result.outcome,
      reason: "failure",
    });
  }

  /**
   * Audit an override slot registration — `<id>/custom`. Always written
   * regardless of outcome so reviewers can see when permission was
   * granted (or denied) historically.
   */
  async writeOverrideRegistration(
    registration: Registration,
    outcome: AuditOutcome,
  ): Promise<void> {
    await this.auditLog.append({
      kind: "hook",
      phase: registration.target,
      source: sourceTag(registration),
      scriptOrSymbol: scriptOrSymbol(registration),
      durationMs: 0,
      exitCode: -1,
      outcome,
      reason: "override-registered",
    });
  }

  /**
   * Audit a fire that was rejected because the in-flight queue was full.
   * Always written — security-sentinel finding 10.
   */
  async writeQueueFull(registration: Registration): Promise<void> {
    await this.auditLog.append({
      kind: "hook",
      phase: registration.target,
      source: sourceTag(registration),
      scriptOrSymbol: scriptOrSymbol(registration),
      durationMs: 0,
      exitCode: -1,
      outcome: "denied",
      reason: "queue-full",
    });
  }
}

function sourceTag(r: Registration): "project" | `module:${string}` {
  return r.source.kind === "project" ? "project" : `module:${r.source.moduleId}`;
}

function scriptOrSymbol(r: Registration): string {
  return r.resolved.kind === "script"
    ? r.resolved.script.fingerprint.realPath
    : `fn:${r.resolved.symbol}`;
}
