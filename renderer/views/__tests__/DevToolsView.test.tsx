/** @vitest-environment happy-dom */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { DevToolsView } from '../DevToolsView.js';

// Read-only observe coverage. When the GUI observes an agent/MCP session,
// DevToolsView must hide the *mutating* controls — Reconnect/Retry
// (which restart the SHARED per-session CDP proxy) and the target picker
// (which swaps the target the agent's capture is reading). The live
// Fusebox view + target list still render.

interface FakeIpcBridge {
  invoke: ReturnType<typeof vi.fn>;
  on(channel: string, listener: (...args: unknown[]) => void): void;
  off(channel: string, listener: (...args: unknown[]) => void): void;
}

function installBridge(opts: { enableErrors?: Array<{ method: string; message: string }> } = {}): FakeIpcBridge {
  const invoke = vi.fn((channel: string) => {
    if (channel === 'devtools-network:proxy-port') {
      return Promise.resolve({ proxyPort: 9999, sessionNonce: 'nonce' });
    }
    if (channel === 'devtools-network:status') {
      return Promise.resolve({
        meta: {
          proxyStatus: 'connected',
          selectedTargetId: 't1',
          ...(opts.enableErrors ? { enableErrors: opts.enableErrors } : {}),
        },
        targets: [
          { id: 't1', type: 'node', title: 'Hermes A', webSocketDebuggerUrl: 'ws://127.0.0.1/a' },
          { id: 't2', type: 'node', title: 'Hermes B', webSocketDebuggerUrl: 'ws://127.0.0.1/b' },
        ],
        proxyPort: 9999,
        sessionNonce: 'nonce',
      });
    }
    return Promise.resolve(null);
  });
  const bridge: FakeIpcBridge = { invoke, on() {}, off() {} };
  (window as unknown as { rndev: FakeIpcBridge }).rndev = bridge;
  return bridge;
}

describe('DevToolsView — read-only observe mode', () => {
  beforeEach(() => installBridge());
  afterEach(() => {
    cleanup();
    delete (window as unknown as { rndev?: FakeIpcBridge }).rndev;
  });

  it('read-only mode renders the view + read-only chip but NO Reconnect or target picker', async () => {
    const { container } = render(<DevToolsView metroPort={8081} readOnly />);
    await waitFor(() => expect(screen.getByText('React Native DevTools')).toBeTruthy());

    expect(screen.getByText(/read-only/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /reconnect/i })).toBeNull();
    expect(container.querySelector('.devtools-target-select')).toBeNull();
  });

  it('interactive (non-observe) mode shows Reconnect + the target picker', async () => {
    const { container } = render(<DevToolsView metroPort={8081} />);
    await waitFor(() => expect(screen.getByText('React Native DevTools')).toBeTruthy());

    expect(screen.getByRole('button', { name: /reconnect/i })).toBeTruthy();
    // Two targets → the picker renders.
    expect(container.querySelector('.devtools-target-select')).not.toBeNull();
    expect(screen.queryByText(/read-only/i)).toBeNull();
  });

  it('shows a "capture refused" chip when meta.enableErrors is present (2026-06 worklets/multi-host)', async () => {
    cleanup();
    installBridge({
      enableErrors: [
        {
          method: 'Network.enable',
          message: 'The Network domain is unavailable when multiple React Native hosts are registered.',
        },
      ],
    });
    render(<DevToolsView metroPort={8081} />);
    await waitFor(() => expect(screen.getByText('React Native DevTools')).toBeTruthy());

    const chip = await screen.findByText(/capture refused/i);
    expect(chip).toBeTruthy();
    // Tooltip carries the actionable worklets guidance.
    expect(chip.getAttribute('title')).toMatch(/multiple RN hosts|worklets/i);
  });

  it('no "capture refused" chip when capture is healthy', async () => {
    render(<DevToolsView metroPort={8081} />);
    await waitFor(() => expect(screen.getByText('React Native DevTools')).toBeTruthy());
    expect(screen.queryByText(/capture refused/i)).toBeNull();
  });
});
