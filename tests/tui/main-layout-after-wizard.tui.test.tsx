/**
 * T1d — main layout transitions after the wizard completes.
 *
 * Catches: post-wizard handoff regressions. After `onComplete` fires
 * App should set its internal `showWizard` state to false, drop the
 * wizard panel, and render MainLayout's normal module surface
 * (DevSpaceView, tab bar, status bar, etc.). Without coverage,
 * regressions like "wizard never dismisses" or "MainLayout crashes
 * with no profile yet" only surface during real-app use.
 */
import * as React from "react";
import { describe, it, expect, afterEach, mock } from "bun:test";

await mock.module("../../src/core/device.js", () => ({
  listDevices: async () => [
    {
      id: "BOOT-FIXTURE-IOS-1",
      name: "iPhone 15 Fixture",
      type: "ios" as const,
      status: "booted" as const,
      runtime: "iOS-17-0",
      isPhysical: false,
    },
  ],
}));

const { mountTui, createTuiFixture } = await import("./helpers/tui-harness.js");
const { App } = await import("../../src/app/App.js");
const { ModuleRegistry, devSpaceModule, settingsModule } = await import(
  "../../src/modules/index.js"
);
const { loadTheme } = await import("../../src/ui/theme-provider.js");
type TuiHarness = Awaited<ReturnType<typeof mountTui>>;
type TuiFixture = ReturnType<typeof createTuiFixture>;

describe("T1d — post-wizard transition into MainLayout", () => {
  let harness: TuiHarness | null = null;
  let fixture: TuiFixture | null = null;

  afterEach(() => {
    harness?.cleanup();
    fixture?.cleanup();
    harness = null;
    fixture = null;
  });

  it("wizard panel disappears + MainLayout renders modules after onComplete", async () => {
    fixture = createTuiFixture();
    const theme = loadTheme("midnight");
    const registry = new ModuleRegistry();
    registry.register(devSpaceModule);
    registry.register(settingsModule);
    const onWizardComplete = mock(() => {});

    harness = await mountTui(
      <App
        theme={theme}
        registry={registry}
        wizardMode={true}
        projectRoot={fixture.projectRoot}
        onWizardComplete={onWizardComplete as () => void}
      />,
      { width: 100, height: 30 },
    );

    // Wizard mode active — first step's prompt visible. (We assert on
    // the step prompt, not the "Step N/7" indicator, because the
    // indicator's text spans render in a narrow panel and end up
    // visually fragmented in the captured frame — the prompt is the
    // stable signal for "this step is rendered".)
    await harness.waitFor((s) => s.includes("Select a worktree:"));

    // Drive the wizard to completion (same path as T1c).
    harness.enter(); // Worktree → Default
    await harness.waitFor((s) => s.includes("Select a branch:"));
    harness.enter(); // Branch → main
    await harness.waitFor((s) => s.includes("Select target platform:"));
    harness.enter(); // Platform → ios
    await harness.waitFor((s) => s.includes("Select run mode:"));
    harness.enter(); // Mode → dirty
    await harness.waitFor((s) => s.includes("iPhone 15 Fixture"));
    harness.enter(); // Device → first iOS
    await harness.waitFor((s) => s.includes("Which preflight checks"));
    harness.press("n");
    harness.press("c");
    await harness.waitFor((s) => s.includes("on-save") || s.includes("On-Save") || s.includes("on save"), 3000);
    harness.press("s");

    // Wait for the parent's onWizardComplete + the local
    // setShowWizard(false) to land.
    await harness.waitFor(() => onWizardComplete.mock.calls.length > 0);
    await harness.waitFor((s) => !s.includes("Select a worktree:") && !s.includes("Setup Wizard"));

    // Wizard panel is gone, MainLayout remains.
    const screen = harness.screen();
    expect(screen).not.toMatch(/Setup Wizard/);
    expect(screen).not.toMatch(/Select a worktree/);

    // Module tabs render — the registry's two modules are visible
    // in the tab bar. The first module's component is mounted as
    // the active panel (DevSpaceView).
    expect(screen).toContain(devSpaceModule.name);
    expect(screen).toContain(settingsModule.name);

    expect(onWizardComplete).toHaveBeenCalledTimes(1);
  });
});
