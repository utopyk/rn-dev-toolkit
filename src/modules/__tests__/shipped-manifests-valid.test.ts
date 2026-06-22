// Regression guard: every manifest we actually ship under `modules/*`
// MUST pass the real registry validator. This is the test that was
// missing when the device-logs → metro-logs merge shipped 5 new tools
// without the mandatory prompt-injection warning — the whole module was
// silently rejected at daemon boot and vanished from the GUI, but the
// unit/tsc/smoke gate never noticed because nothing validated the real
// shipped manifests.
//
// Anything that breaks a real manifest (missing S6 warning on a
// sensitive-permission tool, bad tool-name prefix, host-range typo, etc.)
// now fails here at vitest time instead of at manual-verification time.

import { describe, it, expect } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModuleRegistry } from "../registry.js";

// repo-root/modules — this test file lives at src/modules/__tests__/.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MODULES_DIR = join(REPO_ROOT, "modules");

// Host version the daemon ships with. Kept loose: the manifests declare
// `>=0.1.0`, so any 0.1.x satisfies. If the daemon version moves past a
// manifest's range this test correctly fails (that's the point).
const HOST_VERSION = "0.1.3";

function shippedModuleDirs(): string[] {
  if (!existsSync(MODULES_DIR)) return [];
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(MODULES_DIR, name, "rn-dev-module.json")));
}

describe("shipped module manifests validate against the real registry", () => {
  const dirs = shippedModuleDirs();

  it("finds at least the known third-party modules", () => {
    // Sanity: the glob actually picked up modules (a path typo here would
    // otherwise make the suite vacuously pass).
    expect(dirs).toEqual(expect.arrayContaining(["metro-logs", "devtools-network", "redux"]));
  });

  for (const name of dirs) {
    it(`"${name}" passes loadSingleManifest (no rejection)`, () => {
      const manifestPath = join(MODULES_DIR, name, "rn-dev-module.json");
      const result = ModuleRegistry.loadSingleManifest(manifestPath, {
        hostVersion: HOST_VERSION,
        scopeUnit: "test-worktree",
        isBuiltIn: false,
      });
      if (result.kind === "err") {
        throw new Error(
          `${name} rejected: ${result.rejection.code} — ${result.rejection.message}`,
        );
      }
      expect(result.kind).toBe("ok");
    });
  }
});
