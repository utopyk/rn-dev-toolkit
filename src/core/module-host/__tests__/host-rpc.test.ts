import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { ModuleManifest } from "@rn-dev/module-sdk";
import { CapabilityRegistry } from "../capabilities.js";
import { ModuleRpc } from "../rpc.js";
import {
  attachHostRpc,
  HostRpcErrorCode,
  resetPermissionAliasWarningsForTests,
} from "../host-rpc.js";

// ---------------------------------------------------------------------------
// Harness — in-memory host/module rpc pair (matches rpc.test.ts)
// ---------------------------------------------------------------------------

interface Pair {
  host: ModuleRpc;
  module: ModuleRpc;
  teardown: () => void;
}

function pair(): Pair {
  const hostToModule = new PassThrough();
  const moduleToHost = new PassThrough();
  const host = new ModuleRpc({
    readable: moduleToHost,
    writable: hostToModule,
  });
  const module = new ModuleRpc({
    readable: hostToModule,
    writable: moduleToHost,
  });
  host.listen();
  module.listen();
  return {
    host,
    module,
    teardown: () => {
      host.dispose();
      module.dispose();
      hostToModule.destroy();
      moduleToHost.destroy();
    },
  };
}

let active: Pair | null = null;

afterEach(() => {
  active?.teardown();
  active = null;
});

function manifestWith(permissions: string[] = []): ModuleManifest {
  return {
    id: "fixture",
    version: "0.1.0",
    hostRange: ">=0.1.0",
    scope: "per-worktree",
    permissions,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("attachHostRpc — host/call", () => {
  it("resolves a capability and invokes the named method with args", async () => {
    active = pair();
    const registry = new CapabilityRegistry();
    registry.register("math", {
      add: (a: number, b: number) => a + b,
    });

    attachHostRpc(active.host, manifestWith(), registry);

    const result = await active.module.sendRequest<
      { capabilityId: string; method: string; args: unknown[] },
      number
    >("host/call", { capabilityId: "math", method: "add", args: [2, 3] });
    expect(result).toBe(5);
  });

  it("awaits async capability methods", async () => {
    active = pair();
    const registry = new CapabilityRegistry();
    registry.register("async-cap", {
      compute: async (n: number) => {
        await new Promise((r) => setTimeout(r, 5));
        return n * 10;
      },
    });
    attachHostRpc(active.host, manifestWith(), registry);

    const result = await active.module.sendRequest<
      unknown,
      number
    >("host/call", {
      capabilityId: "async-cap",
      method: "compute",
      args: [7],
    });
    expect(result).toBe(70);
  });

  it("rejects with NOT_FOUND_OR_DENIED when the capability is unknown", async () => {
    active = pair();
    const registry = new CapabilityRegistry();
    attachHostRpc(active.host, manifestWith(), registry);

    const err = await active.module
      .sendRequest("host/call", {
        capabilityId: "ghost",
        method: "x",
        args: [],
      })
      .catch((e: unknown) => e);
    expect(String(err)).toContain(HostRpcErrorCode.NOT_FOUND_OR_DENIED);
  });

  it("rejects with NOT_FOUND_OR_DENIED when the module lacks the required permission", async () => {
    active = pair();
    const registry = new CapabilityRegistry();
    registry.register(
      "secret",
      { read: () => "classified" },
      { requiredPermission: "secret:read" },
    );
    attachHostRpc(active.host, manifestWith([]), registry);

    const err = await active.module
      .sendRequest("host/call", {
        capabilityId: "secret",
        method: "read",
        args: [],
      })
      .catch((e: unknown) => e);
    expect(String(err)).toContain(HostRpcErrorCode.NOT_FOUND_OR_DENIED);
  });

  it("resolves when the module HAS the required permission", async () => {
    active = pair();
    const registry = new CapabilityRegistry();
    registry.register(
      "secret",
      { read: () => "classified" },
      { requiredPermission: "secret:read" },
    );
    attachHostRpc(active.host, manifestWith(["secret:read"]), registry);

    const result = await active.module.sendRequest<unknown, string>(
      "host/call",
      { capabilityId: "secret", method: "read", args: [] },
    );
    expect(result).toBe("classified");
  });

  it("rejects with METHOD_NOT_FOUND when the capability lacks the requested method", async () => {
    active = pair();
    const registry = new CapabilityRegistry();
    registry.register("math", { add: (a: number, b: number) => a + b });
    attachHostRpc(active.host, manifestWith(), registry);

    const err = await active.module
      .sendRequest("host/call", {
        capabilityId: "math",
        method: "subtract",
        args: [],
      })
      .catch((e: unknown) => e);
    expect(String(err)).toContain(HostRpcErrorCode.METHOD_NOT_FOUND);
  });

  it("propagates handler throws as rejected RPC calls", async () => {
    active = pair();
    const registry = new CapabilityRegistry();
    registry.register("broken", {
      explode: () => {
        throw new Error("boom");
      },
    });
    attachHostRpc(active.host, manifestWith(), registry);

    await expect(
      active.module.sendRequest("host/call", {
        capabilityId: "broken",
        method: "explode",
        args: [],
      }),
    ).rejects.toThrow(/boom/);
  });

  it("rejects with MALFORMED_PARAMS when params miss capabilityId/method", async () => {
    active = pair();
    const registry = new CapabilityRegistry();
    attachHostRpc(active.host, manifestWith(), registry);

    const err = await active.module
      .sendRequest("host/call", { method: "x", args: [] })
      .catch((e: unknown) => e);
    expect(String(err)).toContain(HostRpcErrorCode.MALFORMED_PARAMS);
  });

  // ---------------------------------------------------------------------------
  // Phase 10 P2-7 — per-method permission gate + umbrella alias expansion
  // ---------------------------------------------------------------------------

  describe("per-method permission gate (methodPermissions)", () => {
    beforeEach(() => {
      resetPermissionAliasWarningsForTests();
    });

    it("allows a read-only method with the read permission", async () => {
      active = pair();
      const registry = new CapabilityRegistry();
      registry.register(
        "devtools",
        {
          status: () => ({ mode: "ok" }),
          clear: () => ({ cleared: true }),
        },
        {
          requiredPermission: "devtools:capture:read",
          methodPermissions: {
            status: "devtools:capture:read",
            clear: "devtools:capture:mutate",
          },
        },
      );
      attachHostRpc(
        active.host,
        manifestWith(["devtools:capture:read"]),
        registry,
      );

      const result = await active.module.sendRequest<unknown, { mode: string }>(
        "host/call",
        { capabilityId: "devtools", method: "status", args: [] },
      );
      expect(result).toEqual({ mode: "ok" });
    });

    it("rejects a mutating method from a read-only-permissioned module with METHOD_DENIED", async () => {
      active = pair();
      const registry = new CapabilityRegistry();
      registry.register(
        "devtools",
        {
          status: () => ({ mode: "ok" }),
          clear: () => ({ cleared: true }),
        },
        {
          requiredPermission: "devtools:capture:read",
          methodPermissions: {
            status: "devtools:capture:read",
            clear: "devtools:capture:mutate",
          },
        },
      );
      attachHostRpc(
        active.host,
        manifestWith(["devtools:capture:read"]),
        registry,
      );

      const err = await active.module
        .sendRequest("host/call", {
          capabilityId: "devtools",
          method: "clear",
          args: [],
        })
        .catch((e: unknown) => e);
      expect(String(err)).toContain(HostRpcErrorCode.METHOD_DENIED);
      expect(String(err)).toContain("devtools:capture:mutate");
    });

    it("allows both methods when the module holds both granular permissions", async () => {
      active = pair();
      const registry = new CapabilityRegistry();
      registry.register(
        "devtools",
        { clear: () => ({ cleared: true }) },
        {
          requiredPermission: "devtools:capture:read",
          methodPermissions: { clear: "devtools:capture:mutate" },
        },
      );
      attachHostRpc(
        active.host,
        manifestWith([
          "devtools:capture:read",
          "devtools:capture:mutate",
        ]),
        registry,
      );

      const result = await active.module.sendRequest<
        unknown,
        { cleared: boolean }
      >("host/call", {
        capabilityId: "devtools",
        method: "clear",
        args: [],
      });
      expect(result).toEqual({ cleared: true });
    });

    it("umbrella `devtools:capture` alias expands to read + mutate during grace period", async () => {
      active = pair();
      const registry = new CapabilityRegistry();
      registry.register(
        "devtools",
        { clear: () => ({ cleared: true }) },
        {
          requiredPermission: "devtools:capture:read",
          methodPermissions: { clear: "devtools:capture:mutate" },
        },
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        attachHostRpc(
          active.host,
          manifestWith(["devtools:capture"]),
          registry,
        );

        const result = await active.module.sendRequest<
          unknown,
          { cleared: boolean }
        >("host/call", {
          capabilityId: "devtools",
          method: "clear",
          args: [],
        });
        expect(result).toEqual({ cleared: true });
        expect(warn).toHaveBeenCalledWith(
          expect.stringMatching(/legacy permission "devtools:capture"/),
        );
      } finally {
        warn.mockRestore();
      }
    });
  });
});
