// Verify the "load project rn-dev.config → call enumerateEnvs → coerce
// output" pipeline behind the `wizard:getEnvs` IPC. Kept as a pure
// integration test (real fs, real config loader) since the ipc handler
// itself is a one-line delegate and testing through ipcMain would need a
// full Electron harness for no additional coverage.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coerceEnvOption,
  resolveEnvsForProject,
} from "../ipc/wizard.js";

function makeTmpProject(): { path: string; cleanup: () => void } {
  const p = mkdtempSync(join(tmpdir(), "rn-dev-envs-test-"));
  return {
    path: p,
    cleanup: () => {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

describe("coerceEnvOption", () => {
  it("passes through key + label", () => {
    expect(coerceEnvOption({ key: "prod", label: "Production" })).toEqual({
      key: "prod",
      label: "Production",
    });
  });

  it("preserves description when provided as a string", () => {
    expect(
      coerceEnvOption({ key: "prod", label: "Production", description: "live" }),
    ).toEqual({ key: "prod", label: "Production", description: "live" });
  });

  it("drops description when non-string (defensive parsing)", () => {
    expect(
      coerceEnvOption({ key: "prod", label: "Production", description: 42 }),
    ).toEqual({ key: "prod", label: "Production" });
  });

  it("rejects rows missing key or label", () => {
    expect(coerceEnvOption({ key: "prod" })).toBeNull();
    expect(coerceEnvOption({ label: "Production" })).toBeNull();
    expect(coerceEnvOption({ key: "", label: "x" })).toBeNull();
    expect(coerceEnvOption({ key: "x", label: "" })).toBeNull();
  });

  it("rejects non-object input", () => {
    expect(coerceEnvOption(null)).toBeNull();
    expect(coerceEnvOption("prod")).toBeNull();
    expect(coerceEnvOption(42)).toBeNull();
  });
});

describe("resolveEnvsForProject", () => {
  it("returns [] when projectRoot is null", async () => {
    expect(await resolveEnvsForProject(null)).toEqual([]);
  });

  it("returns [] when the project has no rn-dev.config file", async () => {
    const { path, cleanup } = makeTmpProject();
    try {
      expect(await resolveEnvsForProject(path)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("returns [] when the config file has no enumerateEnvs", async () => {
    const { path, cleanup } = makeTmpProject();
    try {
      writeFileSync(
        join(path, "rn-dev.config.mjs"),
        `export default { hooks: {} };\n`,
      );
      expect(await resolveEnvsForProject(path)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("returns the enumerated options when the config provides them", async () => {
    const { path, cleanup } = makeTmpProject();
    try {
      writeFileSync(
        join(path, "rn-dev.config.mjs"),
        `export default {
          enumerateEnvs: () => [
            { key: 'production', label: 'Production', description: 'live' },
            { key: 'staging', label: 'Staging' },
            { key: 'local', label: 'Local' },
          ],
        };
        `,
      );
      const envs = await resolveEnvsForProject(path);
      expect(envs).toEqual([
        { key: "production", label: "Production", description: "live" },
        { key: "staging", label: "Staging" },
        { key: "local", label: "Local" },
      ]);
    } finally {
      cleanup();
    }
  });

  it("filters out malformed rows without failing the whole lookup", async () => {
    const { path, cleanup } = makeTmpProject();
    try {
      writeFileSync(
        join(path, "rn-dev.config.mjs"),
        `export default {
          enumerateEnvs: () => [
            { key: 'prod', label: 'Production' },
            { key: '', label: 'ignored — empty key' },
            'not an object',
            null,
            { label: 'ignored — missing key' },
            { key: 'staging', label: 'Staging' },
          ],
        };
        `,
      );
      const envs = await resolveEnvsForProject(path);
      expect(envs.map((e) => e.key)).toEqual(["prod", "staging"]);
    } finally {
      cleanup();
    }
  });

  it("supports async enumerateEnvs", async () => {
    const { path, cleanup } = makeTmpProject();
    try {
      writeFileSync(
        join(path, "rn-dev.config.mjs"),
        `export default {
          enumerateEnvs: async () => {
            await new Promise((r) => setTimeout(r, 5));
            return [{ key: 'prod', label: 'Production' }];
          },
        };
        `,
      );
      const envs = await resolveEnvsForProject(path);
      expect(envs).toEqual([{ key: "prod", label: "Production" }]);
    } finally {
      cleanup();
    }
  });

  it("returns [] when enumerateEnvs throws (per-project bug shouldn't wedge the wizard)", async () => {
    const { path, cleanup } = makeTmpProject();
    try {
      writeFileSync(
        join(path, "rn-dev.config.mjs"),
        `export default {
          enumerateEnvs: () => { throw new Error('boom'); },
        };
        `,
      );
      expect(await resolveEnvsForProject(path)).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
