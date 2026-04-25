// Per-connection module-binding table for `modules/host-call`. Each
// socket connection must `bind()` the moduleIds it's allowed to act
// on behalf of before host-call will accept them. Bindings are
// per-connection and `clearConnection()`'d when the socket closes.
//
// Threat model + Phase 13.5 motivation: see
// docs/plans/2026-04-25-module-system-phase-13-5-plan.md.

export class SenderBindings {
  private readonly table = new Map<string, Set<string>>();

  /** Authorize `connectionId` to act on behalf of `moduleId`. Idempotent. */
  bind(connectionId: string, moduleId: string): void {
    let set = this.table.get(connectionId);
    if (!set) {
      set = new Set();
      this.table.set(connectionId, set);
    }
    set.add(moduleId);
  }

  /** True iff `connectionId` has bound `moduleId`. Deny-by-default. */
  canCall(connectionId: string, moduleId: string): boolean {
    return this.table.get(connectionId)?.has(moduleId) ?? false;
  }

  /** Drop every binding the connection held. Idempotent on unknown ids. */
  clearConnection(connectionId: string): void {
    this.table.delete(connectionId);
  }
}
