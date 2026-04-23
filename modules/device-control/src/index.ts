// device-control subprocess entry. Spawned by the rn-dev host via
// `node dist/index.js` after `@rn-dev-modules/device-control` is
// installed into `~/.rn-dev/modules/device-control/`.
//
// Manifest-loaded: the host reads `rn-dev-module.json` for MCP tool
// contributions; `runModule()` registers exactly those names so the
// manifest + runtime never drift.
//
// Platform detection is lazy: `adb` / `xcrun` are only invoked on the
// first call. A laptop without Android Studio installed returns an
// empty `android` platform from `list` with a warning, not a crash.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  runModule,
  type ModuleManifest,
} from "@rn-dev/module-sdk";
import type { DeviceAdapter, Platform } from "./adapter.js";
import { createAndroidAdapter } from "./android-adapter.js";
import { createIosAdapter } from "./ios-adapter.js";
import {
  installApk,
  launchApp,
  list,
  logsTail,
  screenshot,
  swipe,
  tap,
  typeText,
  uninstallApp,
  type InstallApkArgs,
  type LaunchAppArgs,
  type ListArgs,
  type LogsTailArgs,
  type ScreenshotArgs,
  type SwipeArgs,
  type TapArgs,
  type TypeTextArgs,
  type UninstallAppArgs,
} from "./tools.js";

export const MODULE_ID = "device-control" as const;

/**
 * Build the adapter map. Kept separate from `runModule` so integration
 * tests can wire stub adapters without spawning a subprocess.
 */
export function createAdapters(): Record<Platform, DeviceAdapter> {
  return {
    android: createAndroidAdapter(),
    ios: createIosAdapter(),
  };
}

/** Resolve the manifest from disk — relative to the module root. */
async function loadManifest(entryDir: string): Promise<ModuleManifest> {
  const manifestPath = join(entryDir, "..", "rn-dev-module.json");
  const raw = await readFile(manifestPath, "utf-8");
  return JSON.parse(raw) as ModuleManifest;
}

// ---------------------------------------------------------------------------
// Arg narrowing — Phase 10 P2-10.
//
// The SDK types every tool handler's args as `Record<string, unknown>` so
// the wire contract stays typed only at the JSON-Schema boundary. The
// module's handler functions want precise shapes. Each `toXArgs` coerces
// the incoming record, pulling fields defensively with runtime narrowing.
// MCP validates the schema upstream, but a direct unix-socket poke or a
// schema mismatch must not blow up the handler — narrow, then dispatch.
// Mirrors the pattern established in modules/devtools-network/src/index.ts.
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(args: Args, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function requireStr(args: Args, key: string, tool: string): string {
  const v = str(args, key);
  if (v === undefined) {
    throw new Error(`${tool}: ${key} is required`);
  }
  return v;
}

function requireNum(args: Args, key: string, tool: string): number {
  const v = num(args, key);
  if (v === undefined) {
    throw new Error(`${tool}: ${key} is required`);
  }
  return v;
}

function toListArgs(args: Args): ListArgs {
  const p = args["platform"];
  if (p === "android" || p === "ios" || p === "both") return { platform: p };
  return {};
}

function toScreenshotArgs(args: Args): ScreenshotArgs {
  return { udid: requireStr(args, "udid", "screenshot") };
}

function toTapArgs(args: Args): TapArgs {
  return {
    udid: requireStr(args, "udid", "tap"),
    x: requireNum(args, "x", "tap"),
    y: requireNum(args, "y", "tap"),
  };
}

function toSwipeArgs(args: Args): SwipeArgs {
  const out: SwipeArgs = {
    udid: requireStr(args, "udid", "swipe"),
    x1: requireNum(args, "x1", "swipe"),
    y1: requireNum(args, "y1", "swipe"),
    x2: requireNum(args, "x2", "swipe"),
    y2: requireNum(args, "y2", "swipe"),
  };
  const dur = num(args, "durationMs");
  if (dur !== undefined) out.durationMs = dur;
  return out;
}

function toTypeTextArgs(args: Args): TypeTextArgs {
  return {
    udid: requireStr(args, "udid", "type"),
    text: requireStr(args, "text", "type"),
  };
}

function toLaunchAppArgs(args: Args): LaunchAppArgs {
  const out: LaunchAppArgs = { udid: requireStr(args, "udid", "launch-app") };
  const applicationId = str(args, "applicationId");
  const bundleId = str(args, "bundleId");
  if (applicationId !== undefined) out.applicationId = applicationId;
  if (bundleId !== undefined) out.bundleId = bundleId;
  return out;
}

function toLogsTailArgs(args: Args): LogsTailArgs {
  const out: LogsTailArgs = { udid: requireStr(args, "udid", "logs-tail") };
  const lines = num(args, "lines");
  if (lines !== undefined) out.lines = lines;
  return out;
}

function toInstallApkArgs(args: Args): InstallApkArgs {
  return {
    udid: requireStr(args, "udid", "install-apk"),
    apkPath: requireStr(args, "apkPath", "install-apk"),
  };
}

function toUninstallAppArgs(args: Args): UninstallAppArgs {
  const out: UninstallAppArgs = {
    udid: requireStr(args, "udid", "uninstall-app"),
  };
  const applicationId = str(args, "applicationId");
  const bundleId = str(args, "bundleId");
  if (applicationId !== undefined) out.applicationId = applicationId;
  if (bundleId !== undefined) out.bundleId = bundleId;
  return out;
}

// Only run when invoked as a subprocess (`node dist/index.js`). Importing
// the module for tests bypasses the runModule() call. Canonical Node-ESM
// idiom: compare the file:// URL of our own module against the
// CLI-entry path. Replaces the fragile regex-on-argv[1] check from
// Phase 9 (which would break if the module got relocated) with a
// location-independent equality. Phase 10 P3-16.
const invokedAsEntry =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsEntry) {
  const entryDir = dirname(fileURLToPath(import.meta.url));
  const manifest = await loadManifest(entryDir);
  const adapters = createAdapters();
  const deps = {
    getAdapter: (p: Platform): DeviceAdapter | null => adapters[p] ?? null,
  };

  runModule({
    manifest,
    tools: {
      "device-control__list": (args) => list(toListArgs(args), deps),
      "device-control__screenshot": (args) =>
        screenshot(toScreenshotArgs(args), deps),
      "device-control__tap": (args) => tap(toTapArgs(args), deps),
      "device-control__swipe": (args) => swipe(toSwipeArgs(args), deps),
      "device-control__type": (args) => typeText(toTypeTextArgs(args), deps),
      "device-control__launch-app": (args) =>
        launchApp(toLaunchAppArgs(args), deps),
      "device-control__logs-tail": (args) =>
        logsTail(toLogsTailArgs(args), deps),
      "device-control__install-apk": (args) =>
        installApk(toInstallApkArgs(args), deps),
      "device-control__uninstall-app": (args) =>
        uninstallApp(toUninstallAppArgs(args), deps),
    },
    activate: (ctx) => {
      ctx.log.info("device-control activated", {
        platforms: Object.keys(adapters),
      });
    },
  });
}
