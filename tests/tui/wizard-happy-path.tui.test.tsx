/**
 * T1c — wizard happy path. Drive the WizardContainer through all 7
 * steps with mockInput keystrokes; assert `onComplete` is called
 * with the expected profile shape.
 *
 * Catches: any wizard regression that breaks profile creation. The
 * H2 wizard scheme picker bug landed on Electron-side; the TUI side
 * had no equivalent test until now. Mid-step state-transition bugs
 * (e.g. the `ultra-clean` mode rejection) would surface here as
 * "wizard reaches PreflightStep but onComplete never fires."
 *
 * `listDevices` is module-mocked so the test is deterministic across
 * dev machines (with iOS sim) and CI (without).
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeAll, mock } from "bun:test";

// Mock device listing BEFORE importing the wizard tree, so the
// mocked module is the one the steps see at evaluation time.
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
const { WizardContainer } = await import("../../src/ui/wizard/WizardContainer.js");
type TuiHarness = Awaited<ReturnType<typeof mountTui>>;
type TuiFixture = ReturnType<typeof createTuiFixture>;

describe("T1c — wizard happy path produces a profile via onComplete", () => {
  let harness: TuiHarness | null = null;
  let fixture: TuiFixture | null = null;

  afterEach(() => {
    harness?.cleanup();
    fixture?.cleanup();
    harness = null;
    fixture = null;
  });

  it("happy path through all 7 steps fires onComplete with the expected profile", async () => {
    fixture = createTuiFixture();
    let completedProfile: unknown = null;
    const onComplete = mock((p: unknown) => {
      completedProfile = p;
    });
    const onCancel = mock(() => {});

    harness = await mountTui(
      <WizardContainer
        projectRoot={fixture.projectRoot}
        onComplete={onComplete as (p: unknown) => void}
        onCancel={onCancel as () => void}
      />,
    );

    // Step 1 — WorktreeStep. SearchableList lands on first item
    // ("Default (root repository)"); Enter confirms.
    await harness.waitFor((s) => s.includes("Select a worktree:"));
    harness.enter();

    // Step 2 — BranchStep. The fixture commits onto `main`, so
    // getRecentBranches surfaces it as the first row.
    await harness.waitFor((s) => s.includes("Step 2/7") && s.includes("Branch"));
    await harness.waitFor((s) => s.includes("main"));
    harness.enter();

    // Step 3 — PlatformStep. Default initialValue="ios" → first row
    // already highlighted; Enter confirms.
    await harness.waitFor((s) => s.includes("Step 3/7") && s.includes("Platform"));
    harness.enter();

    // Step 4 — ModeStep. Default initialValue="dirty"; Enter confirms.
    await harness.waitFor((s) => s.includes("Step 4/7") && s.includes("Mode"));
    harness.enter();

    // Step 5 — DeviceStep. listDevices is mocked to return our one
    // fixture iPhone; Enter selects it.
    await harness.waitFor((s) => s.includes("Step 5/7") && s.includes("Device"));
    await harness.waitFor((s) => s.includes("iPhone 15 Fixture"));
    harness.enter();

    // Step 6 — PreflightStep. Press `n` (deselect all preflight
    // checks), then `c` (confirm). With zero selected, the step
    // skips the frequency phase and calls onNext directly.
    await harness.waitFor((s) => s.includes("Step 6/7") && s.includes("Preflight"));
    harness.press("n");
    harness.press("c");

    // Step 7 — OnSaveStep. Press `s` to skip on-save tooling.
    await harness.waitFor((s) => s.includes("Step 7/7") && s.includes("On-Save"));
    harness.press("s");

    // onComplete should fire with our composed profile.
    await harness.waitFor(() => onComplete.mock.calls.length > 0);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(completedProfile).toMatchObject({
      worktree: null, // "Default (root)"
      branch: "main",
      platform: "ios",
      mode: "dirty",
      devices: { ios: "BOOT-FIXTURE-IOS-1" },
      buildVariant: "debug",
      preflight: { checks: [], frequency: "once" },
      onSave: [],
      projectRoot: fixture.projectRoot,
    });
  });
});
