// HookManager — thin facade over Registry / Dispatcher / AuditWriter /
// Subprocess runner. Public API is intentionally small; the four
// classes underneath own the actual behavior. EventEmitter parity with
// MetroManager / DevToolsManager / ModuleHostManager.
//
// Events:
//   - "hooks/registered"  { registration }
//   - "hooks/orphaned"    { target, source } — at register time
//   - "hooks/orphaned-skipped" { registration, target } — at fire time
//   - "hooks/fired"       { target, outcome }

import { EventEmitter } from "node:events";
import { HookError, HookErrorCode } from "@rn-dev/module-sdk";
import type { HookPhase } from "@rn-dev/config";
import type { ValidatedProfile } from "../../daemon/profile-guard.js";
import { HookAuditWriter } from "./audit-writer.js";
import {
  HookDispatcher,
  type FireOutcome,
  type HookDispatcherOptions,
} from "./dispatcher.js";
import { HookRegistry } from "./registry.js";
import type { Registration, RegistrationInput, RegistryDump } from "./types.js";
import type { AuditLog } from "../audit-log.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HookManagerOptions {
  auditLog: AuditLog;
  daemonPid: number;
  defaultTimeoutMs?: number;
  concurrentFireCap?: number;
  /** Test seam — see HookDispatcherOptions.runSubprocess. */
  runSubprocess?: HookDispatcherOptions["runSubprocess"];
  /** Test seam — `Date.now`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// HookManager
// ---------------------------------------------------------------------------

export class HookManager extends EventEmitter {
  private readonly registry = new HookRegistry();
  private readonly dispatcher: HookDispatcher;
  private readonly auditWriter: HookAuditWriter;

  constructor(opts: HookManagerOptions) {
    super();
    this.auditWriter = new HookAuditWriter(opts.auditLog);
    this.dispatcher = new HookDispatcher({
      registry: this.registry,
      auditWriter: this.auditWriter,
      daemonPid: opts.daemonPid,
      defaultTimeoutMs: opts.defaultTimeoutMs,
      concurrentFireCap: opts.concurrentFireCap,
      runSubprocess: opts.runSubprocess,
      now: opts.now,
    });
  }

  // -------------------------------------------------------------------------
  // Registration surface (delegates to HookRegistry; emits events)
  // -------------------------------------------------------------------------

  declareProvider(moduleId: string, hookNames: readonly string[]): void {
    this.registry.declareProvider(moduleId, hookNames);
    const reanimated = this.registry.recomputeOrphans();
    for (const r of reanimated) this.emit("hooks/registered", { registration: r });
  }

  retractProvider(moduleId: string): void {
    this.registry.retractProvider(moduleId);
    this.registry.recomputeOrphans();
  }

  /**
   * Add a hook registration. Synchronously resolved at this point —
   * caller (HookManager bootstrap) is responsible for path resolution
   * via `resolveHookScript` if `entry` is a script.
   *
   * Audit policy:
   *   - Override-slot registrations always written (success or denial).
   *   - Other registrations are not audited (volume).
   */
  async addRegistration(input: RegistrationInput): Promise<Registration> {
    const registration = this.registry.addRegistration(input);
    if (registration.isOverride && !registration.orphaned) {
      await this.auditWriter.writeOverrideRegistration(registration, "ok");
    }
    if (registration.orphaned) {
      this.emit("hooks/orphaned", {
        target: registration.target,
        source: registration.source,
      });
    } else {
      this.emit("hooks/registered", { registration });
    }
    return registration;
  }

  // -------------------------------------------------------------------------
  // Fire surface (delegates to HookDispatcher; emits hooks/fired)
  // -------------------------------------------------------------------------

  /**
   * Fire `target` with `payload`. The empty-registry fast path skips
   * the dispatcher, the audit writer, AND the event emit — performance
   * critical because this is called from session boot and every build.
   *
   * `profile` MUST be a `ValidatedProfile` minted by `validateProfile`;
   * the type system enforces this. Re-validation at every entry point
   * (RPC handler, MCP tool, in-process call) is the showstopper that
   * closes the agent-supplied-payload bypass.
   *
   * Throws when any failed registration's `onFail` is `"hard"`. Other
   * `onFail` modes return the outcome on `result.failures` for the
   * caller to inspect.
   */
  async fire(
    target: HookPhase,
    payload: unknown,
    profile: ValidatedProfile,
  ): Promise<FireOutcome> {
    if (!this.registry.hasAnyRegistration(target)) {
      // Phase H2g follow-up — emit `hooks/fired` even on the empty-
      // registry fast path. The plan calls for "Daemon emits
      // hooks/fired on every hook completion (success and fail)";
      // subscribers (MCP agents, future hooks UI) need to see
      // "fired with 0 consumers" to answer "did my build/pre slot
      // run? how many consumers picked it up?". The dispatcher path
      // emits below; this guarantees the same emit on the fast path
      // so the wire event is always present per fire().
      const empty: FireOutcome = { ok: true, fired: 0, skipped: 0, failures: [] };
      this.emit("hooks/fired", { target, outcome: empty });
      return empty;
    }
    const outcome = await this.dispatcher.fire({ target, payload, profile });
    this.emit("hooks/fired", { target, outcome });

    // Escalate if any failure's `onFail: "hard"`.
    const hardFailure = outcome.failures.find(
      (f) => f.registration.onFail === "hard",
    );
    if (hardFailure) {
      throw new HookError(
        `Hook ${target} hard-failed via ${formatRegistrationSource(hardFailure.registration)}: ${hardFailure.error.message}`,
        hardFailure.error.details ?? {
          code: HookErrorCode.E_HOOK_FAILED,
          outcome: "crashed-before-payload",
          moduleId: target.split("/")[0]!,
          hookName: target.split("/")[1]!,
          phase: target,
        },
      );
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Read API
  // -------------------------------------------------------------------------

  /** Debug snapshot — vitest assertions only, NOT exposed via MCP. */
  dumpRegistry(): RegistryDump {
    return this.registry.dump();
  }

  orphanedRegistrations(): Registration[] {
    return this.registry.orphanedRegistrations();
  }
}

function formatRegistrationSource(r: Registration): string {
  return r.source.kind === "project"
    ? `project ${r.source.configPath}`
    : `module ${r.source.moduleId}`;
}
