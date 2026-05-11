/**
 * T1e — keyboard contracts for `Modal` and `SearchableList`.
 *
 * Catches: keyboard-handler regressions that would crash the TUI in
 * normal use — e.g. a refactor that swaps `event.name === "return"`
 * for `"enter"`, breaks arrow-key navigation, or drops a hotkey from
 * Modal actions.
 *
 * These are pure-component contracts; no fixture worktree, no
 * filesystem IO, no module mocks needed.
 */
import * as React from "react";
import { describe, it, expect, afterEach, mock } from "bun:test";
import { mountTui, type TuiHarness } from "./helpers/tui-harness.js";
import { Modal } from "../../src/ui/components/Modal.js";
import { SearchableList } from "../../src/ui/components/SearchableList.js";

describe("T1e — Modal keyboard contract", () => {
  let harness: TuiHarness | null = null;
  afterEach(() => {
    harness?.cleanup();
    harness = null;
  });

  it("renders title + message + each action label", async () => {
    const onAction = mock(() => {});
    harness = await mountTui(
      <Modal
        title="Confirm Action"
        message="Are you sure you want to proceed?"
        actions={[
          { label: "Yes", key: "y", accent: true },
          { label: "No", key: "n" },
        ]}
        onAction={onAction as (k: string) => void}
      />,
    );
    await harness.flush();
    const screen = harness.screen();
    expect(screen).toContain("Confirm Action");
    expect(screen).toContain("Are you sure you want to proceed?");
    expect(screen).toContain("Yes");
    expect(screen).toContain("No");
  });

  it("dispatches onAction with the matching key when its hotkey is pressed", async () => {
    const onAction = mock(() => {});
    harness = await mountTui(
      <Modal
        title="Delete"
        message="Delete the file?"
        actions={[
          { label: "Yes (y)", key: "y", danger: true },
          { label: "No (n)", key: "n", accent: true },
        ]}
        onAction={onAction as (k: string) => void}
      />,
    );
    await harness.flush();
    harness.press("n");
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith("n");
    harness.press("y");
    expect(onAction).toHaveBeenCalledTimes(2);
    expect(onAction).toHaveBeenLastCalledWith("y");
  });

  it("matches keys case-insensitively", async () => {
    const onAction = mock(() => {});
    harness = await mountTui(
      <Modal
        title="Caps"
        message="Press Q"
        actions={[{ label: "Quit", key: "Q" }]}
        onAction={onAction as (k: string) => void}
      />,
    );
    await harness.flush();
    harness.press("q"); // lowercase still matches "Q" action
    expect(onAction).toHaveBeenCalledWith("Q");
  });
});

describe("T1e — SearchableList keyboard contract", () => {
  let harness: TuiHarness | null = null;
  afterEach(() => {
    harness?.cleanup();
    harness = null;
  });

  interface Row extends Record<string, unknown> {
    label: string;
  }

  const rows: Row[] = [
    { label: "Alpha" },
    { label: "Bravo" },
    { label: "Charlie" },
    { label: "Delta" },
  ];

  it("Enter selects the highlighted item; arrows move the highlight", async () => {
    const onSelect = mock<(item: Row) => void>(() => {});
    harness = await mountTui(
      <SearchableList<Row>
        items={rows}
        labelKey="label"
        onSelect={onSelect}
        placeholder="Search rows..."
      />,
    );
    await harness.waitFor((s) => s.includes("Alpha") && s.includes("Bravo"));

    // First item is highlighted by default — Enter selects Alpha.
    harness.enter();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toEqual({ label: "Alpha" });

    // Arrow down twice → Charlie. Enter selects.
    harness.arrow("down");
    harness.arrow("down");
    harness.enter();
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect.mock.calls[1]?.[0]).toEqual({ label: "Charlie" });
  });

  it("arrow-up from index 0 wraps to the last visible item", async () => {
    const onSelect = mock<(item: Row) => void>(() => {});
    harness = await mountTui(
      <SearchableList<Row>
        items={rows}
        labelKey="label"
        onSelect={onSelect}
      />,
    );
    await harness.waitFor((s) => s.includes("Alpha"));
    harness.arrow("up"); // wraps from 0 → last (Delta)
    harness.enter();
    expect(onSelect.mock.calls[0]?.[0]).toEqual({ label: "Delta" });
  });

  it("typed query narrows the visible list (Fuse fuzzy match)", async () => {
    const onSelect = mock<(item: Row) => void>(() => {});
    harness = await mountTui(
      <SearchableList<Row>
        items={rows}
        labelKey="label"
        onSelect={onSelect}
      />,
    );
    await harness.waitFor((s) => s.includes("Alpha"));

    await harness.type("char");
    // Charlie should still be visible; Alpha should not.
    await harness.waitFor((s) => s.includes("Charlie") && !s.includes("Alpha"));

    // Enter selects the highlighted (now top) result — Charlie.
    harness.enter();
    expect(onSelect.mock.calls[0]?.[0]).toEqual({ label: "Charlie" });
  });
});
