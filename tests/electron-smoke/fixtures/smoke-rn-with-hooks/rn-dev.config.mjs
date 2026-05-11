// Phase H2h fixture config. Declares build/pre + build/post against the
// 'build' built-in module's slots (provides.hooks: ['pre','post','custom']).
//
// No `import { defineConfig } from "@rn-dev/config"` because the package
// isn't published to npm yet; loadConfig validates the plain-object
// shape directly. Daemon-loaded via load-project-hooks.ts during Phase 2
// of the three-phase boot.
//
// Hooks pass the path to the sentinel they should touch via the
// SENTINEL_DIR env var the integration test injects at daemon spawn.

export default {
  hooks: {
    "build/pre": {
      script: "./hooks/build-pre.mjs",
      onFail: "warn",
      timeoutMs: 5000,
    },
    "build/post": {
      script: "./hooks/build-post.mjs",
      onFail: "warn",
      timeoutMs: 5000,
    },
  },
};
