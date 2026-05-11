// Negative-type fixtures. Each ts-expect-error directive asserts that the
// next line is an error AT COMPILE TIME. If someone widens or breaks a
// type and the typo becomes valid, the directive turns into a "unused
// directive" error and the lockstep test fails. tsc --noEmit on this
// file MUST succeed.
//
// (We deliberately spell the directive name in the header without the
// leading slashes so TS doesn't pick it up as an actual directive.)
//
// This file is checked by `packages/config/src/__tests__/lockstep.test.ts`'s
// "defineConfig negative-type tests" suite.

import {
  defineConfig,
  type DefineConfigInput,
  type HookEntry,
  type RnDevConfig,
} from "../../index.js";

// -- HookEntry shape -------------------------------------------------------

const _ok1: HookEntry = "./script.sh";
void _ok1;
const _ok2: HookEntry = { script: "./x.sh", onFail: "warn", timeoutMs: 1000 };
void _ok2;

const _bad1: HookEntry = {
  script: "./x.sh",
  // @ts-expect-error onFail must be 'hard' | 'warn' | 'retry'.
  onFail: "later",
};
void _bad1;

const _bad2: HookEntry = {
  script: "./x.sh",
  // @ts-expect-error timeoutMs must be a number.
  timeoutMs: "30s",
};
void _bad2;

// @ts-expect-error script must be a string.
const _bad3: HookEntry = { script: 42 };
void _bad3;

const _bad4: HookEntry = {
  script: "./x.sh",
  // @ts-expect-error exactly one of `script` or `fn` must be present (not both).
  fn: () => undefined,
};
void _bad4;

// -- defineConfig (default-shape, no manifests) ----------------------------

const _cfg1 = defineConfig({ hooks: { "build/pre": "./pre.sh" } });
void _cfg1;

const _cfg3 = defineConfig({
  hooks: {
    "build/pre": {
      script: "./x.sh",
      // @ts-expect-error onFail typo at the entry level.
      onFail: "rety",
    },
  },
});
void _cfg3;

const _cfg4 = defineConfig({
  hooks: {
    "build/pre": {
      script: "./x.sh",
      // @ts-expect-error `surprise` is not a known field on HookEntry.
      surprise: 1,
    },
  },
});
void _cfg4;

const _cfg5: RnDevConfig = {
  // @ts-expect-error allowModuleOverrides must be string[].
  allowModuleOverrides: [1, 2],
};
void _cfg5;

const _cfg6: RnDevConfig = {
  // @ts-expect-error allowModuleHardFails must be string[].
  allowModuleHardFails: [true],
};
void _cfg6;

// -- DefineConfigInput narrowing -------------------------------------------

const _hookable: DefineConfigInput["hooks"] = {
  "build/pre": "./x.sh",
};
void _hookable;
