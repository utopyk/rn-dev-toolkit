// Generic host-side capability registry. Built-ins and 3p modules both
// register into this — the SDK's `host.capability<T>(id)` is a thin proxy
// over `resolve()` with the calling module's granted permissions bound in.
//
// Phase 1 decision: exact-match permission strings only. No globs. Keeps
// the permission surface small enough to audit at install-consent time.

export interface RegisterOptions {
  requiredPermission?: string;
  /**
   * Phase 10 P2-7 — optional per-method permission overrides. Layered on
   * top of `requiredPermission`: the capability-level permission is the
   * baseline gate for `resolve()` (you need the baseline to see the
   * impl at all), and each method can demand a stricter permission
   * checked by `resolveMethod()`. Used by the devtools capability to
   * split read-only (list/get/status) from mutating (clear/selectTarget)
   * methods — a module with read-only grants can't drop the worktree's
   * capture buffer.
   */
  methodPermissions?: Readonly<Record<string, string>>;
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
  methodPermissions?: Readonly<Record<string, string>>;
}

interface StoredCapability<T = unknown> {
  id: string;
  impl: T;
  requiredPermission?: string;
  methodPermissions?: Readonly<Record<string, string>>;
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

/**
 * Phase 10 P2-11 — canonical permission names the host understands. Used
 * as a typo detector at capability-register time and manifest-load time.
 * Not a security boundary (advisory permissions are surfaced in the
 * consent dialog, not enforced by the host), just a lint to catch the
 * kind of typo that used to silently drop a capability's grant —
 * "devtools:captures" vs. "devtools:capture", "exec:addb" vs. "exec:adb".
 *
 * Extended when a new capability ships. Keep the full set here rather
 * than per-capability because a capability's `requiredPermission` /
 * `methodPermissions` are what a manifest needs to declare, and tooling
 * wants a single source of truth.
 */
export const KNOWN_PERMISSIONS: ReadonlyArray<string> = [
  "devtools:capture", // legacy umbrella (Phase 10 grace period)
  "devtools:capture:read",
  "devtools:capture:mutate",
  "exec:adb",
  "exec:simctl",
  "exec:react-native",
  "fs:artifacts",
  "metro:logs:read",
  "metro:logs:mutate",
  "network:outbound",
];

const KNOWN_PERMISSION_SET = new Set<string>(KNOWN_PERMISSIONS);

/**
 * Phase 10 P2-7 / Phase 11 — permission aliases. Maps a legacy umbrella
 * permission to the granular set it now grants, so v1 manifests keep
 * working during the grace period while 3p modules migrate to declare
 * granular permissions explicitly.
 *
 * Relocated here from `host-rpc.ts` (Phase 11 Arch P2): the alias table is
 * security policy (which permission strings expand to which), not
 * transport (how host calls flow over JSON-RPC). Keeping it next to
 * `KNOWN_PERMISSIONS` so a new capability that wants its own umbrella
 * can declare both in the same file.
 *
 * The expansion runs at `host/call` time (see `expandPermissionAliases`);
 * the capability registry itself never sees umbrella names.
 */
export const PERMISSION_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "devtools:capture": ["devtools:capture:read", "devtools:capture:mutate"],
};

let warnedAliases = new Set<string>();

export function expandPermissionAliases(
  grantedPermissions: readonly string[],
  moduleId: string,
): readonly string[] {
  const out = new Set<string>(grantedPermissions);
  for (const legacy of grantedPermissions) {
    const expansion = PERMISSION_ALIASES[legacy];
    if (!expansion) continue;
    for (const p of expansion) out.add(p);
    const warnKey = `${moduleId}:${legacy}`;
    if (!warnedAliases.has(warnKey)) {
      warnedAliases.add(warnKey);
      // eslint-disable-next-line no-console
      console.warn(
        `[module-host] module "${moduleId}" holds legacy permission "${legacy}" — deprecated, will be removed in a future version. Update the manifest to declare ${expansion
          .map((p) => `"${p}"`)
          .join(" + ")} explicitly.`,
      );
    }
  }
  return [...out];
}

/** Reset the alias warning dedup set — tests only. */
export function resetPermissionAliasWarningsForTests(): void {
  warnedAliases = new Set<string>();
}

/**
 * Emit a console warning for any permission string that isn't on the
 * canonical list. Called by `CapabilityRegistry.register()` for
 * capability-side declarations and by the module registry at manifest
 * load for module-side grants. One warning per unique permission name;
 * the caller deduplicates via `warnedUnknownPermissions`.
 */
const warnedUnknownPermissions = new Set<string>();

export function warnIfUnknownPermission(
  permission: string,
  context: string,
): void {
  if (KNOWN_PERMISSION_SET.has(permission)) return;
  const key = `${context}:${permission}`;
  if (warnedUnknownPermissions.has(key)) return;
  warnedUnknownPermissions.add(key);
  // Security P2-B (Phase 10 review): do NOT enumerate the full
  // `KNOWN_PERMISSIONS` list in the warning. That list IS the host's
  // capability surface; a crafted manifest can trigger this warning to
  // harvest it. Operators who need the canonical list can read
  // `KNOWN_PERMISSIONS` directly or run the CLI help.
  // eslint-disable-next-line no-console
  console.warn(
    `[module-host] ${context} references unknown permission "${permission}" — not on the host's canonical permission list. Likely a typo; grants to this permission will never match a capability.`,
  );
}

/** Reset the warning dedup set — tests only. */
export function resetUnknownPermissionWarningsForTests(): void {
  warnedUnknownPermissions.clear();
}

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
    if (options.requiredPermission) {
      warnIfUnknownPermission(
        options.requiredPermission,
        `capability "${id}"`,
      );
    }
    if (options.methodPermissions) {
      for (const perm of Object.values(options.methodPermissions)) {
        warnIfUnknownPermission(perm, `capability "${id}"`);
      }
    }
    this.entries.set(id, {
      id,
      impl,
      requiredPermission: options.requiredPermission,
      ...(options.methodPermissions !== undefined
        ? { methodPermissions: options.methodPermissions }
        : {}),
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

  /**
   * Phase 10 P2-7 — second-level permission check. Callers that already
   * `resolve()`'d a capability (baseline permission granted) can use this
   * to gate individual methods on stricter permissions. Returns the
   * stricter permission required for `method` (or undefined if the method
   * has no override). The RPC layer uses this to reject calls like
   * `devtools.clear()` from a read-only-permissioned module.
   */
  requiredPermissionForMethod(id: string, method: string): string | undefined {
    return this.entries.get(id)?.methodPermissions?.[method];
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  describe(id: string): CapabilityDescriptor | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    return {
      id: entry.id,
      ...(entry.requiredPermission !== undefined
        ? { requiredPermission: entry.requiredPermission }
        : {}),
      ...(entry.methodPermissions !== undefined
        ? { methodPermissions: entry.methodPermissions }
        : {}),
    };
  }

  describeAll(): CapabilityDescriptor[] {
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      ...(e.requiredPermission !== undefined
        ? { requiredPermission: e.requiredPermission }
        : {}),
      ...(e.methodPermissions !== undefined
        ? { methodPermissions: e.methodPermissions }
        : {}),
    }));
  }
}
