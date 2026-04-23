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
import { fileURLToPath } from "node:url";
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

// Only run when invoked as a subprocess (`node dist/index.js`). Importing
// the module for tests bypasses the runModule() call.
const invokedAsEntry =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  // When bundled into dist/index.js, process.argv[1] ends in index.js.
  // When TS is running under tsx for tests, it points elsewhere.
  /device-control[\\/](dist|src)[\\/]index\.(js|ts)$/.test(process.argv[1]);

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
      "device-control__list": (args) =>
        list(args as Parameters<typeof list>[0], deps),
      "device-control__screenshot": (args) =>
        screenshot(args as Parameters<typeof screenshot>[0], deps),
      "device-control__tap": (args) =>
        tap(args as Parameters<typeof tap>[0], deps),
      "device-control__swipe": (args) =>
        swipe(args as Parameters<typeof swipe>[0], deps),
      "device-control__type": (args) =>
        typeText(args as Parameters<typeof typeText>[0], deps),
      "device-control__launch-app": (args) =>
        launchApp(args as Parameters<typeof launchApp>[0], deps),
      "device-control__logs-tail": (args) =>
        logsTail(args as Parameters<typeof logsTail>[0], deps),
      "device-control__install-apk": (args) =>
        installApk(args as Parameters<typeof installApk>[0], deps),
      "device-control__uninstall-app": (args) =>
        uninstallApp(args as Parameters<typeof uninstallApp>[0], deps),
    },
    activate: (ctx) => {
      ctx.log.info("device-control activated", {
        platforms: Object.keys(adapters),
      });
    },
  });
}
