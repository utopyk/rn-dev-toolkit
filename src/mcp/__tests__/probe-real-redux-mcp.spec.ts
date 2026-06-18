import { afterEach, describe, expect, it } from "vitest";
import { spawnMcpServer, type McpHarnessHandle } from "../../../test/helpers/spawnMcpServer.js";

// Real-boot probe (env-gated) for the redux module's end-to-end capture
// through MCP. Codifies the 2026-06-18 manual verification:
//   real acme app on an Android emulator → vendored rnDevReduxEnhancer
//   → WS ingest (metroPort+4000) → ReduxStore → redux host capability
//   → redux module subprocess → redux__* MCP tools (redacted).
//
// PREREQUISITES (the probe does NOT build/launch — it observes a session
// that is already up and streaming):
//   - a rn-dev daemon session for ACME is running (Metro + redux ingest);
//   - the acme app is built with the enhancer vendored into the store
//     (src/dev/rn-dev-redux-enhancer.ts) and running on the device/emulator;
//   - `adb reverse tcp:<metroPort+4000>` is set for an emulator over adb.
//
// Run:  PROBE=1 npx vitest run src/mcp/__tests__/probe-real-redux-mcp.spec.ts
//
// PROBE-gated like its sibling MCP probes (probe-real-android-multi,
// probe-cold-start-mcp): the `it` is `.skipIf(!ENABLED)` so it is INERT in
// the normal `npx vitest run` gate and only runs when explicitly enabled.
// Without the gate it would poll for 90s and fail whenever no live app is
// streaming — turning an env-dependent probe into a flaky suite failure.
const ENABLED =
  process.env.PROBE === "1" ||
  process.env.PROBE_ACME === "1" ||
  process.env.REAL_BOOT_SMOKE === "1";
const ACME =
  process.env.RN_DEV_REAL_BOOT_TARGET ?? "/Users/martincouso/Documents/GitHub/acme-mobile-app";

interface ReduxStatus { bufferSize?: number; meta?: { hasState?: boolean; redactionMode?: string } }
interface ReduxActions { entries?: Array<{ sequence: number; type: string; payload: unknown }> }
interface ReduxState { value?: unknown; present?: boolean }

function parse<T>(result: unknown): T {
  const r = result as { content?: Array<{ type: string; text: string }>; structuredContent?: T };
  if (r.structuredContent) return r.structuredContent;
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error(`no usable content: ${JSON.stringify(result)}`);
  return JSON.parse(text) as T;
}

describe("MCP real-boot probe — redux capture", () => {
  const live: McpHarnessHandle[] = [];
  afterEach(async () => {
    for (const m of live.splice(0)) await m.stop();
  });

  it.skipIf(!ENABLED)(
    "redux__* returns the live app's actions + state, redacted",
    async () => {
      const mcp = await spawnMcpServer({ cwd: ACME });
      live.push(mcp);

      // Poll for the enhancer to have streamed something.
      let status: ReduxStatus = {};
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5_000));
        status = parse<ReduxStatus>(
          await mcp.client.callTool({ name: "redux__status", arguments: {} }),
        );
        if ((status.bufferSize ?? 0) > 0) break;
      }
      expect(
        status.bufferSize ?? 0,
        `no actions captured — is the app running with the enhancer + adb reverse set? stderr:\n${mcp.getStderr().slice(-1500)}`,
      ).toBeGreaterThan(0);
      expect(status.meta?.hasState).toBe(true);

      const actions = parse<ReduxActions>(
        await mcp.client.callTool({ name: "redux__actions", arguments: { limit: 30 } }),
      );
      expect((actions.entries ?? []).length).toBeGreaterThan(0);
      // Action types are never redacted.
      expect(actions.entries!.every((a) => typeof a.type === "string" && a.type.length > 0)).toBe(true);

      const state = parse<ReduxState>(
        await mcp.client.callTool({ name: "redux__state", arguments: {} }),
      );
      expect(state.present).toBe(true);
      // Redaction must hold somewhere in real acme state (auth tokens,
      // company tokens, phone numbers …). Assert the marker appears.
      expect(JSON.stringify(state.value)).toContain("[redacted]");
    },
    120_000,
  );
});
