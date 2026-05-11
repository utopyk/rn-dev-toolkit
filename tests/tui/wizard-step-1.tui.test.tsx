/**
 * T1b — wizard step 1 (WorktreeStep) boots and renders.
 *
 * Catches: TUI fails to boot, theme initialization throws,
 * `getWorktrees` filesystem read regresses, SearchableList render
 * crashes, theme context drift breaks `useTheme()`.
 */
import * as React from "react";
import { describe, it, expect, afterEach } from "bun:test";
import { mountTui, createTuiFixture, type TuiHarness, type TuiFixture } from "./helpers/tui-harness.js";
import { WorktreeStep } from "../../src/ui/wizard/WorktreeStep.js";

describe("T1b — WorktreeStep boots and renders the picker", () => {
  let harness: TuiHarness | null = null;
  let fixture: TuiFixture | null = null;

  afterEach(() => {
    harness?.cleanup();
    fixture?.cleanup();
    harness = null;
    fixture = null;
  });

  it("renders the prompt + Default option after async getWorktrees resolves", async () => {
    fixture = createTuiFixture();
    harness = await mountTui(
      <WorktreeStep
        projectRoot={fixture.projectRoot}
        onNext={() => {}}
        onBack={() => {}}
      />,
    );

    await harness.waitFor((screen) => screen.includes("Select a worktree:"));

    const screen = harness.screen();
    expect(screen).toContain("Select a worktree:");
    expect(screen).toContain("Default (root repository)");
    expect(screen).toContain("Create new worktree");
    expect(screen).toContain("Press Esc to cancel");
  });

  it("does not crash when getWorktrees finds only the main worktree", async () => {
    fixture = createTuiFixture();
    harness = await mountTui(
      <WorktreeStep
        projectRoot={fixture.projectRoot}
        onNext={() => {}}
      />,
    );

    await harness.waitFor((screen) => screen.includes("Select a worktree:"));
    // No `onBack` prop → "Press Esc to cancel" footer should NOT render.
    expect(harness.screen()).not.toContain("Press Esc to cancel");
  });
});
