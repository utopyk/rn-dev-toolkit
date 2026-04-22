#!/usr/bin/env node
// Minimal module subprocess used by integration tests. Previously managed
// its own `vscode-jsonrpc` setup; now uses `runModule()` from the SDK so
// the rewrite doubles as DX validation for third-party authors.
//
// Tools:
//   - tool/ping              → { pong: true, echoed: <args> }
//
// Non-tool RPC methods (registered via `onConnection` escape hatch for
// Phase 2 integration-test compatibility):
//   - echo                   → returns its params verbatim
//   - crash-on-request       → exits with code 42 (supervisor crash path)
//   - sleep (notification)   → noop (hold-open / orphan-prevention tests)
//
// `runModule` owns stdin/stdout framing and the `initialize` / `tool/*`
// routing. The fixture contributes extra fields to the initialize response
// via `onInitialize` so the Phase 2 integration-test assertions survive.
//
// The repo's package.json has "type": "module" so this file is interpreted
// as ESM; the host spawns it with `node <path>` directly.

import { runModule } from "@rn-dev/module-sdk";

const manifest = {
  id: "echo",
  version: "0.1.0",
  hostRange: ">=0.1.0",
  scope: "global",
  contributes: {
    mcp: {
      tools: [
        {
          name: "echo__ping",
          description: "Ping",
          inputSchema: {},
        },
      ],
    },
  },
};

const handle = runModule({
  manifest,
  tools: {
    "echo__ping": (params) => ({ pong: true, echoed: params }),
  },
  onInitialize: (appInfo) => ({
    echoedHostVersion: appInfo.hostVersion,
    echoedCapabilityCount: appInfo.capabilities.length,
  }),
  activate: (ctx) => {
    ctx.log.info("echo fixture ready");
  },
  onConnection: (connection) => {
    connection.onRequest("echo", (params) => params);
    connection.onRequest("crash-on-request", () => {
      process.exit(42);
    });
    connection.onNotification("sleep", () => {
      /* no-op — used by hold-open tests */
    });
  },
});

process.on("SIGTERM", () => {
  void handle.dispose().finally(() => process.exit(0));
});
