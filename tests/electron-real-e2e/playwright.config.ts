import { defineConfig } from "@playwright/test";

// Playwright config for the long-session real-e2e suite.
//
// Why a separate config: the existing smoke (`tests/electron-smoke/`) is
// designed to be fast — each test boots Electron, asserts on a single
// happy-path, tears down. The real-e2e suite intentionally runs sessions
// for 30+ seconds with periodic activity so it can catch the class of
// regression Bug A surfaced: a daemon that survives the smoke
// (≈3s teardown) but dies under sustained UI use. Mixing the two would
// make every CI run pay the long-session cost.
//
// Trigger: `npx playwright test --config tests/electron-real-e2e/playwright.config.ts`.
// Convenience npm script: `npm run test:real-e2e`.
//
// `webServer` mirrors playwright.config.ts at the repo root so the
// renderer is reachable at http://localhost:5173 either way.
export default defineConfig({
  testDir: "./",
  testMatch: /.*\.spec\.ts$/,
  // One window at a time — same reason as the smoke config: a per-
  // worktree daemon + Electron pair would fight over ports + sockets.
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  // Each test does ~30s of waiting; budget for 90s/test to leave
  // headroom for cold-spawn variance.
  timeout: 90_000,
  webServer: {
    // CWD here is the config directory (`tests/electron-real-e2e/`), so
    // hop two levels up to the repo root before entering `renderer/`.
    command: "cd ../../renderer && npx vite --port 5173",
    port: 5173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
