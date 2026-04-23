// metro-logs subprocess entry. Spawned by the rn-dev host via
// `node dist/index.js` after `@rn-dev-modules/metro-logs` is installed
// into `~/.rn-dev/modules/metro-logs/`.
//
// Manifest-loaded: the host reads `rn-dev-module.json` for MCP tool
// contributions; `runModule()` registers exactly those names so manifest
// and runtime can't drift.
//
// Data path: every tool call resolves the `metro-logs` host capability
// (registered at `startServicesAsync` time) and round-trips through
// vscode-jsonrpc `host/call` back to the daemon's `MetroLogsStore`.
// The ring buffer holds every stdout/stderr line emitted by
// MetroManager; `clear()` bumps the epoch so held cursors go stale.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  runModule,
  type ModuleManifest,
  type ModuleToolContext,
} from "@rn-dev/module-sdk";
import {
  clear,
  list,
  status,
  type ClearArgs,
  type ListArgs,
  type StatusArgs,
} from "./tools.js";
import type { MetroLogsCursor, MetroLogStream } from "./types.js";

export const MODULE_ID = "metro-logs" as const;

// ---------------------------------------------------------------------------
// Arg narrowing
//
// Runtime narrowers for the JSON-Schema-validated wire args. MCP
// validates against the manifest's inputSchema before dispatch, but a
// direct unix-socket poke or a schema mismatch must not blow up the
// handler. Mirrors the Phase 10 P2-10 typed-wrapper pattern.
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function stream(args: Args): MetroLogStream | undefined {
  const v = args["stream"];
  if (v === "stdout" || v === "stderr") return v;
  return undefined;
}

function cursor(args: Args): MetroLogsCursor | undefined {
  const v = args["since"];
  if (!v || typeof v !== "object") return undefined;
  const c = v as { bufferEpoch?: unknown; sequence?: unknown };
  if (typeof c.bufferEpoch !== "number" || !Number.isFinite(c.bufferEpoch)) {
    return undefined;
  }
  if (typeof c.sequence !== "number" || !Number.isFinite(c.sequence)) {
    return undefined;
  }
  return { bufferEpoch: c.bufferEpoch, sequence: c.sequence };
}

function toStatusArgs(args: Args): StatusArgs {
  return { worktree: str(args, "worktree") };
}

function toListArgs(args: Args): ListArgs {
  const out: ListArgs = {};
  const wk = str(args, "worktree");
  const sub = str(args, "substring");
  const str2 = stream(args);
  const since = cursor(args);
  const limit = args["limit"];
  if (wk !== undefined) out.worktree = wk;
  if (sub !== undefined) out.substring = sub;
  if (str2 !== undefined) out.stream = str2;
  if (since !== undefined) out.since = since;
  if (typeof limit === "number") out.limit = limit;
  return out;
}

function toClearArgs(args: Args): ClearArgs {
  return { worktree: str(args, "worktree") };
}

async function loadManifest(entryDir: string): Promise<ModuleManifest> {
  const manifestPath = join(entryDir, "..", "rn-dev-module.json");
  const raw = await readFile(manifestPath, "utf-8");
  return JSON.parse(raw) as ModuleManifest;
}

// Canonical Node-ESM idiom (Phase 10 P3-16) — compare the file:// URL of
// our own module against the CLI-entry path. Works under any hoisted
// layout; the older regex-on-argv[1] check silently refused to boot if
// the module was relocated.
const invokedAsEntry =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsEntry) {
  const entryDir = dirname(fileURLToPath(import.meta.url));
  const manifest = await loadManifest(entryDir);

  runModule({
    manifest,
    tools: {
      "metro-logs__status": (args: Args, ctx: ModuleToolContext) =>
        status(toStatusArgs(args), ctx),
      "metro-logs__list": (args: Args, ctx: ModuleToolContext) =>
        list(toListArgs(args), ctx),
      "metro-logs__clear": (args: Args, ctx: ModuleToolContext) =>
        clear(toClearArgs(args), ctx),
    },
    activate: (ctx) => {
      ctx.log.info("metro-logs activated");
    },
  });
}
