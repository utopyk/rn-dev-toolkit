/**
 * In-process TUI test harness — runs OpenTUI components under
 * `@opentui/react/test-utils`'s test renderer, which captures the
 * screen as a plain ASCII buffer (no ANSI parsing) and dispatches
 * mock keystrokes through OpenTUI's real input pipeline.
 *
 * Tests live under `tests/tui/` and run under `bun test`, NOT
 * vitest, because `@opentui/core` uses `bun:ffi` for native renderer
 * bindings — Node-vitest can't load it.
 *
 * Tier in the TUI test pyramid (parity with Electron's three layers):
 *   1. THIS FILE — fast in-process React+OpenTUI render, screen
 *      capture + key contracts. Catches: render crashes, theme
 *      missing, hook order changes, keyboard handler regressions,
 *      wizard-state-machine drift.
 *   2. `tests/tui/spawn-smoke.tui.test.ts` — boots the production
 *      binary (`bun run src/index.tsx start --interactive`) end-to-
 *      end against a fixture worktree. Catches: CLI argv parsing,
 *      `start-flow` boot ordering, daemon-connect startup, theme
 *      effect initialization in a real terminal.
 *   3. `tests/tui/real-boot.tui.test.ts` (gated by `REAL_BOOT_TUI=1`)
 *      — runs against the user's acme fixture, asserts build
 *      progress lines arrive in the log panel within 60s. Mirrors
 *      the Electron real-e2e probe.
 */
import * as React from "react";
import { act } from "react";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { testRender } from "@opentui/react/test-utils";
import type { CliRendererConfig } from "@opentui/core";
import { ThemeProvider, loadTheme } from "../../../src/ui/theme-provider.js";

// ---------------------------------------------------------------------------
// MountTuiOptions / TuiHarness
// ---------------------------------------------------------------------------

export interface MountTuiOptions {
  themeName?: string;
  width?: number;
  height?: number;
  rendererConfig?: Omit<CliRendererConfig, "stdin" | "stdout">;
}

export interface TuiHarness {
  /** Capture the current 80×24 (or configured size) screen as a string. */
  screen(): string;
  /** Press one key (literal char or KeyCodes name like "ENTER", "ARROW_DOWN"). */
  press(key: string): void;
  /** Press Enter. */
  enter(): void;
  /** Press Escape. */
  escape(): void;
  /** Press an arrow key. */
  arrow(direction: "up" | "down" | "left" | "right"): void;
  /** Type a literal text run. */
  type(text: string): Promise<void>;
  /** Pump a frame; resolves when the next render commits. */
  flush(): Promise<void>;
  /**
   * Poll `screen()` until `predicate(screen)` returns true, or fail
   * after `timeoutMs` (default 2 s). Use this for async useEffect
   * settling (filesystem reads, getWorktrees, theme load).
   */
  waitFor(predicate: (screen: string) => boolean, timeoutMs?: number): Promise<void>;
  /** Tear down the renderer + free native resources. */
  cleanup(): void;
}

// ---------------------------------------------------------------------------
// mountTui
// ---------------------------------------------------------------------------

/**
 * Wrap a node in `ThemeProvider` and mount it into the OpenTUI test
 * renderer. Returns an ergonomic `TuiHarness`.
 */
export async function mountTui(
  node: React.ReactElement,
  options: MountTuiOptions = {},
): Promise<TuiHarness> {
  const themeName = options.themeName ?? "midnight";
  const theme = loadTheme(themeName);
  const wrapped = React.createElement(
    ThemeProvider,
    { theme },
    node,
  );

  const setup = await testRender(wrapped, {
    width: options.width ?? 80,
    height: options.height ?? 24,
    ...options.rendererConfig,
  });

  const { mockInput, captureCharFrame, renderOnce, renderer } = setup;

  // All state-mutating ops that touch React's tree run inside `act()`
  // so React's StrictMode-style "wrap in act" warnings stay quiet.
  // OpenTUI's testRender flips IS_REACT_ACT_ENVIRONMENT=true, but the
  // initial mount is the only thing it pre-wraps; subsequent flushes
  // (waitFor polling, key dispatches that trigger setState) need our
  // own act boundary.
  return {
    screen: () => captureCharFrame(),
    press: (key: string): void => {
      act(() => {
        mockInput.pressKey(key);
      });
    },
    enter: (): void => {
      act(() => {
        mockInput.pressEnter();
      });
    },
    escape: (): void => {
      act(() => {
        mockInput.pressEscape();
      });
    },
    arrow: (direction): void => {
      act(() => {
        mockInput.pressArrow(direction);
      });
    },
    type: async (text: string): Promise<void> => {
      await act(async () => {
        await mockInput.typeText(text);
      });
    },
    flush: async (): Promise<void> => {
      await act(async () => {
        await renderOnce();
      });
    },
    waitFor: async (predicate, timeoutMs = 2000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        // Sleep INSIDE the act boundary so async setState (e.g. from
        // a useEffect promise resolving) fires while React is still
        // tracking the act, suppressing the warning.
        await act(async () => {
          await renderOnce();
          await new Promise((r) => setTimeout(r, 25));
        });
        if (predicate(captureCharFrame())) return;
      }
      const final = captureCharFrame();
      throw new Error(
        `tuiHarness.waitFor: predicate did not pass within ${timeoutMs}ms\n--- final screen ---\n${final}\n--- end ---`,
      );
    },
    cleanup: (): void => {
      try {
        act(() => {
          renderer.destroy();
        });
      } catch {
        // Some test renderers expose `stop()` instead of `destroy()`;
        // both are best-effort teardown.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// createTuiFixture — disposable git+RN project root
// ---------------------------------------------------------------------------

export interface TuiFixture {
  /** Realpath-resolved tmpdir, safe to pass to detectProjectRoot. */
  projectRoot: string;
  cleanup(): void;
}

/**
 * Create a tmpdir that satisfies `detectProjectRoot` (package.json with
 * react-native dep) AND `getWorktrees` (initialized git repo). Tests
 * that exercise the wizard need both.
 *
 * The tmpdir is realpath-resolved so callers don't trip the `/private/var`
 * macOS symlink trap (we hit this three times this session).
 */
export function createTuiFixture(opts: { branch?: string } = {}): TuiFixture {
  const raw = mkdtempSync(join(tmpdir(), "rn-dev-tui-"));
  const root = realpathSync.native(raw);

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "tui-fixture",
        version: "0.0.0",
        dependencies: { "react-native": "0.83.0" },
      },
      null,
      2,
    ),
  );

  // Initialize a git repo so `getWorktrees` returns at least the main
  // worktree. `git init -b <branch>` requires git ≥2.28; the repo's
  // baseline is well past that.
  const branch = opts.branch ?? "main";
  execSync(`git init -b ${branch} -q`, { cwd: root });
  execSync(`git config user.email "tui-fixture@local"`, { cwd: root });
  execSync(`git config user.name "TUI Fixture"`, { cwd: root });
  execSync(`git add package.json && git commit -q -m "init"`, { cwd: root });

  // Match production layout — `.rn-dev/profiles/` is where ProfileStore
  // writes profiles. Pre-creating the dir avoids first-write races
  // when tests assert on profile output.
  mkdirSync(join(root, ".rn-dev", "profiles"), { recursive: true });

  return {
    projectRoot: root,
    cleanup: (): void => {
      try {
        rmSync(raw, { recursive: true, force: true });
      } catch {
        // Best-effort — tmpdir cleanup races on macOS are noisy but
        // harmless.
      }
    },
  };
}
