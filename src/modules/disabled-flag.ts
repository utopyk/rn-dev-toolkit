// Disabled-flag persistence for Phase 3c `modules/enable` + `modules/disable`.
//
// Simple file-presence marker at `~/.rn-dev/modules/<id>/disabled.flag`.
// Cheap, human-readable ("why is this module off? oh there's a file"), and
// survives restarts without a separate settings store.
//
// NOTE: No locking or concurrency guards. A runaway pair of enable/disable
// calls could race on `mkdir`/`unlink`, but the final state resolves fine
// because file presence is the only bit that matters. Fast enough to not
// worry about it for v1.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const DISABLED_FLAG_FILENAME = "disabled.flag";

/** Default modules root under the user's home dir. */
export function defaultModulesRoot(): string {
  return join(homedir(), ".rn-dev", "modules");
}

export function disabledFlagPath(
  moduleId: string,
  modulesRoot: string = defaultModulesRoot(),
): string {
  return join(modulesRoot, moduleId, DISABLED_FLAG_FILENAME);
}

export function isDisabled(
  moduleId: string,
  modulesRoot: string = defaultModulesRoot(),
): boolean {
  return existsSync(disabledFlagPath(moduleId, modulesRoot));
}

export function setDisabled(
  moduleId: string,
  disabled: boolean,
  modulesRoot: string = defaultModulesRoot(),
): void {
  const flag = disabledFlagPath(moduleId, modulesRoot);
  if (disabled) {
    mkdirSync(dirname(flag), { recursive: true });
    writeFileSync(
      flag,
      `Disabled at ${new Date().toISOString()} via rn-dev/modules-disable`,
      "utf-8",
    );
    return;
  }
  if (existsSync(flag)) {
    try {
      unlinkSync(flag);
    } catch {
      /* race with another process — acceptable */
    }
  }
}
