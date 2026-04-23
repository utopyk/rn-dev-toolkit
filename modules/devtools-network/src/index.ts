// devtools-network subprocess entry. Spawned by the rn-dev host via
// `node dist/index.js` after `@rn-dev-modules/devtools-network` is
// installed into `~/.rn-dev/modules/devtools-network/`.
//
// Manifest-loaded: the host reads `rn-dev-module.json` for MCP tool
// contributions; `runModule()` registers exactly those names so manifest
// and runtime can't drift.
//
// Data path: every tool call resolves the `devtools` host capability
// (registered at `startServicesAsync` time) and round-trips through
// vscode-jsonrpc `host/call` back to the daemon's `DevToolsManager`.
// The S5 body-redaction gate is the module's `captureBodies` config
// value — OFF by default.
//
// All tool wire names carry the 3p `<moduleId>__` prefix
// (`devtools-network__*`). Agents that used the previous built-in
// names (`rn-dev/devtools-network-*`) should re-discover tools via
// `tools/listChanged`; the names won't match 1:1.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runModule,
  type ModuleManifest,
  type ModuleToolContext,
} from "@rn-dev/module-sdk";
import {
  clear,
  get,
  list,
  selectTarget,
  status,
  type ClearArgs,
  type GetArgs,
  type ListArgs,
  type NetworkCursor,
  type SelectTargetArgs,
  type StatusArgs,
} from "./tools.js";

export const MODULE_ID = "devtools-network" as const;

// ---------------------------------------------------------------------------
// Arg narrowing
//
// The SDK types every tool handler's args as `Record<string, unknown>` so
// the wire contract stays typed only at the JSON-Schema boundary. The
// module's handler functions want precise shapes. Each `toXArgs` coerces
// the incoming `Record<string, unknown>` into the module's handler shape,
// pulling fields defensively with runtime narrowing. MCP validates the
// schema upstream, but a direct unix-socket poke or a schema mismatch
// must not blow up the handler — narrow, then dispatch.
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function strArr(args: Args, key: string): string[] | undefined {
  const v = args[key];
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((s): s is string => typeof s === "string" && s.length > 0);
  return out.length > 0 ? out : undefined;
}

function statusRange(args: Args): [number, number] | undefined {
  const v = args["statusRange"];
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const a = v[0];
  const b = v[1];
  if (typeof a !== "number" || !Number.isFinite(a)) return undefined;
  if (typeof b !== "number" || !Number.isFinite(b)) return undefined;
  return [a, b];
}

function cursor(args: Args): NetworkCursor | undefined {
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
  const urlRegex = str(args, "urlRegex");
  const methods = strArr(args, "methods");
  const range = statusRange(args);
  const since = cursor(args);
  const limit = args["limit"];
  if (wk !== undefined) out.worktree = wk;
  if (urlRegex !== undefined) out.urlRegex = urlRegex;
  if (methods !== undefined) out.methods = methods;
  if (range !== undefined) out.statusRange = range;
  if (since !== undefined) out.since = since;
  if (typeof limit === "number") out.limit = limit;
  return out;
}

function toGetArgs(args: Args): GetArgs {
  const requestId = str(args, "requestId");
  if (requestId === undefined) {
    throw new Error("devtools-network__get: requestId is required");
  }
  return { worktree: str(args, "worktree"), requestId };
}

function toSelectTargetArgs(args: Args): SelectTargetArgs {
  const targetId = str(args, "targetId");
  if (targetId === undefined) {
    throw new Error("devtools-network__select-target: targetId is required");
  }
  return { worktree: str(args, "worktree"), targetId };
}

function toClearArgs(args: Args): ClearArgs {
  return { worktree: str(args, "worktree") };
}

async function loadManifest(entryDir: string): Promise<ModuleManifest> {
  const manifestPath = join(entryDir, "..", "rn-dev-module.json");
  const raw = await readFile(manifestPath, "utf-8");
  return JSON.parse(raw) as ModuleManifest;
}

const invokedAsEntry =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  /devtools-network[\\/](dist|src)[\\/]index\.(js|ts)$/.test(process.argv[1]);

if (invokedAsEntry) {
  const entryDir = dirname(fileURLToPath(import.meta.url));
  const manifest = await loadManifest(entryDir);

  runModule({
    manifest,
    tools: {
      "devtools-network__status": (args: Args, ctx: ModuleToolContext) =>
        status(toStatusArgs(args), ctx),
      "devtools-network__list": (args: Args, ctx: ModuleToolContext) =>
        list(toListArgs(args), ctx),
      "devtools-network__get": (args: Args, ctx: ModuleToolContext) =>
        get(toGetArgs(args), ctx),
      "devtools-network__select-target": (args: Args, ctx: ModuleToolContext) =>
        selectTarget(toSelectTargetArgs(args), ctx),
      "devtools-network__clear": (args: Args, ctx: ModuleToolContext) =>
        clear(toClearArgs(args), ctx),
    },
    activate: (ctx) => {
      const raw = (ctx.config as { captureBodies?: unknown }).captureBodies;
      ctx.log.info("devtools-network activated", {
        captureBodies: raw === true,
      });
    },
  });
}
