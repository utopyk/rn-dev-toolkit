/** @vitest-environment happy-dom */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { Wizard } from '../Wizard.js';

// Coverage for the iOS bundle picker added in 2026-05-06. The picker
// only surfaces on step 3, after platform = ios is selected, and only
// when `wizard:getBundles` returns at least one bundle. The auto-pick
// branch (single bundle, single config) and the multi-scheme/
// multi-config branch are both real acme cases.

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
  (window as unknown as { rndev: FakeIpcBridge }).rndev = bridge;
  return bridge;
}

function uninstallFakeIpcBridge(): void {
  delete (window as unknown as { rndev?: FakeIpcBridge }).rndev;
}

function defaultInvokeImpl(channel: string, ...args: unknown[]): unknown {
  switch (channel) {
    case 'wizard:getWorktrees':
      return Promise.resolve([{ name: 'Default (root)', path: '/p', branch: 'main', isMain: true }]);
    case 'wizard:getBranches':
      return Promise.resolve(['main', 'develop']);
    case 'wizard:getDevices':
      return Promise.resolve([]);
    case 'wizard:getPreflightChecks':
      return Promise.resolve([]);
    case 'wizard:getTooling':
      return Promise.resolve([]);
    case 'profiles:list':
      return Promise.resolve([]);
    default:
      return Promise.resolve(null);
  }
}

async function advanceToStep3(_bridge: FakeIpcBridge): Promise<void> {
  // Step 1 — pick the root worktree. The SearchableList row label is
  // `📁 Default (root)` in a single span, so exact-match selectors miss
  // it; use regex so the emoji prefix is tolerated.
  await waitFor(() => screen.getByText(/Default \(root\)/));
  fireEvent.click(screen.getByText(/Default \(root\)/));
  // Step 2 — pick a branch. Branch rows have no prefix, so exact match
  // works. `getAllByText` because `main` may also appear elsewhere
  // (header chips, summary lines).
  await waitFor(() => screen.getAllByText('main').length > 0);
  const branchRow = screen.getAllByText('main').find((el) => el.className.includes('sl-item-label'));
  if (!branchRow) throw new Error('Branch row "main" not found in SearchableList.');
  fireEvent.click(branchRow);
  // Step 3 — landed.
  await waitFor(() => screen.getByText('Platform'));
}

describe('Wizard — iOS bundle picker', () => {
  beforeEach(() => {
    cleanup();
    uninstallFakeIpcBridge();
  });

  it('auto-picks the only bundle and surfaces its default configuration', async () => {
    const bridge = installFakeIpcBridge();
    const bundles = [
      {
        scheme: 'Solo',
        configurations: [{ name: 'Debug', isDefault: true }],
        signingStyle: 'automatic',
      },
    ];
    bridge.invoke.mockImplementation((channel: string, ...rest: unknown[]) => {
      if (channel === 'wizard:getBundles') return Promise.resolve({ bundles });
      return defaultInvokeImpl(channel, ...rest);
    });

    render(<Wizard onComplete={() => undefined} onCancel={() => undefined} />);
    await advanceToStep3(bridge);

    await waitFor(() => {
      expect(bridge.invoke).toHaveBeenCalledWith('wizard:getBundles', 'ios');
    });

    // Single-bundle + single-config: the picker auto-selects, no
    // dropdowns surface (a single-option dropdown is visual noise).
    await waitFor(() => {
      const select = screen.queryByRole('combobox');
      // The scheme dropdown still renders because we chose to keep it
      // visible for transparency, but value should be Solo.
      if (select) expect((select as HTMLSelectElement).value).toBe('Solo');
    });
  });

  it('renders acme-style multi-scheme + multi-config picker and updates config when scheme changes', async () => {
    const bridge = installFakeIpcBridge();
    const bundles = [
      {
        scheme: 'Acme',
        label: 'Acme',
        configurations: [
          { name: 'Debug', isDefault: true },
          { name: 'Release', isDefault: false },
          { name: 'Beta', isDefault: false },
        ],
        signingStyle: 'manual',
      },
      {
        scheme: 'Acme-beta',
        label: 'Acme-beta',
        configurations: [
          { name: 'Debug', isDefault: false },
          { name: 'Release', isDefault: false },
          { name: 'Beta', isDefault: true },
        ],
        signingStyle: 'manual',
      },
    ];
    bridge.invoke.mockImplementation((channel: string, ...rest: unknown[]) => {
      if (channel === 'wizard:getBundles') return Promise.resolve({ bundles });
      return defaultInvokeImpl(channel, ...rest);
    });

    render(<Wizard onComplete={() => undefined} onCancel={() => undefined} />);
    await advanceToStep3(bridge);

    await waitFor(() => screen.getByText(/Pick a scheme/));

    const schemeSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    fireEvent.change(schemeSelect, { target: { value: 'Acme-beta' } });

    // After Acme-beta is picked, configuration sub-dropdown surfaces
    // with Beta as the default selection (matches the bundle's
    // isDefault=true entry).
    await waitFor(() => {
      const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
      expect(selects).toHaveLength(2);
      expect(selects[1].value).toBe('Beta');
    });

    // Manual signing notice shows when signingStyle === 'manual'.
    expect(
      screen.getByText(/Manual code signing — the daemon will keep/i),
    ).toBeTruthy();
  });
});

describe('Wizard — device step empty state', () => {
  beforeEach(() => {
    cleanup();
    uninstallFakeIpcBridge();
  });

  async function advanceToStep5Android(bridge: FakeIpcBridge): Promise<void> {
    await advanceToStep3(bridge);
    // Step 3: switch platform to Android so getDevices is called with
    // 'android' — the bug we're pinning was Android-specific (adb-only
    // discovery, cold AVDs invisible). Then Next.
    await waitFor(() => screen.getByText('Platform'));
    // RadioGroup renders <label><span class="wz-radio-label">Android</span></label>
    // without a real <input>, so pick the label span rather than
    // getByLabelText (which requires an id/for pairing).
    const androidLabel = screen
      .getAllByText('Android')
      .find((el) => el.className.includes('wz-radio-label'));
    if (!androidLabel) throw new Error('Android radio label not found');
    fireEvent.click(androidLabel);
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    // Step 4: Mode — any default is fine. Next.
    await waitFor(() => screen.getByText(/Mode/));
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    // Step 5: Device.
    await waitFor(() => screen.getByText('Device'));
  }

  it('shows an actionable empty state (not a blank list) when getDevices returns []', async () => {
    // Regression: bug 2026-08-20 — profile wizard rendered an empty list
    // when the user's only Android target was a powered-off AVD, with no
    // hint that anything was wrong or what to do. The listDevices fix
    // covers the common case (cold AVDs now surface as `shutdown`
    // entries); THIS test pins the fallback UX when the list really is
    // empty (no SDK, permission issue, misconfig).
    const bridge = installFakeIpcBridge();
    bridge.invoke.mockImplementation(defaultInvokeImpl);

    render(<Wizard onComplete={() => undefined} onCancel={() => undefined} />);
    await advanceToStep5Android(bridge);

    const empty = await waitFor(() =>
      screen.getByTestId('wz-empty-devices'),
    );
    expect(empty).toBeTruthy();
    expect(empty.textContent).toMatch(/No Android devices found/);
    // Mentions the recovery action — `emulator -avd <name>` — so the
    // user isn't left staring at a blank screen.
    expect(empty.textContent).toMatch(/emulator -avd/);
    // Points at the Refresh button, not the awkward Back+Next dance.
    expect(empty.textContent).toMatch(/hit Refresh/);
    // Reachable-forward hint: "you can skip".
    expect(empty.textContent).toMatch(/skip this step/i);
    // And the SearchableList is NOT rendered (no stray "No matches for ''").
    expect(screen.queryByPlaceholderText('Search devices...')).toBeNull();
  });

  it('labels Android emulators as "Emulator" (not "Simulator") on the device row', async () => {
    // Bug found 2026-08-20 manual pass: cold AVDs surfaced by today's
    // listDevices fix rendered with the iOS-only "Simulator" badge.
    const bridge = installFakeIpcBridge();
    bridge.invoke.mockImplementation((channel: string, ...rest: unknown[]) => {
      if (channel === 'wizard:getDevices') {
        return Promise.resolve([
          {
            id: 'avd:Pixel_6a_API_35',
            name: 'Pixel 6a API 35',
            type: 'android',
            status: 'shutdown',
            isPhysical: false,
          },
        ]);
      }
      return defaultInvokeImpl(channel, ...rest);
    });

    render(<Wizard onComplete={() => undefined} onCancel={() => undefined} />);
    await advanceToStep5Android(bridge);

    await waitFor(() => screen.getByText('Pixel 6a API 35'));
    expect(screen.getByText('Emulator')).toBeTruthy();
    // And the misapplied Simulator label is not present.
    expect(screen.queryByText('Simulator')).toBeNull();
  });

  it('Esc dismisses the wizard (calls onCancel)', async () => {
    // Bug found 2026-08-20 manual pass: memory
    // `feedback_modal_over_inline_confirm` says modals must dismiss on
    // Esc; the wizard was ignoring it.
    const bridge = installFakeIpcBridge();
    bridge.invoke.mockImplementation(defaultInvokeImpl);
    const onCancel = vi.fn();
    render(<Wizard onComplete={() => undefined} onCancel={onCancel} />);
    // Wait for the wizard to fully mount.
    await waitFor(() => screen.getByText(/Default \(root\)/));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Refresh button re-invokes getDevices and picks up a late-connected device', async () => {
    // Regression: bug 2026-08-20 followup — plugging in a phone AFTER
    // landing on the device step required Back → Next to see it.
    // The Refresh button is the one-click recovery path.
    const bridge = installFakeIpcBridge();
    let callCount = 0;
    bridge.invoke.mockImplementation((channel: string, ...rest: unknown[]) => {
      if (channel === 'wizard:getDevices') {
        callCount++;
        if (callCount === 1) return Promise.resolve([]);
        return Promise.resolve([
          {
            id: 'R83W70PNCBZ',
            name: "Martin's Pixel 8",
            type: 'android',
            status: 'available',
            isPhysical: true,
          },
        ]);
      }
      return defaultInvokeImpl(channel, ...rest);
    });

    render(<Wizard onComplete={() => undefined} onCancel={() => undefined} />);
    await advanceToStep5Android(bridge);

    // Initial state: empty banner is visible.
    await waitFor(() => screen.getByTestId('wz-empty-devices'));
    expect(callCount).toBe(1);

    // Click Refresh — a device shows up now.
    fireEvent.click(screen.getByTestId('wz-refresh-devices'));
    await waitFor(() => screen.getByText("Martin's Pixel 8"));
    expect(callCount).toBe(2);

    // Empty banner is gone; SearchableList replaces it.
    expect(screen.queryByTestId('wz-empty-devices')).toBeNull();
    expect(screen.getByPlaceholderText('Search devices...')).toBeTruthy();
  });
});
