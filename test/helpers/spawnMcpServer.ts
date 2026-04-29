import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// MCP-side e2e harness — Bug 6's missing test layer.
//
// `tests/electron-smoke/real-boot.spec.ts` covers Electron behavior end-
// to-end against a live daemon, but until this helper landed the MCP
// surface had no equivalent: the Phase-13.6 test grid only exercised
// `connectToDaemonSession` from inside vitest, never the actual MCP
// stdio server boot path that an agent sees. Bug 6 (`session/log`
// dropped in `routeEventToAdapters`) was invisible to the existing test
// grid for exactly this reason — a bug in the MCP-server-process
// behavior, not in any unit under test.
//
// This helper spawns the real MCP server as a child process via
// `StdioClientTransport`, then returns an SDK `Client` you can drive
// with `callTool` / `listTools`. Pair with `spawnTestDaemon` to wire
// MCP against a fake-boot daemon so tests run fast (~1-2s) and don't
// require Metro/RN tooling. Real-boot variants belong in
// `tests/mcp-smoke/` — env-gated like `real-boot.spec.ts`.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_ENTRY = resolve(REPO_ROOT, "src", "index.tsx");

export interface McpHarnessHandle {
  client: Client;
  /** Tear down the MCP server child process + close the transport. */
  stop: () => Promise<void>;
  /**
   * Cumulative stderr output from the MCP server child process. Useful
   * for diagnosing test failures — a "session-logs returns nothing"
   * failure here usually means MCP failed to connect to the daemon, and
   * stderr is the only place that's visible.
   */
  getStderr: () => string;
}

export interface SpawnMcpServerOptions {
  /**
   * cwd for the MCP server process. The MCP server's `detectProjectRoot`
   * + `ProfileStore` reads + `connectToDaemonSession` all key off this
   * — point at a worktree that has `.rn-dev/profiles/<name>.json` so
   * the MCP server connects to the daemon you've spawned there.
   *
   * Trust note: callers pass paths from `makeTestWorktree()` (mkdtemp).
   * Tests are responsible for not feeding user-supplied paths here —
   * if a future fixture-loader gets a `cwd` from a fixture file, that
   * file becomes a code-execution vector.
   */
  cwd: string;
  /**
   * Optional flags passed as argv. Common: `--enable-module:<id>`,
   * `--allow-destructive-tools`. Mirrors the production CLI surface.
   * Trusted-input only — see `cwd` note.
   */
  flags?: string[];
  /**
   * Extra env vars merged on top of `process.env`. Tests typically pass
   * nothing — the MCP server inherits the daemon's sock path through the
   * shared worktree. Only set this if you specifically need to override
   * `RN_DEV_DAEMON_SOCK` etc.
   */
  env?: Record<string, string>;
}

/**
 * `process.env` is `{ [k: string]: string | undefined }` but the MCP
 * SDK's `StdioServerParameters.env` is `Record<string, string>`. Node's
 * `child_process.spawn` coerces undefined values to the string
 * `"undefined"` — a known footgun. Filter undefined values before
 * handing off. Kieran TS P0 on PR #27.
 */
function inheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export async function spawnMcpServer(
  opts: SpawnMcpServerOptions,
): Promise<McpHarnessHandle> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", CLI_ENTRY, "mcp", ...(opts.flags ?? [])],
    cwd: opts.cwd,
    env: { ...inheritedEnv(), ...(opts.env ?? {}) },
    // "pipe" so test failures get the server's diagnostic output. The
    // SDK's transport reads JSON-RPC frames from stdout only, so noisy
    // stderr from the MCP server (preflight warnings, etc.) doesn't
    // pollute the wire.
    stderr: "pipe",
  });

  const client = new Client(
    { name: "mcp-e2e-harness", version: "0.1.0" },
    { capabilities: {} },
  );

  // Capture stderr so test failures can surface MCP server diagnostics.
  // Without this, a "MCP didn't connect to the daemon" failure is mute.
  let stderrBuf = "";
  // SDK exposes stderr stream via `transport.stderr` — accessible AFTER
  // `start()` runs (which `client.connect` calls internally). We have to
  // attach the listener before start() is called or we miss early
  // output, which is exactly the SDK's documented contract: "If stderr
  // piping was requested, a PassThrough stream is returned _immediately_."
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });

  await client.connect(transport);

  const stop = async (): Promise<void> => {
    await client.close().catch(() => undefined);
  };

  return {
    client,
    stop,
    getStderr: () => stderrBuf,
  };
}
