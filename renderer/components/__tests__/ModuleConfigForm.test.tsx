/** @vitest-environment jsdom */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import { ModuleConfigForm } from '../ModuleConfigForm.js';

// Smoke + boot-window-race coverage for ModuleConfigForm. Phase 13.4.1
// shipped two regressions reported by Martin from the live electron app:
//   1. `{kind:'error', code:'E_CONFIG_SERVICES_PENDING'}` reply shape
//      crashed the React tree because the form set config=undefined.
//   2. After a follow-up fix, the form mounted but stayed stuck on
//      "Loading config…" forever because the retry-on-services-ready
//      path didn't fire.
// Both would have surfaced in this jsdom test before push if it had
// existed. Pre-push verification rule documented in CLAUDE.md.

interface FakeIpcBridge {
  invoke: ReturnType<typeof vi.fn>;
  emit(channel: string, payload: unknown): void;
  on(channel: string, listener: (...args: unknown[]) => void): void;
  off(channel: string, listener: (...args: unknown[]) => void): void;
}

function installFakeIpcBridge(): FakeIpcBridge {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const invoke = vi.fn();
  const bridge: FakeIpcBridge = {
    invoke,
    emit(channel, payload) {
      const set = listeners.get(channel);
      if (!set) return;
      for (const fn of set) fn(payload);
    },
    on(channel, listener) {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(listener);
    },
    off(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
  };
  // The renderer's useIpc hook reads `window.rndev`; mirror its surface.
  (window as unknown as { rndev: FakeIpcBridge }).rndev = bridge;
  return bridge;
}

function uninstallFakeIpcBridge(): void {
  delete (window as unknown as { rndev?: FakeIpcBridge }).rndev;
}

const SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    greeting: {
      type: 'string' as const,
      description: 'A greeting',
    },
  },
};

describe('ModuleConfigForm', () => {
  beforeEach(() => {
    cleanup();
    uninstallFakeIpcBridge();
  });

  it('renders without crashing on mount (TDZ regression guard)', async () => {
    const bridge = installFakeIpcBridge();
    bridge.invoke.mockResolvedValueOnce({
      moduleId: 'test',
      config: {},
    });

    render(<ModuleConfigForm moduleId="test" schema={SCHEMA} />);
    // If hooks are mis-ordered (e.g. a useEffect references state before
    // it's declared), the very first render throws ReferenceError and
    // the entire React tree unmounts. The test would fail with a
    // mount-time error rather than reaching the loading placeholder.
    await waitFor(() => {
      expect(bridge.invoke).toHaveBeenCalledWith('modules:config-get', {
        moduleId: 'test',
        scopeUnit: undefined,
      });
    });
  });

  it('shows the loading placeholder while the modules:config-get invoke is pending', async () => {
    const bridge = installFakeIpcBridge();
    // Hold the invoke deferred so the form stays in its pending state.
    // Phase 13.4.1 follow-up: the Electron handler now `await`s the
    // daemon-client deps before responding, so the renderer's invoke
    // pends until the daemon publishes. The renderer renders "Loading
    // config…" during that wait — no E_CONFIG_SERVICES_PENDING error
    // shape ever reaches the renderer.
    let resolveInvoke: ((value: unknown) => void) | null = null;
    bridge.invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInvoke = resolve;
      }),
    );

    render(<ModuleConfigForm moduleId="test" schema={SCHEMA} />);
    await waitFor(() => {
      expect(screen.getByText(/Loading config/i)).toBeDefined();
    });
    expect(screen.queryByText(/Failed to load config/i)).toBeNull();

    // Resolve the deferred invoke; loading placeholder gives way to
    // the field render.
    act(() => {
      resolveInvoke?.({ moduleId: 'test', config: { greeting: 'hi' } });
    });
    await waitFor(() => {
      expect(screen.queryByText(/Loading config/i)).toBeNull();
    });
  });

  it('surfaces non-pending error codes with the failed-to-load banner', async () => {
    const bridge = installFakeIpcBridge();
    bridge.invoke.mockResolvedValueOnce({
      kind: 'error',
      code: 'E_CONFIG_MODULE_UNKNOWN',
      message: 'Module "ghost" is not registered',
    });

    render(<ModuleConfigForm moduleId="ghost" schema={SCHEMA} />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load config/i)).toBeDefined();
    });
    expect(screen.queryByText(/Loading config/i)).toBeNull();
  });

  it('falls back to the legacy {error: string} shape', async () => {
    const bridge = installFakeIpcBridge();
    bridge.invoke.mockResolvedValueOnce({
      error: 'modules/config/get requires { moduleId: string }',
    });

    render(<ModuleConfigForm moduleId="x" schema={SCHEMA} />);
    await waitFor(() => {
      expect(screen.getByText(/modules\/config\/get requires/i)).toBeDefined();
    });
  });

  it('renders the form once config loads', async () => {
    const bridge = installFakeIpcBridge();
    bridge.invoke.mockResolvedValueOnce({
      moduleId: 'test',
      config: { greeting: 'hi' },
    });

    render(<ModuleConfigForm moduleId="test" schema={SCHEMA} />);
    // The greeting field's description renders only after the config
    // arrives (the loading + error branches return early before the
    // FieldRow tree is built).
    await waitFor(() => {
      expect(screen.getByText('A greeting')).toBeDefined();
    });
  });
});
