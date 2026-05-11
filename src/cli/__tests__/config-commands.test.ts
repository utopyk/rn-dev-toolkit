import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runConfigInit,
  runConfigValidate,
} from "../config-commands.js";

function withTmp<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "rn-dev-cli-config-"));
  return Promise.resolve(fn(dir)).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

// ---------------------------------------------------------------------------
// runConfigInit
// ---------------------------------------------------------------------------

describe("runConfigInit", () => {
  it("scaffolds rn-dev.config.mjs into an empty directory", async () => {
    await withTmp(async (dir) => {
      const result = runConfigInit({ path: dir, skipInstall: true });
      expect(result.configPath).toBe(join(dir, "rn-dev.config.mjs"));
      const body = readFileSync(result.configPath, "utf8");
      expect(body).toContain("defineConfig");
      expect(body).toContain("@rn-dev/config");
    });
  });

  it("refuses to overwrite an existing config file without --force", async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, "rn-dev.config.mjs"), "export default {};");
      expect(() => runConfigInit({ path: dir, skipInstall: true })).toThrow(
        /Refusing to overwrite/,
      );
    });
  });

  it("overwrites an existing config when --force is passed", async () => {
    await withTmp(async (dir) => {
      const cfg = join(dir, "rn-dev.config.mjs");
      writeFileSync(cfg, "// stale");
      const result = runConfigInit({
        path: dir,
        force: true,
        skipInstall: true,
      });
      expect(result.configPath).toBe(cfg);
      expect(readFileSync(cfg, "utf8")).toContain("defineConfig");
    });
  });

  it.each([
    ["bun.lock", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ] as const)(
    "detects package manager from %s lockfile",
    async (lockfile, expectedPm) => {
      await withTmp(async (dir) => {
        writeFileSync(join(dir, lockfile), "");
        const result = runConfigInit({ path: dir, skipInstall: true });
        expect(result.packageManager).toBe(expectedPm);
        expect(result.installCommand).toContain(expectedPm);
        expect(result.installCommand).toContain("@rn-dev/config@^");
      });
    },
  );

  it("falls back to npm when no lockfile is present", async () => {
    await withTmp(async (dir) => {
      const result = runConfigInit({ path: dir, skipInstall: true });
      expect(result.packageManager).toBe("npm");
    });
  });

  it("honors an explicit --pm override over lockfile detection", async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, "package-lock.json"), "{}");
      const result = runConfigInit({
        path: dir,
        skipInstall: true,
        pm: "bun",
      });
      expect(result.packageManager).toBe("bun");
    });
  });
});

// ---------------------------------------------------------------------------
// runConfigValidate
// ---------------------------------------------------------------------------

describe("runConfigValidate", () => {
  it("returns ok=false when no config file is present", async () => {
    await withTmp(async (dir) => {
      const result = await runConfigValidate({ path: dir });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/No rn-dev config found/);
    });
  });

  it("validates a scaffolded config end-to-end (init → validate)", async () => {
    await withTmp(async (dir) => {
      runConfigInit({ path: dir, skipInstall: true });
      const result = await runConfigValidate({ path: dir });
      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/is valid/);
    });
  });

  it("returns ok=false with a clear message when config has bad shape", async () => {
    await withTmp(async (dir) => {
      writeFileSync(
        join(dir, "rn-dev.config.mjs"),
        `export default { hooks: { 'no-slash-here': './x.sh' } };`,
      );
      const result = await runConfigValidate({ path: dir });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Invalid rn-dev config/);
    });
  });

  it("flags .ts/.mts files as needing a TS loader (H0 limitation)", async () => {
    await withTmp(async (dir) => {
      writeFileSync(join(dir, "rn-dev.config.ts"), "export default {};");
      const result = await runConfigValidate({ path: dir });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/TypeScript loader/);
    });
  });
});
