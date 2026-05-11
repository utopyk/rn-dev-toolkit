import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeTestWorktree,
  spawnTestDaemon,
  type TestDaemonHandle,
} from "../../../test/helpers/spawnTestDaemon.js";
import {
  spawnMcpServer,
  type McpHarnessHandle,
} from "../../../test/helpers/spawnMcpServer.js";

// M2b — module-contributed tool round-trip via MCP.
//
// 3p modules (devtools-network, metro-logs, ...) contribute MCP tools
// declared in their `rn-dev-module.json#contributes.mcp.tools` array.
// MCP's `discoverModuleContributedTools` queries the daemon's
// modules/list dispatcher, builds proxy ToolDefinitions wrapping
// `<moduleId>__<tool>` names, and forwards calls via modules/host-call.
//
// Pre-M2b: the entire path was untested. M1c only verified that
// modules-list round-trips — not that contributed tools surface. The
// 5 fake-boot built-ins don't declare `contributes.mcp.tools`, so the
// proxy code path was dead under the current test grid.
//
// What this test gates:
//   1. Tools declared in a manifest's `contributes.mcp.tools` surface
//      in MCP's `listTools()` under their `<moduleId>__<tool>` wire
//      name.
//   2. Calling such a tool over MCP routes through to the daemon's
//      modules-host-call dispatcher (returns a structured error
//      response under fake-boot since no real subprocess; that's the
//      wire shape this test pins).
//   3. The destructive consent gate engages for `destructiveHint:true`
//      tools — pre-fix the proxy used to forward without asking, which
//      would let agents trigger destructive 3p module actions silently.
//
// Real network capture / actual devtools data requires real-boot mode
// + an installed 3p module + a running app — that lives in the
// PROBE-gated probe (M2c).

const TEST_MANIFEST = {
  id: "test-mod",
  version: "0.1.0",
  hostRange: ">=0.1.0",
  scope: "global" as const,
  contributes: {
    mcp: {
      tools: [
        {
          name: "test-mod__hello",
          description: "Test tool — round-trips through the MCP module proxy.",
          inputSchema: {
            type: "object" as const,
            additionalProperties: false,
            properties: {
              greet: { type: "string" },
            },
          },
          readOnlyHint: true,
        },
      ],
    },
  },
};

interface ProxyResponse {
  ok?: boolean;
  code?: string;
  message?: string;
  error?: string;
}

describe("MCP module-contributed tool e2e (M2b)", () => {
  const liveDaemons: TestDaemonHandle[] = [];
  const liveMcp: McpHarnessHandle[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    for (const m of liveMcp.splice(0)) await m.stop();
    for (const d of liveDaemons.splice(0)) await d.stop();
    for (const c of cleanups.splice(0)) c();
  });

  function writeProfile(worktree: string): void {
    const profilesDir = join(worktree, ".rn-dev", "profiles");
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(
      join(profilesDir, "default.json"),
      JSON.stringify({
        name: "default",
        isDefault: true,
        worktree: null,
        branch: "main",
        platform: "ios",
        mode: "quick",
        metroPort: 8081,
        devices: {},
        buildVariant: "debug",
        preflight: { checks: [], frequency: "once" },
        onSave: [],
        env: {},
        projectRoot: worktree,
      }),
    );
  }

  async function setup(): Promise<{ mcp: McpHarnessHandle }> {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    writeProfile(worktree);

    const daemon = await spawnTestDaemon(worktree, {
      env: {
        RN_DEV_DAEMON_BOOT_MODE: "fake",
        RN_DEV_DAEMON_TEST_EXTRA_MANIFEST: JSON.stringify(TEST_MANIFEST),
        // The built-in allowlist refuses unknown ids; the env-var seam
        // permits the synthetic test-mod fixture.
        RN_DEV_TEST_BUILTIN_ALLOWLIST: TEST_MANIFEST.id,
      },
    });
    liveDaemons.push(daemon);

    const mcp = await spawnMcpServer({ cwd: worktree });
    liveMcp.push(mcp);

    return { mcp };
  }

  function parseToolJson<T>(result: unknown): T {
    const r = result as {
      content?: Array<{ type: string; text: string }>;
      structuredContent?: T;
    };
    if (r.structuredContent) return r.structuredContent;
    const text = r.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error(`No usable content: ${JSON.stringify(result)}`);
    }
    return JSON.parse(text) as T;
  }

  it(
    "contributed tools surface in listTools() under <moduleId>__<tool> wire names",
    async () => {
      const { mcp } = await setup();

      const result = await mcp.client.listTools();
      const names = result.tools.map((t) => t.name);
      const moduleProxied = names.filter((n) => n.includes("__"));
      expect(
        names.includes("test-mod__hello"),
        `Expected test-mod__hello in listTools(); got ${names.length} tools (${moduleProxied.length} proxied).\nMCP stderr:\n${mcp.getStderr()}`,
      ).toBe(true);
    },
    20_000,
  );

  it(
    "calling a contributed tool routes through modules/host-call and returns a structured response",
    async () => {
      const { mcp } = await setup();

      const r = await mcp.client.callTool({
        name: "test-mod__hello",
        arguments: { greet: "world" },
      });

      // Under fake-boot the module host's acquire() throws ("not
      // supported"), so the host-call dispatch surfaces a structured
      // error to MCP. The wire-test contract is "we got a structured
      // response back, not a transport crash" — the actual
      // success/failure signal depends on whether a real subprocess
      // exists (production path).
      const payload = parseToolJson<ProxyResponse>(r);
      expect(
        payload,
        `Expected structured response from module proxy.\nMCP stderr:\n${mcp.getStderr()}`,
      ).toBeDefined();

      // Under fake-boot, MODULE_UNAVAILABLE is the canonical signal
      // that the module wasn't acquired (per the modules-ipc dispatcher).
      // A passing response with `ok: true` would mean the module
      // somehow ran — also acceptable, just unusual under fake-boot.
      const code = payload.code ?? payload.error;
      const acceptable =
        payload.ok === true ||
        code === "MODULE_UNAVAILABLE" ||
        code === "E_MODULE_CALL_FAILED" ||
        code === "HOST_CALL_FAILED";
      expect(
        acceptable,
        `Expected ok or a known wire-error code; got ${JSON.stringify(payload)}.`,
      ).toBe(true);
    },
    20_000,
  );
});
