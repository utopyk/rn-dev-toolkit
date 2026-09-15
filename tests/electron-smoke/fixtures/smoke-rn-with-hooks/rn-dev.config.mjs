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
    // Fires before Metro starts — the slot a project uses to swap app
    // environments, since `.env` is inlined at babel transform time and
    // is not part of Metro's transform cache key.
    "session/pre": {
      script: "./hooks/session-pre.mjs",
      onFail: "warn",
      timeoutMs: 5000,
    },
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
