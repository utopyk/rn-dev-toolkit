import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HookError, HookErrorCode } from "@rn-dev/module-sdk";
import {
  defineConfig,
  loadConfig,
  validateConfig,
  type RnDevConfig,
} from "../index.js";

// ---------------------------------------------------------------------------
// defineConfig — identity + type-narrowing
// ---------------------------------------------------------------------------

describe("defineConfig", () => {
  it("returns the input unchanged at runtime (identity helper)", () => {
    const input = { hooks: { "build/pre": "./script.sh" } } as const;
    const out = defineConfig(input);
    expect(out).toBe(input);
  });

  it("accepts the full default-shape config", () => {
    const cfg = defineConfig({
      hooks: {
        "build/pre": "./bin/pre.sh",
        "build/post": {
          script: "./bin/post.sh",
          onFail: "warn",
          timeoutMs: 30_000,
          priority: 5,
        },
        "metro/post-start": {
          fn: async (payload) => {
            void payload;
          },
          onFail: "hard",
        },
      },
      allowModuleOverrides: ["my-builder"],
      allowModuleHardFails: ["my-validator"],
    });
    expect(cfg.hooks).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// validateConfig — shape-only checks
// ---------------------------------------------------------------------------

describe("validateConfig", () => {
  it("accepts an empty config", () => {
    const result = validateConfig({});
    expect(result.valid).toBe(true);
  });

  it("accepts string-sugar hook entries", () => {
    const result = validateConfig({ hooks: { "build/pre": "./x.sh" } });
    expect(result.valid).toBe(true);
  });

  it("accepts object-form script entries with all options", () => {
    const result = validateConfig({
      hooks: {
        "build/post": {
          script: "./x.sh",
          onFail: "retry",
          timeoutMs: 1000,
          priority: 10,
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts function-form entries (fn key replaced by sentinel for ajv)", () => {
    const result = validateConfig({
      hooks: {
        "metro/post-start": {
          fn: () => undefined,
          onFail: "warn",
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects hook keys that are not '<id>/<name>'", () => {
    const result = validateConfig({ hooks: { "no-slash": "./x.sh" } });
    expect(result.valid).toBe(false);
  });

  it("rejects empty-string script paths", () => {
    const result = validateConfig({ hooks: { "build/pre": { script: "" } } });
    expect(result.valid).toBe(false);
  });

  it("rejects unknown root-level keys (additionalProperties: false)", () => {
    const result = validateConfig({ rogue: true });
    expect(result.valid).toBe(false);
  });

  it("rejects unknown keys inside a hook entry", () => {
    const result = validateConfig({
      hooks: {
        "build/pre": { script: "./x.sh", surprise: 1 },
      },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects negative timeoutMs", () => {
    const result = validateConfig({
      hooks: { "build/pre": { script: "./x.sh", timeoutMs: -1 } },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects unknown onFail values", () => {
    const result = validateConfig({
      hooks: {
        "build/pre": {
          script: "./x.sh",
          onFail: "bogus",
        },
      },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects allowModuleOverrides containing duplicates", () => {
    const result = validateConfig({
      allowModuleOverrides: ["a", "a"],
    });
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadConfig — orchestrates each E_HOOK_CONFIG_INVALID cause
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  function withTmp<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "rn-dev-config-"));
    try {
      return Promise.resolve(fn(dir)).finally(() => {
        rmSync(dir, { recursive: true, force: true });
      });
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  it("loads a valid mjs config and returns the parsed shape", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "rn-dev.config.mjs");
      writeFileSync(
        file,
        `export default { hooks: { 'build/pre': './pre.sh' } };\n`,
      );
      const cfg = await loadConfig(pathToFileURL(file).href);
      expect(cfg).toEqual({ hooks: { "build/pre": "./pre.sh" } });
    });
  });

  it("raises E_HOOK_CONFIG_INVALID with cause=parse-failed on a syntax error", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "rn-dev.config.mjs");
      writeFileSync(file, `export default { hooks: { 'build/pre': }`);
      await expect(loadConfig(pathToFileURL(file).href)).rejects.toMatchObject({
        code: HookErrorCode.E_HOOK_CONFIG_INVALID,
        details: { cause: "parse-failed" },
      });
    });
  });

  it("raises E_HOOK_CONFIG_INVALID with cause=threw when the module body throws", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "rn-dev.config.mjs");
      writeFileSync(
        file,
        `throw new Error('boom');\nexport default {};\n`,
      );
      await expect(loadConfig(pathToFileURL(file).href)).rejects.toMatchObject({
        code: HookErrorCode.E_HOOK_CONFIG_INVALID,
        details: { cause: "threw" },
      });
    });
  });

  it("raises E_HOOK_CONFIG_INVALID with cause=shape-invalid when the default export fails the schema", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "rn-dev.config.mjs");
      writeFileSync(
        file,
        `export default { hooks: { 'no-slash': './x.sh' } };\n`,
      );
      await expect(loadConfig(pathToFileURL(file).href)).rejects.toMatchObject({
        code: HookErrorCode.E_HOOK_CONFIG_INVALID,
        details: { cause: "shape-invalid" },
      });
    });
  });

  it("raises E_HOOK_CONFIG_INVALID with cause=config-load-timeout when import exceeds the timeout", async () => {
    // A non-existent path would fall through to a parse-or-resolve error
    // before the timeout. Force the timeout to ~0ms with a real-but-slow
    // import. We use a data: URL with a tiny TLA delay.
    const slowConfigUrl =
      "data:text/javascript;base64," +
      Buffer.from(
        `await new Promise(r => setTimeout(r, 200));\nexport default {};`,
      ).toString("base64");
    await expect(
      loadConfig(slowConfigUrl, { timeoutMs: 10 }),
    ).rejects.toMatchObject({
      code: HookErrorCode.E_HOOK_CONFIG_INVALID,
      details: { cause: "config-load-timeout" },
    });
  });

  it("preserves the HookError.details.code discriminator across all causes", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "rn-dev.config.mjs");
      writeFileSync(file, `export default 42;\n`);
      try {
        await loadConfig(pathToFileURL(file).href);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(HookError);
        if (err instanceof HookError) {
          expect(err.code).toBe(HookErrorCode.E_HOOK_CONFIG_INVALID);
          expect(err.details.code).toBe(HookErrorCode.E_HOOK_CONFIG_INVALID);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // projectRoot containment check — H1 security showstopper
  // -------------------------------------------------------------------------

  it("loads cleanly when the config sits under the projectRoot", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "rn-dev.config.mjs");
      writeFileSync(file, `export default { hooks: {} };\n`);
      const cfg = await loadConfig(pathToFileURL(file).href, {
        projectRoot: dir,
      });
      expect(cfg).toEqual({ hooks: {} });
    });
  });

  it("rejects when the config resolves outside the projectRoot", async () => {
    await withTmp(async (rootDir) => {
      await withTmp(async (otherDir) => {
        const file = join(otherDir, "rogue.config.mjs");
        writeFileSync(file, `export default { hooks: {} };\n`);
        await expect(
          loadConfig(pathToFileURL(file).href, { projectRoot: rootDir }),
        ).rejects.toMatchObject({
          code: HookErrorCode.E_HOOK_CONFIG_INVALID,
          details: { cause: "path-outside-project" },
        });
      });
    });
  });

  it("does not match a sibling whose path is a string-prefix of projectRoot", async () => {
    // /tmp/foo vs /tmp/foobar — without the trailing-separator guard,
    // a config inside `foobar` would falsely satisfy a `foo` prefix check.
    await withTmp(async (dir) => {
      // Create a sibling with a name that prefixes the rootDir name.
      const outerTmp = join(dir, "..");
      const outerEntries = mkdtempSync(join(outerTmp, "rn-dev-prefix-"));
      try {
        const file = join(outerEntries, "rn-dev.config.mjs");
        writeFileSync(file, `export default { hooks: {} };\n`);
        await expect(
          loadConfig(pathToFileURL(file).href, { projectRoot: dir }),
        ).rejects.toMatchObject({
          code: HookErrorCode.E_HOOK_CONFIG_INVALID,
          details: { cause: "path-outside-project" },
        });
      } finally {
        rmSync(outerEntries, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Type-level acceptance — explicit RnDevConfig typing compiles cleanly
// ---------------------------------------------------------------------------

describe("RnDevConfig typing", () => {
  it("accepts the default-shape RnDevConfig type", () => {
    const cfg: RnDevConfig = {
      hooks: { "build/pre": "./x.sh" },
      allowModuleOverrides: ["m"],
    };
    expect(cfg.hooks).toBeTruthy();
  });
});
