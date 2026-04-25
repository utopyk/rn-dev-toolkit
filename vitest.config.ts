import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Deduplicate React so jsdom-env tests (renderer/hooks/**) and
    // root node-env tests share a single copy of react / react-dom.
    dedupe: ["react", "react-dom"],
  },
  test: {
    globals: true,
    environment: "node",
    globalSetup: ["./vitest.global-setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.idea/**",
      "**/.git/**",
      "**/.cache/**",
      "**/.claude/**",
      // Playwright smoke specs live under tests/electron-smoke; their
      // runner is `npx playwright test`. Exclude here so vitest doesn't
      // try to load them under its test environment (they import
      // @playwright/test which assumes its own runner).
      "tests/electron-smoke/**",
    ],
  },
});
