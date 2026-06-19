// src/index.ts
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  boundedInt,
  ringCursor,
  runModule,
  str
} from "@rn-dev/module-sdk";

// src/host-capability.ts
var REDUX_CAPABILITY_ID = "redux";

// src/tools.ts
var MAX_LIST_LIMIT = 1000;
function resolveCapability(ctx) {
  const cap = ctx.host.capability(REDUX_CAPABILITY_ID);
  if (!cap)
    throw new Error("redux capability unavailable");
  return cap;
}
function readRedaction(ctx, modeOverride) {
  const cfg = ctx.config;
  const stringArray = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  const configMode = cfg.mode === "full" ? "full" : "mcp-redacted";
  return {
    whitelist: stringArray(cfg.whitelist),
    extraBlacklist: stringArray(cfg.blacklist),
    mode: modeOverride ?? configMode
  };
}
async function status(args, ctx) {
  return resolveCapability(ctx).status(args.worktree);
}
async function state(args, ctx) {
  const { worktree, path } = args;
  return resolveCapability(ctx).getState({
    worktreeKey: worktree,
    path,
    redaction: readRedaction(ctx, args.mode)
  });
}
async function actions(args, ctx) {
  const { worktree, typeFilter, since, limit } = args;
  return resolveCapability(ctx).listActions({
    worktreeKey: worktree,
    filter: { typeFilter, since, limit },
    redaction: readRedaction(ctx, args.mode)
  });
}
async function action(args, ctx) {
  return resolveCapability(ctx).getAction({
    worktreeKey: args.worktree,
    sequence: args.sequence,
    redaction: readRedaction(ctx, args.mode)
  });
}
async function clear(args, ctx) {
  return resolveCapability(ctx).clear({ worktreeKey: args.worktree });
}

// src/index.ts
var MODULE_ID = "redux";
function redactionMode(args) {
  const v = args["mode"];
  return v === "full" || v === "mcp-redacted" ? v : undefined;
}
function toStatusArgs(args) {
  return { worktree: str(args, "worktree") };
}
function toStateArgs(args) {
  const out = {};
  const wk = str(args, "worktree");
  const path = str(args, "path");
  const mode = redactionMode(args);
  if (wk !== undefined)
    out.worktree = wk;
  if (path !== undefined)
    out.path = path;
  if (mode !== undefined)
    out.mode = mode;
  return out;
}
function toActionsArgs(args) {
  const out = {};
  const wk = str(args, "worktree");
  const tf = str(args, "typeFilter");
  const since = ringCursor(args);
  const limit = boundedInt(args, "limit", { min: 1, max: MAX_LIST_LIMIT });
  const mode = redactionMode(args);
  if (wk !== undefined)
    out.worktree = wk;
  if (tf !== undefined)
    out.typeFilter = tf;
  if (since !== undefined)
    out.since = since;
  if (limit !== undefined)
    out.limit = limit;
  if (mode !== undefined)
    out.mode = mode;
  return out;
}
function toActionArgs(args) {
  const wk = str(args, "worktree");
  const seq = boundedInt(args, "sequence", { min: 0, max: Number.MAX_SAFE_INTEGER });
  const mode = redactionMode(args);
  const out = { sequence: seq ?? -1 };
  if (wk !== undefined)
    out.worktree = wk;
  if (mode !== undefined)
    out.mode = mode;
  return out;
}
function toClearArgs(args) {
  return { worktree: str(args, "worktree") };
}
async function loadManifest(entryDir) {
  const manifestPath = join(entryDir, "..", "rn-dev-module.json");
  const raw = await readFile(manifestPath, "utf-8");
  return JSON.parse(raw);
}
var invokedAsEntry = typeof process !== "undefined" && Array.isArray(process.argv) && typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsEntry) {
  const entryDir = dirname(fileURLToPath(import.meta.url));
  const manifest = await loadManifest(entryDir);
  runModule({
    manifest,
    tools: {
      redux__status: (args, ctx) => status(toStatusArgs(args), ctx),
      redux__state: (args, ctx) => state(toStateArgs(args), ctx),
      redux__actions: (args, ctx) => actions(toActionsArgs(args), ctx),
      redux__action: (args, ctx) => action(toActionArgs(args), ctx),
      redux__clear: (args, ctx) => clear(toClearArgs(args), ctx)
    },
    activate: (ctx) => {
      ctx.log.info("redux activated");
    }
  });
}
export {
  MODULE_ID
};

//# debugId=D92B407C1A57128E64756E2164756E21
