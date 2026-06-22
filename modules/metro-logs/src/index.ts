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
  clear,
  list,
  nativeClear,
  nativeList,
  nativeStatus,
  startTap,
  status,
  stopTap,
  type ClearArgs,
  type ListArgs,
  type NativeClearArgs,
  type NativeListArgs,
  type NativeStatusArgs,
  type StartTapArgs,
  type StatusArgs,
  type StopTapArgs,
} from "./tools.js";
import type { DeviceLogLevel, DeviceLogSource, MetroLogStream } from "./types.js";

export const MODULE_ID = "metro-logs" as const;

// ---------------------------------------------------------------------------
// Arg narrowing
//
// General-purpose narrowers (`str`, `boundedInt`, `ringCursor`, `Args`)
// live in the SDK — imported via `@rn-dev/module-sdk`. Module-specific
// narrowers (the `"stdout" | "stderr"` `stream` union) stay local.
// The narrowers here produce a bounds-checked `ListArgs`; `tools.ts`
// handlers trust the narrowed shape and don't re-validate.
// ---------------------------------------------------------------------------

function stream(args: Args): MetroLogStream | undefined {
  const v = args["stream"];
  if (v === "stdout" || v === "stderr") return v;
  return undefined;
}

function toStatusArgs(args: Args): StatusArgs {
  return { worktree: str(args, "worktree") };
}

function toListArgs(args: Args): ListArgs {
  const out: ListArgs = {};
  const wk = str(args, "worktree");
  const sub = str(args, "substring");
  const str2 = stream(args);
  const since = ringCursor(args);
  const limit = boundedInt(args, "limit", { min: 1, max: MAX_LIST_LIMIT });
  if (wk !== undefined) out.worktree = wk;
  if (sub !== undefined) out.substring = sub;
  if (str2 !== undefined) out.stream = str2;
  if (since !== undefined) out.since = since;
  if (limit !== undefined) out.limit = limit;
  return out;
}

function toClearArgs(args: Args): ClearArgs {
  return { worktree: str(args, "worktree") };
}

// ── Native-tap narrowers (folded from the deleted device-logs module) ──

function source(args: Args): DeviceLogSource | undefined {
  const v = args["source"];
  if (v === "ios" || v === "android") return v;
  return undefined;
}
function platform(args: Args): DeviceLogSource | undefined {
  const v = args["platform"];
  if (v === "ios" || v === "android") return v;
  return undefined;
}
function level(args: Args): DeviceLogLevel | undefined {
  const v = args["level"];
  if (v === "debug" || v === "info" || v === "warn" || v === "error" || v === "fault") return v;
  return undefined;
}
function bool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (typeof v === "boolean") return v;
  return undefined;
}

function toNativeStatusArgs(_args: Args): NativeStatusArgs {
  return {};
}
function toNativeListArgs(args: Args): NativeListArgs {
  const out: NativeListArgs = {};
  const did = str(args, "deviceId");
  const src = source(args);
  const lvl = level(args);
  const sub = str(args, "substring");
  const since = ringCursor(args);
  const limit = boundedInt(args, "limit", { min: 1, max: MAX_LIST_LIMIT });
  if (did !== undefined) out.deviceId = did;
  if (src !== undefined) out.source = src;
  if (lvl !== undefined) out.level = lvl;
  if (sub !== undefined) out.substring = sub;
  if (since !== undefined) out.since = since;
  if (limit !== undefined) out.limit = limit;
  return out;
}
function toNativeClearArgs(args: Args): NativeClearArgs {
  return { deviceId: str(args, "deviceId") };
}
function toStartTapArgs(args: Args): StartTapArgs {
  const p = platform(args);
  if (p === undefined) throw new Error("start-tap: 'platform' is required (\"ios\" | \"android\")");
  const did = str(args, "deviceId");
  if (did === undefined || did.length === 0) throw new Error("start-tap: 'deviceId' is required");
  const out: StartTapArgs = { platform: p, deviceId: did };
  const sim = bool(args, "simulator");
  const bundle = str(args, "bundleId");
  const pkg = str(args, "packageName");
  if (sim !== undefined) out.simulator = sim;
  if (bundle !== undefined) out.bundleId = bundle;
  if (pkg !== undefined) out.packageName = pkg;
  return out;
}
function toStopTapArgs(args: Args): StopTapArgs {
  const tapId = str(args, "tapId");
  if (tapId === undefined || tapId.length === 0) throw new Error("stop-tap: 'tapId' is required");
  return { tapId };
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
      "metro-logs__native-status": (args: Args, ctx: ModuleToolContext) =>
        nativeStatus(toNativeStatusArgs(args), ctx),
      "metro-logs__native-list": (args: Args, ctx: ModuleToolContext) =>
        nativeList(toNativeListArgs(args), ctx),
      "metro-logs__native-clear": (args: Args, ctx: ModuleToolContext) =>
        nativeClear(toNativeClearArgs(args), ctx),
      "metro-logs__start-tap": (args: Args, ctx: ModuleToolContext) =>
        startTap(toStartTapArgs(args), ctx),
      "metro-logs__stop-tap": (args: Args, ctx: ModuleToolContext) =>
        stopTap(toStopTapArgs(args), ctx),
    },
    activate: (ctx) => {
      ctx.log.info("metro-logs activated");
    },
  });
}
