import { describe, expect, expectTypeOf, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import schema from "../../config.schema.json" with { type: "json" };
import {
  validateConfig,
  type DefineConfigInput,
  type HookEntry,
  type RnDevConfig,
} from "../index.js";

const fullConfig = {
  hooks: {
    "build/pre": "./pre.sh",
    "build/post": {
      script: "./post.sh",
      onFail: "warn",
      timeoutMs: 30_000,
      priority: 5,
    },
  },
  allowModuleOverrides: ["my-builder"],
  allowModuleHardFails: ["my-validator"],
} satisfies RnDevConfig;

describe("config lockstep — config.schema.json ⇄ RnDevConfig", () => {
  it("ajv accepts the all-fields fixture", () => {
    const result = validateConfig(fullConfig);
    expect(result.valid).toBe(true);
  });

  it("schema declares every top-level property the types declare", () => {
    const schemaProps = new Set(Object.keys(schema.properties));
    for (const key of Object.keys(fullConfig)) {
      expect(schemaProps.has(key)).toBe(true);
    }
  });

  it("rejects a fixture key the schema doesn't declare (additionalProperties: false)", () => {
    const result = validateConfig({ ...fullConfig, rogue: 1 });
    expect(result.valid).toBe(false);
  });

  it("HookEntry includes the string sugar form", () => {
    expectTypeOf<string>().toMatchTypeOf<HookEntry>();
  });

  it("DefineConfigInput.hooks is keyed on HookPhase by default", () => {
    type DefaultHookKeys = keyof NonNullable<DefineConfigInput["hooks"]>;
    expectTypeOf<DefaultHookKeys>().toEqualTypeOf<`${string}/${string}`>();
  });
});

// ---------------------------------------------------------------------------
// Negative-type test — defineConfig typo MUST fail to compile.
// ---------------------------------------------------------------------------
//
// We keep the typo fixtures in `__tests__/types/` with a separate tsconfig
// that disables vitest's bundler resolution. The fixtures use `@ts-expect-error`
// directives — if a typo somehow becomes valid, the directive becomes
// "unused" and tsc fails. We invoke tsc out-of-process and assert exit 0.

describe("defineConfig negative-type tests", () => {
  it("the @ts-expect-error fixture passes tsc --noEmit", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const tsconfigPath = resolve(here, "types/tsconfig.json");
    const result = spawnSync(
      "npx",
      ["tsc", "--noEmit", "-p", tsconfigPath],
      {
        cwd: resolve(here, "../../../.."),
        encoding: "utf8",
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `tsc --noEmit failed:\n${result.stdout}\n${result.stderr}`,
      );
    }
    expect(result.status).toBe(0);
  }, 30_000);
});
