/** @vitest-environment happy-dom */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from '@testing-library/react';
import { WelcomeScreen } from '../WelcomeScreen.js';

// jsdom coverage for the project picker. Guards the wiring the three-layer
// verification standard (CLAUDE.md) wants caught before push:
//   - mounts and loads `project:list` without crashing
//   - clicking a recent / detected / open-folder routes to `project:open`
//   - a failed open surfaces the error verbatim (not a silent no-op)
//   - missing recents are non-actionable

interface FakeBridge {
  invoke: ReturnType<typeof vi.fn>;
}

function installBridge(
  handlers: Record<string, (...args: unknown[]) => unknown>,
): FakeBridge {
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    const h = handlers[channel];
    if (!h) throw new Error(`unexpected channel ${channel}`);
    return h(...args);
  });
  const bridge: FakeBridge = { invoke };
  (window as unknown as { rndev: FakeBridge }).rndev = bridge;
  return bridge;
}

beforeEach(() => {
  cleanup();
  delete (window as unknown as { rndev?: FakeBridge }).rndev;
});

afterEach(() => {
  delete (window as unknown as { rndev?: FakeBridge }).rndev;
});

describe('WelcomeScreen', () => {
  it('renders the heading and Open-folder button', async () => {
    const bridge = installBridge({
      'project:list': () => ({ current: null, recents: [], detected: null }),
    });
    render(<WelcomeScreen />);
    expect(screen.getByText('rn-dev')).toBeTruthy();
    expect(
      screen.getByText('Pick a React Native project to start'),
    ).toBeTruthy();
    expect(screen.getByText('Open a folder…')).toBeTruthy();
    // Flush the async project:list load so the state update lands inside act.
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith('project:list'),
    );
  });

  it('lists recents and opens one on click', async () => {
    const bridge = installBridge({
      'project:list': () => ({
        current: null,
        recents: [
          {
            path: '/Users/x/alpha',
            name: 'alpha',
            lastOpenedAt: '2026-06-15T00:00:00.000Z',
            exists: true,
          },
        ],
        detected: null,
      }),
      'project:open': () => ({ ok: true, path: '/Users/x/alpha' }),
    });
    render(<WelcomeScreen />);
    const item = await screen.findByText('alpha');
    fireEvent.click(item);
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith('project:open', '/Users/x/alpha'),
    );
    // Success keeps the switching state (relaunch is imminent).
    expect(screen.getByText('Switching project…')).toBeTruthy();
  });

  it('disables a missing recent so it cannot be opened', async () => {
    const bridge = installBridge({
      'project:list': () => ({
        current: null,
        recents: [
          {
            path: '/gone',
            name: 'gone',
            lastOpenedAt: '2026-06-15T00:00:00.000Z',
            exists: false,
          },
        ],
        detected: null,
      }),
    });
    render(<WelcomeScreen />);
    await screen.findByText('gone');
    expect(screen.getByText('missing')).toBeTruthy();
    fireEvent.click(screen.getByText('gone'));
    expect(bridge.invoke).not.toHaveBeenCalledWith('project:open', '/gone');
  });

  it('opens the native dialog then commits the returned path', async () => {
    const bridge = installBridge({
      'project:list': () => ({ current: null, recents: [], detected: null }),
      'project:openDialog': () => ({ ok: true, path: '/Users/x/picked' }),
      'project:open': () => ({ ok: true, path: '/Users/x/picked' }),
    });
    render(<WelcomeScreen />);
    fireEvent.click(screen.getByText('Open a folder…'));
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith('project:open', '/Users/x/picked'),
    );
  });

  it('surfaces a dialog validation error', async () => {
    installBridge({
      'project:list': () => ({ current: null, recents: [], detected: null }),
      'project:openDialog': () => ({
        ok: false,
        error: 'That folder is not a React Native project.',
      }),
    });
    render(<WelcomeScreen />);
    fireEvent.click(screen.getByText('Open a folder…'));
    expect(
      await screen.findByText('That folder is not a React Native project.'),
    ).toBeTruthy();
  });

  it('does nothing when the dialog is canceled', async () => {
    const bridge = installBridge({
      'project:list': () => ({ current: null, recents: [], detected: null }),
      'project:openDialog': () => ({ ok: false, canceled: true }),
    });
    render(<WelcomeScreen />);
    fireEvent.click(screen.getByText('Open a folder…'));
    await waitFor(() =>
      expect(bridge.invoke).toHaveBeenCalledWith('project:openDialog'),
    );
    expect(bridge.invoke).not.toHaveBeenCalledWith(
      'project:open',
      expect.anything(),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the detected suggestion and a Cancel when a project is committed', async () => {
    const onCancel = vi.fn();
    installBridge({
      'project:list': () => ({
        current: { path: '/Users/x/current', name: 'current' },
        recents: [],
        detected: { path: '/Users/x/detected', name: 'detected' },
      }),
      'project:open': () => ({ ok: true }),
    });
    render(<WelcomeScreen onCancel={onCancel} />);
    expect(await screen.findByText('detected')).toBeTruthy();
    expect(screen.getByText('Use')).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('hides the detected suggestion when it equals the current project', async () => {
    installBridge({
      'project:list': () => ({
        current: { path: '/Users/x/same', name: 'same' },
        recents: [],
        detected: { path: '/Users/x/same', name: 'same' },
      }),
    });
    render(<WelcomeScreen onCancel={vi.fn()} />);
    await screen.findByText('Cancel');
    // The detected row (its only actionable affordance is the Use button)
    // must not render when it duplicates the current project.
    expect(screen.queryByText('Use')).toBeNull();
  });
});
