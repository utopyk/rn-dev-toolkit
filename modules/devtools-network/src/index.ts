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
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  num,
  requireStr,
  ringCursor,
  runModule,
  str,
  strArr,
  type Args,
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
  type SelectTargetArgs,
  type StatusArgs,
} from "./tools.js";

export const MODULE_ID = "devtools-network" as const;

// ---------------------------------------------------------------------------
// Arg narrowing
//
// General-purpose narrowers (`str`, `num`, `strArr`, `ringCursor`,
// `requireStr`, `Args`) live in the SDK — imported via
// `@rn-dev/module-sdk`. The `statusRange` tuple narrower is specific to
// HTTP status-range filters, so it stays local.
// ---------------------------------------------------------------------------

function statusRange(args: Args): [number, number] | undefined {
  const v = args["statusRange"];
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const a = v[0];
  const b = v[1];
  if (typeof a !== "number" || !Number.isFinite(a)) return undefined;
  if (typeof b !== "number" || !Number.isFinite(b)) return undefined;
  return [a, b];
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
  const since = ringCursor(args);
  const limit = num(args, "limit");
  if (wk !== undefined) out.worktree = wk;
  if (urlRegex !== undefined) out.urlRegex = urlRegex;
  if (methods !== undefined) out.methods = methods;
  if (range !== undefined) out.statusRange = range;
  if (since !== undefined) out.since = since;
  if (limit !== undefined) out.limit = limit;
  return out;
}

function toGetArgs(args: Args): GetArgs {
  return {
    worktree: str(args, "worktree"),
    requestId: requireStr(args, "requestId", "devtools-network__get"),
  };
}

function toSelectTargetArgs(args: Args): SelectTargetArgs {
  return {
    worktree: str(args, "worktree"),
    targetId: requireStr(args, "targetId", "devtools-network__select-target"),
  };
}

function toClearArgs(args: Args): ClearArgs {
  return { worktree: str(args, "worktree") };
}

async function loadManifest(entryDir: string): Promise<ModuleManifest> {
  const manifestPath = join(entryDir, "..", "rn-dev-module.json");
  const raw = await readFile(manifestPath, "utf-8");
  return JSON.parse(raw) as ModuleManifest;
}

// Canonical Node-ESM idiom: compare the file:// URL of our own module
// against the CLI-entry path. Phase 10 P3-16 — replaces the regex-on-
// argv[1] check from the initial extraction. Works no matter where the
// module is relocated; the old check hard-coded "devtools-network" as
// a path segment.
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
