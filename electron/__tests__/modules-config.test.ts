import { describe, expect, it, vi } from "vitest";
import {
  handleConfigGet,
  handleConfigSet,
  type ConfigSetAuditEvent,
  type ModulesConfigIpcDeps,
} from "../ipc/modules-config.js";
import type { ModuleHostClient } from "../../src/app/client/module-host-adapter.js";

// Phase 13.4.1 — handleConfigGet/handleConfigSet are now thin wrappers
// around ModuleHostClient RPCs. The deep behavioral coverage (schema
// validation, concurrent-set serialization, moduleEvents emission,
// unknown-module guard) moved to src/app/__tests__/modules-ipc.test.ts
// where `dispatchModulesAction` is exercised directly. This file pins
// the delegation shape:
//   - handleConfigGet forwards { moduleId, scopeUnit } to client.configGet
//   - handleConfigSet forwards the payload to client.configSet + invokes
//     auditConfigSet with sorted patch keys + the daemon's outcome code.
// Anything deeper is a daemon-dispatcher concern.

function makeStubClient(): {
  client: ModuleHostClient;
  configGet: ReturnType<typeof vi.fn>;
  configSet: ReturnType<typeof vi.fn>;
} {
  const configGet = vi.fn();
  const configSet = vi.fn();
  return {
    client: { configGet, configSet } as unknown as ModuleHostClient,
    configGet,
    configSet,
  };
}

describe("electron/modules-config — handleConfigGet", () => {
  it("forwards moduleId + scopeUnit through ModuleHostClient.configGet", async () => {
    const { client, configGet } = makeStubClient();
    configGet.mockResolvedValueOnce({ moduleId: "m", config: { k: "v" } });
    const deps: ModulesConfigIpcDeps = { modulesClient: client };
    const result = await handleConfigGet(deps, {
      moduleId: "m",
      scopeUnit: "wt-1",
    });
    expect(configGet).toHaveBeenCalledWith("m", "wt-1");
    expect(result).toEqual({ moduleId: "m", config: { k: "v" } });
  });

  it("omits scopeUnit when undefined", async () => {
    const { client, configGet } = makeStubClient();
    configGet.mockResolvedValueOnce({ moduleId: "m", config: {} });
    const deps: ModulesConfigIpcDeps = { modulesClient: client };
    await handleConfigGet(deps, { moduleId: "m" });
    expect(configGet).toHaveBeenCalledWith("m", undefined);
  });
});

describe("electron/modules-config — handleConfigSet", () => {
  it("forwards payload through ModuleHostClient.configSet + audits ok outcome with sorted keys", async () => {
    const { client, configSet } = makeStubClient();
    configSet.mockResolvedValueOnce({ kind: "ok", config: { a: 1, b: 2 } });
    const audit: ConfigSetAuditEvent[] = [];
    const deps: ModulesConfigIpcDeps = {
      modulesClient: client,
      auditConfigSet: (event) => audit.push(event),
    };
    const result = await handleConfigSet(deps, {
      moduleId: "m",
      scopeUnit: "wt-1",
      // Keys passed out-of-order — audit sink should receive them sorted.
      patch: { b: 2, a: 1 },
    });
    expect(configSet).toHaveBeenCalledWith({
      moduleId: "m",
      scopeUnit: "wt-1",
      patch: { b: 2, a: 1 },
    });
    expect(result.kind).toBe("ok");
    expect(audit).toEqual([
      {
        moduleId: "m",
        scopeUnit: "wt-1",
        patchKeys: ["a", "b"],
        outcome: "ok",
        code: undefined,
      },
    ]);
  });

  it("surfaces daemon validation errors through the audit sink with the error code", async () => {
    const { client, configSet } = makeStubClient();
    configSet.mockResolvedValueOnce({
      kind: "error",
      code: "E_CONFIG_VALIDATION",
      message: "bad patch",
    });
    const audit: ConfigSetAuditEvent[] = [];
    const deps: ModulesConfigIpcDeps = {
      modulesClient: client,
      auditConfigSet: (event) => audit.push(event),
    };
    const result = await handleConfigSet(deps, {
      moduleId: "m",
      patch: { bad: "x" },
    });
    expect(result.kind).toBe("error");
    expect(audit[0]).toMatchObject({
      moduleId: "m",
      outcome: "error",
      code: "E_CONFIG_VALIDATION",
    });
  });

  it("works without an audit sink (Electron wires it, tests may omit it)", async () => {
    const { client, configSet } = makeStubClient();
    configSet.mockResolvedValueOnce({ kind: "ok", config: {} });
    const deps: ModulesConfigIpcDeps = { modulesClient: client };
    const result = await handleConfigSet(deps, {
      moduleId: "m",
      patch: {},
    });
    expect(result.kind).toBe("ok");
  });

  it("never echoes patch VALUES into the audit event — only keys", async () => {
    const { client, configSet } = makeStubClient();
    configSet.mockResolvedValueOnce({ kind: "ok", config: {} });
    const audit: ConfigSetAuditEvent[] = [];
    const deps: ModulesConfigIpcDeps = {
      modulesClient: client,
      auditConfigSet: (event) => audit.push(event),
    };
    await handleConfigSet(deps, {
      moduleId: "m",
      patch: { apiKey: "sk-supersecret", timeout: 30 },
    });
    expect(audit[0]?.patchKeys).toEqual(["apiKey", "timeout"]);
    // Audit event has no `patch` or `values` field.
    expect(audit[0]).not.toHaveProperty("patch");
    expect(audit[0]).not.toHaveProperty("values");
    expect(JSON.stringify(audit[0])).not.toContain("sk-supersecret");
  });
});
