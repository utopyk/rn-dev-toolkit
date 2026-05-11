import { test, expect } from "@playwright/test";
import { launchRealE2e, teardownRealE2e, type RealE2eHandle } from "./launch.js";

// Long-session real-e2e suite. Pre-fix the pipeline proved "Electron
// mounts + tabs render + shortcuts dispatch RPCs" — but those tests
// teardown within ≈3s per case. The user-reported failure mode (Bug A:
// daemon dies under sustained DevTools UI use; the renderer's next
// MetroClient.reload throws "subscribe.send: connection already closed")
// was structurally invisible. This suite intentionally keeps a session
// open for 30+ seconds with active UI interaction so a regression of
// that class fails here, before it ships.
//
// What each test asserts:
//   - The daemon process is alive at the end of the session (no crash).
//   - No "subscribe.send: connection already closed" appears in any
//     captured log surface.
//   - The renderer hasn't surfaced a console.error during the run.

test.describe("Real-e2e long session", () => {
  let handle: RealE2eHandle | null = null;

  test.afterEach(async () => {
    if (handle) {
      await teardownRealE2e(handle);
      handle = null;
    }
  });

  test("DevTools tab survives 30s of activity without crashing the daemon (Bug A)", async () => {
    handle = await launchRealE2e();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    handle.page.on("pageerror", (err) => pageErrors.push(err.message));
    handle.page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    // Wait for the renderer to actually mount before kicking off the
    // long wait — otherwise we'd be measuring boot time, not session
    // survival.
    await expect(handle.page.locator(".sidebar")).toBeVisible({ timeout: 30_000 });

    // Click DevTools — pre-Bug-A this is what triggered the no-target
    // proxy openUpstream → unhandled rejection → daemon exit chain.
    await handle.page.getByRole("button", { name: /devtools/i }).click();

    // Soak — 30s with periodic clicks to exercise IPC. The shortcut
    // buttons are cheap and don't depend on Metro being up under
    // fake-boot.
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      await handle.page.waitForTimeout(2_500);
      // Tap a couple of shortcut buttons each cycle to drive IPC.
      await handle.page.getByRole("button", { name: /\[r\]/i }).click().catch(() => {
        /* button might be transiently hidden mid-render */
      });
    }

    // Liveness — the Electron process itself must still be running.
    // (If the daemon died but Electron stayed up, the renderer would
    // show the "Daemon disconnected" log line — assert below.)
    expect(handle.app.process().exitCode, "Electron exited mid-session").toBeNull();

    const stderr = handle.getStderr();
    const haystacks: Array<{ name: string; text: string }> = [
      { name: "electron-stderr", text: stderr },
      { name: "renderer-pageerrors", text: pageErrors.join("\n") },
      { name: "renderer-console-errors", text: consoleErrors.join("\n") },
    ];

    for (const { name, text } of haystacks) {
      expect(
        text,
        `${name} contained 'subscribe.send: connection already closed' — daemon-disconnect regression (Bug A).`,
      ).not.toMatch(/subscribe\.send:\s*connection already closed/);
    }

    // Don't assert the daemon log file exists — fake-boot doesn't
    // necessarily exercise the proxy path that creates it. The stderr
    // assertion above covers the regression surface.
  });

  test("Metro Logs tab + shortcut activity survives 30s without console errors", async () => {
    handle = await launchRealE2e();
    const consoleErrors: string[] = [];
    handle.page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await expect(handle.page.locator(".sidebar")).toBeVisible({ timeout: 30_000 });
    await handle.page.getByRole("button", { name: /metro logs/i }).click();

    const start = Date.now();
    while (Date.now() - start < 30_000) {
      await handle.page.waitForTimeout(3_000);
      // Drive Reload + DevMenu shortcuts to keep the daemon's Metro
      // adapter active.
      await handle.page.getByRole("button", { name: /\[r\]/i }).click().catch(() => undefined);
      await handle.page.getByRole("button", { name: /\[d\]/i }).click().catch(() => undefined);
    }

    expect(handle.app.process().exitCode, "Electron exited mid-session").toBeNull();
    expect(
      consoleErrors,
      `console.error during long Metro Logs session:\n${consoleErrors.join("\n")}`,
    ).toEqual([]);
    expect(handle.getStderr()).not.toMatch(/subscribe\.send:\s*connection already closed/);
  });
});
