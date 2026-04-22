// Generic host-side capability registry. Built-ins and 3p modules both
// register into this — the SDK's `host.capability<T>(id)` is a thin proxy
// over `resolve()` with the calling module's granted permissions bound in.
//
// Phase 1 decision: exact-match permission strings only. No globs. Keeps
// the permission surface small enough to audit at install-consent time.

export interface RegisterOptions {
  requiredPermission?: string;
  /**
   * Opt-in override for reserved id enforcement. Only `startFlow` /
   * `startRealServices` use this when wiring the host's own `"log"` /
   * `"appInfo"` implementations; every other caller (3p + built-in
   * capabilities) must pick a non-reserved id.
   */
  allowReserved?: boolean;
}

export interface CapabilityDescriptor {
  id: string;
  requiredPermission?: string;
}

interface StoredCapability<T = unknown> {
  id: string;
  impl: T;
  requiredPermission?: string;
}

/**
 * Security F6 — reserved capability ids. The SDK synthesizes
 * `host.capability("log")` / `host.capability("appInfo")` client-side
 * without a round-trip (see packages/module-sdk/src/module-runtime.ts);
 * registering another impl under these ids would be silently shadowed for
 * in-process callers and surprise-confused for RPC callers. Guard at
 * `register()` time rather than hope nobody makes the mistake.
 */
export const RESERVED_CAPABILITY_IDS: ReadonlyArray<string> = [
  "log",
  "appInfo",
];

export class CapabilityRegistry {
  private readonly entries = new Map<string, StoredCapability>();

  register<T>(id: string, impl: T, options: RegisterOptions = {}): void {
    if (this.entries.has(id)) {
      throw new Error(`Capability "${id}" is already registered.`);
    }
    if (!options.allowReserved && RESERVED_CAPABILITY_IDS.includes(id)) {
      throw new Error(
        `Capability id "${id}" is reserved (SDK synthesizes it client-side); pass { allowReserved: true } only from host startup.`,
      );
    }
    this.entries.set(id, {
      id,
      impl,
      requiredPermission: options.requiredPermission,
    });
  }

  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  resolve<T>(id: string, grantedPermissions: readonly string[]): T | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (
      entry.requiredPermission &&
      !grantedPermissions.includes(entry.requiredPermission)
    ) {
      return null;
    }
    return entry.impl as T;
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  describe(id: string): CapabilityDescriptor | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    return {
      id: entry.id,
      requiredPermission: entry.requiredPermission,
    };
  }

  describeAll(): CapabilityDescriptor[] {
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      requiredPermission: e.requiredPermission,
    }));
  }
}
