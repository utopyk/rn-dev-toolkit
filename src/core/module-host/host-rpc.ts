import type { ModuleManifest } from "@rn-dev/module-sdk";
import type { CapabilityRegistry } from "./capabilities.js";
import { expandPermissionAliases } from "./capabilities.js";
import type { ModuleRpc } from "./rpc.js";

export const HostRpcErrorCode = {
  NOT_FOUND_OR_DENIED: "HOST_CAPABILITY_NOT_FOUND_OR_DENIED",
  METHOD_NOT_FOUND: "HOST_METHOD_NOT_FOUND",
  MALFORMED_PARAMS: "HOST_MALFORMED_PARAMS",
  METHOD_DENIED: "HOST_METHOD_DENIED",
} as const;

// Phase 11 Arch P2 — `PERMISSION_ALIASES` + `expandPermissionAliases`
// moved to `./capabilities.js` (alongside `KNOWN_PERMISSIONS`) so the
// alias table lives with the rest of the permission policy, not in the
// transport layer. `resetPermissionAliasWarningsForTests` is re-exported
// from `./capabilities.js` too; tests that used to import it from here
// should update their imports.

export type HostRpcErrorCodeValue =
  (typeof HostRpcErrorCode)[keyof typeof HostRpcErrorCode];

/**
 * True iff `method` is declared directly on `impl` or on a class
 * prototype in the chain (excluding `Object.prototype`). Protects the
 * RPC dispatcher from reaching Object.prototype members through the
 * method-lookup hole. See host-rpc's `host/call` handler for details.
 */
function isCapabilityMethod(
  impl: Record<string, unknown>,
  method: string,
): boolean {
  let obj: object | null = impl;
  while (obj !== null && obj !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(obj, method)) return true;
    obj = Object.getPrototypeOf(obj);
  }
  return false;
}

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

    // Phase 11 Security review P2 — prototype-walk guard. Without this,
    // a module with a valid capability grant can call `host/call` with
    // method `"constructor"` / `"toString"` / `"hasOwnProperty"` etc.
    // and reach `Object.prototype` methods (class-instance capabilities
    // inherit from it). Walk the impl's prototype chain, stopping at
    // `Object.prototype` — class-instance methods (one hop up) resolve,
    // Object.prototype methods don't. Not materially exploitable today
    // (those methods are non-destructive) but pads the RPC surface.
    if (!isCapabilityMethod(impl, params.method)) {
      throw new Error(
        `${HostRpcErrorCode.METHOD_NOT_FOUND}: method "${params.method}" not found on capability "${params.capabilityId}"`,
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
