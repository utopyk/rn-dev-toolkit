import type { ModuleManifest } from "@rn-dev/module-sdk";
import type { CapabilityRegistry } from "./capabilities.js";
import type { ModuleRpc } from "./rpc.js";

export const HostRpcErrorCode = {
  NOT_FOUND_OR_DENIED: "HOST_CAPABILITY_NOT_FOUND_OR_DENIED",
  METHOD_NOT_FOUND: "HOST_METHOD_NOT_FOUND",
  MALFORMED_PARAMS: "HOST_MALFORMED_PARAMS",
} as const;

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
  const grantedPermissions = manifest.permissions ?? [];

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

    const fn = impl[params.method];
    if (typeof fn !== "function") {
      throw new Error(
        `${HostRpcErrorCode.METHOD_NOT_FOUND}: method "${params.method}" not found on capability "${params.capabilityId}"`,
      );
    }

    return await (fn as (...a: unknown[]) => unknown).apply(impl, args);
  });
}
