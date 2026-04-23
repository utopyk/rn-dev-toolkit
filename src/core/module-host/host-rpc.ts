import type { ModuleManifest } from "@rn-dev/module-sdk";
import type { CapabilityRegistry } from "./capabilities.js";
import type { ModuleRpc } from "./rpc.js";

export const HostRpcErrorCode = {
  NOT_FOUND_OR_DENIED: "HOST_CAPABILITY_NOT_FOUND_OR_DENIED",
  METHOD_NOT_FOUND: "HOST_METHOD_NOT_FOUND",
  MALFORMED_PARAMS: "HOST_MALFORMED_PARAMS",
  METHOD_DENIED: "HOST_METHOD_DENIED",
} as const;

/**
 * Phase 10 P2-7 — permission aliases. Map a legacy umbrella permission to
 * the set it now grants, so v1 manifests keep working during the grace
 * period while we migrate 3p modules to declare the granular permissions
 * explicitly. Aliases expand at `host/call` time (not at register time) —
 * the capability registry stores the real permission names; the
 * RPC layer widens the granted set for modules still using the umbrella.
 */
const PERMISSION_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "devtools:capture": ["devtools:capture:read", "devtools:capture:mutate"],
};

let warnedAliases = new Set<string>();

function expandPermissionAliases(
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

/** Reset the warning set — tests only. */
export function resetPermissionAliasWarningsForTests(): void {
  warnedAliases = new Set<string>();
}

export type HostRpcErrorCodeValue =
  (typeof HostRpcErrorCode)[keyof typeof HostRpcErrorCode];

interface HostCallParams {
  capabilityId: string;
  method: string;
  args: unknown[];
}

/**
 * Register the `host/call` RPC handler on a managed module's rpc connection.
 *
 * Wire contract: caller sends `{ capabilityId, method, args }`, receives the
 * capability method's return value (or a rejected promise). Resolution uses
 * the module's declared `permissions[]` — modules without the right
 * permission get the same error as a nonexistent capability, so they can't
 * probe the registry for permission-gated IDs.
 */
export function attachHostRpc(
  rpc: ModuleRpc,
  manifest: ModuleManifest,
  capabilities: CapabilityRegistry,
): void {
  const grantedPermissions = expandPermissionAliases(
    manifest.permissions ?? [],
    manifest.id,
  );

  rpc.onRequest<HostCallParams, unknown>("host/call", async (params) => {
    if (
      !params ||
      typeof params.capabilityId !== "string" ||
      typeof params.method !== "string"
    ) {
      throw new Error(
        `${HostRpcErrorCode.MALFORMED_PARAMS}: host/call requires { capabilityId, method, args }`,
      );
    }
    const args = Array.isArray(params.args) ? params.args : [];

    const impl = capabilities.resolve<Record<string, unknown>>(
      params.capabilityId,
      grantedPermissions,
    );
    if (!impl) {
      throw new Error(
        `${HostRpcErrorCode.NOT_FOUND_OR_DENIED}: capability "${params.capabilityId}" not found or not granted`,
      );
    }

    // Phase 10 P2-7 — per-method permission gate. Baseline permission
    // got the caller past `resolve()`; stricter methods (e.g.
    // devtools.clear → devtools:capture:mutate) enforce an extra check
    // here. Returns the same error shape as baseline denial so the
    // module can log once and recover.
    const methodPerm = capabilities.requiredPermissionForMethod(
      params.capabilityId,
      params.method,
    );
    if (methodPerm && !grantedPermissions.includes(methodPerm)) {
      throw new Error(
        `${HostRpcErrorCode.METHOD_DENIED}: method "${params.method}" on capability "${params.capabilityId}" requires permission "${methodPerm}"`,
      );
    }

    const fn = impl[params.method];
    if (typeof fn !== "function") {
      throw new Error(
        `${HostRpcErrorCode.METHOD_NOT_FOUND}: method "${params.method}" not found on capability "${params.capabilityId}"`,
      );
    }

    return await (fn as (...a: unknown[]) => unknown).apply(impl, args);
  });
}
