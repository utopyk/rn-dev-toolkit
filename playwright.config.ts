import { defineConfig } from "@playwright/test";

// Playwright config for the Electron smoke suite. Suite lives at
// `tests/electron-smoke/*.spec.ts`; vitest specs are NOT picked up
// because their pattern is `**/__tests__/**/*.test.ts`.
//
// Why a separate runner: vitest+jsdom catches the cheap class of
// regressions (TDZ, undefined props, render crashes), Playwright
// catches what only surfaces in real Electron — IPC shape mismatches,
// renderer↔main timing races, navigation flow bugs. Both are required
// before push for renderer-touching changes per CLAUDE.md.
export default defineConfig({
  testDir: "./tests/electron-smoke",
  testMatch: /.*\.spec\.ts$/,
  // One window at a time — the smoke suite spawns a real Electron
  // instance + a per-worktree daemon on a ./tmp fixture; running them
  // in parallel would fight over ports + sockets.
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  timeout: 60_000,
  // Vite starts the renderer at http://localhost:5173 the same way the
  // dev:gui flow does; Electron's main.ts does a port-walk waitForVite()
  // so it'll find this server. `reuseExistingServer: true` means a
  // local dev session running concurrently isn't disturbed.
  webServer: {
    command: "cd renderer && npx vite --port 5173",
    port: 5173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
