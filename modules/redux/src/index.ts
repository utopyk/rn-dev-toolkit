// redux subprocess entry. Spawned by the rn-dev host via
// `node dist/index.js` after `@rn-dev-modules/redux` is installed into
// `~/.rn-dev/modules/redux/`. Manifest-loaded — `runModule` registers
// exactly the names declared in `rn-dev-module.json`.
//
// Data path: every tool resolves the `redux` host capability and
// round-trips through vscode-jsonrpc `host/call` to the daemon's
// per-session ReduxStore (fed by the WS ingest). Redaction is applied
// host-side from this module's operator config.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  boundedInt,
  ringCursor,
  runModule,
  str,
  type Args,
  type ModuleManifest,
  type ModuleToolContext,
} from "@rn-dev/module-sdk";
import {
  MAX_LIST_LIMIT,
  action,
  actions,
  clear,
  state,
  status,
  type ActionArgs,
  type ActionsArgs,
  type ClearArgs,
  type StateArgs,
  type StatusArgs,
} from "./tools.js";

export const MODULE_ID = "redux" as const;

function toStatusArgs(args: Args): StatusArgs {
  return { worktree: str(args, "worktree") };
}

function toStateArgs(args: Args): StateArgs {
  const out: StateArgs = {};
  const wk = str(args, "worktree");
  const path = str(args, "path");
  if (wk !== undefined) out.worktree = wk;
  if (path !== undefined) out.path = path;
  return out;
}

function toActionsArgs(args: Args): ActionsArgs {
  const out: ActionsArgs = {};
  const wk = str(args, "worktree");
  const tf = str(args, "typeFilter");
  const since = ringCursor(args);
  const limit = boundedInt(args, "limit", { min: 1, max: MAX_LIST_LIMIT });
  if (wk !== undefined) out.worktree = wk;
  if (tf !== undefined) out.typeFilter = tf;
  if (since !== undefined) out.since = since;
  if (limit !== undefined) out.limit = limit;
  return out;
}

function toActionArgs(args: Args): ActionArgs {
  const wk = str(args, "worktree");
  // `sequence` is required by the manifest schema; default to -1 (matches
  // nothing) if a caller somehow omits it, so the handler returns
  // `{ action: null }` rather than throwing.
  const seq = boundedInt(args, "sequence", { min: 0, max: Number.MAX_SAFE_INTEGER });
  const out: ActionArgs = { sequence: seq ?? -1 };
  if (wk !== undefined) out.worktree = wk;
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
      "redux__status": (args: Args, ctx: ModuleToolContext) => status(toStatusArgs(args), ctx),
      "redux__state": (args: Args, ctx: ModuleToolContext) => state(toStateArgs(args), ctx),
      "redux__actions": (args: Args, ctx: ModuleToolContext) => actions(toActionsArgs(args), ctx),
      "redux__action": (args: Args, ctx: ModuleToolContext) => action(toActionArgs(args), ctx),
      "redux__clear": (args: Args, ctx: ModuleToolContext) => clear(toClearArgs(args), ctx),
    },
    activate: (ctx) => {
      ctx.log.info("redux activated");
    },
  });
}
