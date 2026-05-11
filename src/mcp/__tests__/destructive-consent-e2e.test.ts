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

// M1e — destructive consent gate + --allow-destructive-tools flag.
//
// The MCP server enforces a per-call consent gate on tools marked
// `destructive: true`. `rn-dev/modules-config-set` is the canonical
// destructive built-in: flipping a module's privacy posture (e.g.
// devtools-network captureBodies) is exactly the kind of action an
// agent should not take without explicit confirmation.
//
// Three observable contracts this test gates:
//   1. WITHOUT `--allow-destructive-tools`, calling modules-config-set
//      without `permissionsAccepted` returns E_DESTRUCTIVE_REQUIRES_CONFIRM
//      (isError=true). Catches: consent gate regresses to silent
//      pass-through, which is a security regression.
//   2. WITHOUT the flag but WITH the matching permissionsAccepted entry,
//      the call proceeds past the gate (the daemon-side validation may
//      still reject for other reasons, but we no longer hit the
//      consent error).
//   3. WITH `--allow-destructive-tools`, the gate is bypassed entirely
//      regardless of permissionsAccepted. Catches: argv flag parsing
//      drift (parseFlags) or the flag failing to propagate into
//      buildModulesLifecycleTools.
//
// Together these exercise the full consent pipeline:
//   argv → parseFlags → ctx.flags → buildModulesLifecycleTools closure
//   → handler decision → SDK Client surface

interface ConsentErrorPayload {
  kind?: "error";
  code?: string;
  message?: string;
}

describe("MCP destructive consent gate e2e (M1e)", () => {
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

  async function setup(opts: { mcpFlags?: string[] } = {}): Promise<{
    mcp: McpHarnessHandle;
  }> {
    const { path: worktree, cleanup } = makeTestWorktree();
    cleanups.push(cleanup);
    writeProfile(worktree);

    const daemon = await spawnTestDaemon(worktree, {
      env: { RN_DEV_DAEMON_BOOT_MODE: "fake" },
    });
    liveDaemons.push(daemon);

    const mcp = await spawnMcpServer({ cwd: worktree, flags: opts.mcpFlags });
    liveMcp.push(mcp);

    return { mcp };
  }

  it(
    "modules-config-set without consent returns E_DESTRUCTIVE_REQUIRES_CONFIRM",
    async () => {
      const { mcp } = await setup();

      const r = await mcp.client.callTool({
        name: "rn-dev/modules-config-set",
        arguments: {
          moduleId: "devtools-network",
          patch: { captureBodies: true },
        },
      });

      const isError = (r as { isError?: boolean }).isError;
      const payload = (r as { structuredContent?: ConsentErrorPayload }).structuredContent;

      expect(
        isError,
        `Expected isError=true on the consent-required path. Payload: ${JSON.stringify(payload)}\nMCP stderr:\n${mcp.getStderr()}`,
      ).toBe(true);
      expect(payload?.kind).toBe("error");
      expect(payload?.code).toBe("E_DESTRUCTIVE_REQUIRES_CONFIRM");
      expect(payload?.message).toMatch(/permissionsAccepted/);
    },
    20_000,
  );

  it(
    "modules-config-set with --allow-destructive-tools flag bypasses the consent gate",
    async () => {
      const { mcp } = await setup({ mcpFlags: ["--allow-destructive-tools"] });

      const r = await mcp.client.callTool({
        name: "rn-dev/modules-config-set",
        arguments: {
          moduleId: "this-module-does-not-exist",
          patch: { foo: "bar" },
        },
      });

      // The flag is set, so we MUST NOT see the consent-required error.
      // The daemon will still reject (unknown module), so isError may
      // still be true — but the code/message must come from the
      // daemon-side validation path, not the consent gate.
      const payload = (r as { structuredContent?: ConsentErrorPayload }).structuredContent;
      expect(payload?.code).not.toBe("E_DESTRUCTIVE_REQUIRES_CONFIRM");
    },
    20_000,
  );

  it(
    "modules-config-set with permissionsAccepted bypasses the gate without the flag",
    async () => {
      const { mcp } = await setup();

      const r = await mcp.client.callTool({
        name: "rn-dev/modules-config-set",
        arguments: {
          moduleId: "this-module-does-not-exist",
          patch: { foo: "bar" },
          permissionsAccepted: ["rn-dev/modules-config-set"],
        },
      });

      // Same as above — daemon will reject the unknown module, but the
      // failure must NOT be the consent error.
      const payload = (r as { structuredContent?: ConsentErrorPayload }).structuredContent;
      expect(payload?.code).not.toBe("E_DESTRUCTIVE_REQUIRES_CONFIRM");
    },
    20_000,
  );
});
