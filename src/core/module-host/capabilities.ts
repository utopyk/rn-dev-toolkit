// Generic host-side capability registry. Built-ins and 3p modules both
// register into this — the SDK's `host.capability<T>(id)` is a thin proxy
// over `resolve()` with the calling module's granted permissions bound in.
//
// Phase 1 decision: exact-match permission strings only. No globs. Keeps
// the permission surface small enough to audit at install-consent time.

export interface RegisterOptions {
  requiredPermission?: string;
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

export class CapabilityRegistry {
  private readonly entries = new Map<string, StoredCapability>();

  register<T>(id: string, impl: T, options: RegisterOptions = {}): void {
    if (this.entries.has(id)) {
      throw new Error(`Capability "${id}" is already registered.`);
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
