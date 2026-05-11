// Pure-data registry of hook contribution points and registrations.
// Zero I/O: the dispatcher resolves scripts, the runner spawns
// subprocesses, the audit writer touches disk. The registry just owns
// the in-memory map + ordering invariants.
//
// Ordering: registrations within a slot are pre-baked into a sorted
// list at registration time, sorted by
// `(priority desc, registrationOrder asc)`. The dispatcher iterates
// the pre-baked list directly — no per-fire sort. Adding/removing a
// registration rebuilds the slot's sorted list; everything else
// reads.

import type { HookPhase } from "@rn-dev/config";
import type {
  ContributionPoint,
  Registration,
  RegistrationInput,
  RegistryDump,
} from "./types.js";

const OVERRIDE_HOOK_NAME = "custom";

/**
 * Optional did-you-mean suggester. Pure function exposed as a static
 * helper so callers (e.g. the H2 `hooks-diagnose` MCP tool) can reuse
 * the same scoring without instantiating a registry.
 */
export function suggestHookName(
  unknown: string,
  candidates: readonly string[],
): string | undefined {
  if (candidates.length === 0) return undefined;
  let bestScore = Infinity;
  let bestCandidate: string | undefined;
  for (const candidate of candidates) {
    const d = levenshtein(unknown, candidate);
    if (d < bestScore) {
      bestScore = d;
      bestCandidate = candidate;
    }
  }
  // Only suggest when the edit distance is small relative to the longer
  // string; otherwise the "did-you-mean" is noise.
  const ceiling = Math.max(2, Math.floor(unknown.length / 3));
  return bestScore <= ceiling ? bestCandidate : undefined;
}

export class HookRegistry {
  /** moduleId → set of declared hook names from `provides.hooks`. */
  private readonly providers = new Map<string, Set<string>>();
  /** "<moduleId>/<hookName>" → pre-sorted list. */
  private readonly registrationsByTarget = new Map<HookPhase, Registration[]>();
  /** Insertion order ticker. Tied registrations dispatch in registration order. */
  private nextRegistrationOrder = 0;
  /**
   * Track which override slots (`<id>/custom`) have a non-orphaned
   * registration so we can reject duplicates at registration time
   * (single-override invariant).
   */
  private readonly overrideClaimedBy = new Map<HookPhase, string>();

  // ---------------------------------------------------------------------
  // Provider lifecycle
  // ---------------------------------------------------------------------

  /**
   * Declare a provider's contribution points. Idempotent — re-declaring
   * the same moduleId with a different set replaces the previous set.
   * The dispatcher does NOT walk this map at fire time; it only drives
   * orphan re-evaluation when called from `recomputeOrphans`.
   */
  declareProvider(moduleId: string, hookNames: readonly string[]): void {
    this.providers.set(moduleId, new Set(hookNames));
  }

  retractProvider(moduleId: string): void {
    this.providers.delete(moduleId);
  }

  isProviderKnown(moduleId: string, hookName: string): boolean {
    return this.providers.get(moduleId)?.has(hookName) ?? false;
  }

  contributionPoints(): ContributionPoint[] {
    const out: ContributionPoint[] = [];
    for (const [moduleId, hooks] of this.providers) {
      for (const name of hooks) out.push({ moduleId, hookName: name });
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Registration lifecycle
  // ---------------------------------------------------------------------

  /**
   * Add a registration. Throws on:
   *   - empty `target` segments (handled by `HookPhase`'s string parse);
   *   - duplicate override registration against an already-claimed slot;
   * Other invariants (target shape, entry shape) live in the caller —
   * `HookManager` owns config/manifest validation before reaching here.
   *
   * Returns the resolved `Registration` with `orphaned` filled in based
   * on whether the target's `<moduleId>` has declared the `<hookName>`.
   */
  addRegistration(input: RegistrationInput): Registration {
    const [moduleId, hookName] = parseTarget(input.target);
    const isOverride = hookName === OVERRIDE_HOOK_NAME;
    const orphaned = !this.isProviderKnown(moduleId, hookName);

    if (isOverride && !orphaned) {
      const existing = this.overrideClaimedBy.get(input.target);
      if (existing !== undefined) {
        throw new Error(
          `E_HOOK_FAILED multiple-override: target ${input.target} already claimed by source ${existing}`,
        );
      }
      this.overrideClaimedBy.set(input.target, sourceLabel(input.source));
    }

    const registration: Registration = {
      target: input.target,
      source: input.source,
      resolved: input.resolved,
      priority: priorityOf(input.entry),
      registrationOrder: this.nextRegistrationOrder++,
      onFail: onFailOf(input.entry),
      timeoutMs: timeoutOf(input.entry),
      isOverride,
      orphaned,
    };

    const list = this.registrationsByTarget.get(input.target) ?? [];
    list.push(registration);
    list.sort(byPriorityDescThenOrderAsc);
    this.registrationsByTarget.set(input.target, list);

    return registration;
  }

  /**
   * Drop registrations that came from a given source. Used when a 3p
   * module is uninstalled or the project's `rn-dev.config.ts` is
   * reloaded (H6 future). Returns the number of registrations removed.
   */
  removeBySource(predicate: (r: Registration) => boolean): number {
    let removed = 0;
    for (const [target, list] of this.registrationsByTarget) {
      const kept = list.filter((r) => {
        if (predicate(r)) {
          removed++;
          if (r.isOverride && !r.orphaned) {
            this.overrideClaimedBy.delete(target);
          }
          return false;
        }
        return true;
      });
      if (kept.length === 0) {
        this.registrationsByTarget.delete(target);
      } else {
        this.registrationsByTarget.set(target, kept);
      }
    }
    return removed;
  }

  /**
   * Re-evaluate `orphaned` flags after a provider declares new hook
   * names (e.g. when a 3p module activates after registrations were
   * loaded against its anticipated `provides.hooks`). Returns the
   * registrations whose `orphaned` flipped to `false`.
   */
  recomputeOrphans(): Registration[] {
    const flipped: Registration[] = [];
    for (const list of this.registrationsByTarget.values()) {
      for (const r of list) {
        const [moduleId, hookName] = parseTarget(r.target);
        const nowKnown = this.isProviderKnown(moduleId, hookName);
        if (r.orphaned && nowKnown) {
          r.orphaned = false;
          if (r.isOverride && !this.overrideClaimedBy.has(r.target)) {
            this.overrideClaimedBy.set(r.target, sourceLabel(r.source));
          }
          flipped.push(r);
        } else if (!r.orphaned && !nowKnown) {
          r.orphaned = true;
          if (r.isOverride) this.overrideClaimedBy.delete(r.target);
        }
      }
    }
    return flipped;
  }

  // ---------------------------------------------------------------------
  // Read API
  // ---------------------------------------------------------------------

  /** Pre-baked sorted list for a target slot. Empty if none registered. */
  registrationsFor(target: HookPhase): readonly Registration[] {
    return this.registrationsByTarget.get(target) ?? [];
  }

  /** Whether ANY registration exists for the target — drives the empty-registry fast path. */
  hasAnyRegistration(target: HookPhase): boolean {
    const list = this.registrationsByTarget.get(target);
    return list !== undefined && list.length > 0;
  }

  orphanedRegistrations(): Registration[] {
    const out: Registration[] = [];
    for (const list of this.registrationsByTarget.values()) {
      for (const r of list) if (r.orphaned) out.push(r);
    }
    return out;
  }

  /**
   * Snapshot for debug/test assertions. Internal-only — not surfaced via
   * MCP. The map flattens out of `registrationsByTarget` so vitest can
   * structure-match without copying our private Map.
   */
  dump(): RegistryDump {
    const providers: Record<string, string[]> = {};
    for (const [moduleId, hooks] of this.providers) {
      providers[moduleId] = [...hooks];
    }
    const registrations: Record<string, Registration[]> = {};
    for (const [target, list] of this.registrationsByTarget) {
      registrations[target] = [...list];
    }
    return {
      providers,
      registrations,
      orphaned: this.orphanedRegistrations(),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTarget(target: string): [string, string] {
  const slash = target.indexOf("/");
  if (slash <= 0 || slash >= target.length - 1) {
    throw new Error(
      `Invalid hook target "${target}": expected "<moduleId>/<hookName>".`,
    );
  }
  return [target.slice(0, slash), target.slice(slash + 1)];
}

function priorityOf(entry: RegistrationInput["entry"]): number {
  if (typeof entry === "string") return 0;
  return entry.priority ?? 0;
}

function onFailOf(entry: RegistrationInput["entry"]): Registration["onFail"] {
  if (typeof entry === "string") return "warn";
  return entry.onFail ?? "warn";
}

function timeoutOf(
  entry: RegistrationInput["entry"],
): number | undefined {
  if (typeof entry === "string") return undefined;
  return entry.timeoutMs;
}

function sourceLabel(source: RegistrationInput["source"]): string {
  return source.kind === "project"
    ? `project:${source.configPath}`
    : `module:${source.moduleId}`;
}

function byPriorityDescThenOrderAsc(a: Registration, b: Registration): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.registrationOrder - b.registrationOrder;
}

/**
 * Plain Levenshtein. ~30 LOC; pulling in `fastest-levenshtein` for a
 * registry-load-time suggestion is overkill (Explore #1 weighed this).
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}
