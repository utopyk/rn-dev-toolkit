// Phase H2i — minimal example of the acme-style "swap a config
// before each build" pattern, expressed through the H2 build/pre +
// build/post hook slots provided by the built-in `build` module.
//
// No `import { defineConfig } from "@rn-dev/config"` because the
// package isn't published to npm yet (H7 territory). loadConfig
// validates the plain object shape directly. If you have
// `@rn-dev/config` installed (workspace link, future npm publish),
// you can wrap the export in `defineConfig({...})` for typed hook
// slot completion.

export default {
  hooks: {
    "build/pre": {
      script: "./scripts/swap-pre.mjs",
      // Hard-fail aborts the build with E_HOOK_FAILED — appropriate
      // when a missing prod config would corrupt the artifact. Switch
      // to "warn" if your swap is best-effort.
      onFail: "hard",
      timeoutMs: 10_000,
    },
    "build/post": {
      script: "./scripts/swap-post.mjs",
      // Always run cleanup, but don't block if it fails — the build
      // already succeeded.
      onFail: "warn",
      timeoutMs: 10_000,
    },
  },

  // Opt in to the build module's `<id>/custom` override slot. NOT
  // needed for the pre/post examples above — uncomment when you want
  // to fully replace the Builder with your own implementation
  // (override semantics formalize in Phase H4):
  //
  // allowModuleOverrides: ["build"],
};
