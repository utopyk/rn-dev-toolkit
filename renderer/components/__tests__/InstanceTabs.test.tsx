/** @vitest-environment happy-dom */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { InstanceTabs, type InstanceInfo } from '../InstanceTabs.js';

// 2026-05-07 — InstanceTabs is back to a stateless tab strip after the
// inline two-click confirm was reported as unusual UX. The "are you
// sure" gate now lives in App.tsx as a modal; this component just
// fires onClose synchronously on a single click.

const SAMPLE: InstanceInfo = {
  id: 'main-8081',
  worktreeName: 'acme-mobile-app',
  branch: 'main',
  port: 8081,
  deviceName: "Martin's iPhone 15",
  deviceIcon: '📱',
  platform: 'ios',
  metroStatus: 'running',
};

function renderTabs(overrides: Partial<React.ComponentProps<typeof InstanceTabs>> = {}) {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const onAdd = vi.fn();
  const utils = render(
    <InstanceTabs
      instances={[SAMPLE]}
      activeId={SAMPLE.id}
      onClose={onClose}
      onSelect={onSelect}
      onAdd={onAdd}
      {...overrides}
    />
  );
  return { onClose, onSelect, onAdd, ...utils };
}

describe('InstanceTabs — single-click close (modal-based confirm at App.tsx)', () => {
  beforeEach(() => cleanup());

  it('a single click on the close button fires onClose with the instance id', () => {
    const { onClose } = renderTabs();
    const closeBtn = screen.getByRole('button', { name: /close instance/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(SAMPLE.id);
  });

  it('the close button does not surface a stale "click again" affordance', () => {
    // Regression guard for the pre-2026-05-07 inline confirm pattern.
    // If a future PR reintroduces it, this test catches the affordance
    // string before users see it again.
    renderTabs();
    const closeBtn = screen.getByRole('button', { name: /close instance/i });
    fireEvent.click(closeBtn);
    expect(screen.queryByText(/click again to close/i)).toBeNull();
  });

  it('clicking the close button does not bubble to the tab body (onSelect should not fire)', () => {
    const { onSelect, onClose } = renderTabs({ activeId: 'other' });
    const closeBtn = screen.getByRole('button', { name: /close instance/i });
    fireEvent.click(closeBtn);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the tab body fires onSelect, not onClose', () => {
    // worktreeName gets shortened to 10 chars so the rendered label
    // is "acme-mo…:8081" — match the visible port suffix instead.
    const { onSelect, onClose, container } = renderTabs({ activeId: 'other' });
    const tab = container.querySelector('.instance-tab');
    expect(tab).not.toBeNull();
    fireEvent.click(tab!);
    expect(onSelect).toHaveBeenCalledWith(SAMPLE.id);
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Phase E5 — multi-session UI parity. The renderer treats each
// instance-tab as a session (one daemon session per tab). These tests
// guard the "click the right tab + close the right tab" contract that
// keeps state.activeSessionId in sync with the user's focus.
describe('InstanceTabs — multi-session (Phase E5)', () => {
  beforeEach(() => cleanup());

  const SECOND: InstanceInfo = {
    id: 'feature-8082',
    worktreeName: 'feature-tab',
    branch: 'feature/account-ui',
    port: 8082,
    deviceName: 'Pixel 8',
    deviceIcon: '📱',
    platform: 'android',
    metroStatus: 'running',
  };

  it('renders one tab per instance + an add (+) button', () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const onAdd = vi.fn();
    const { container } = render(
      <InstanceTabs
        instances={[SAMPLE, SECOND]}
        activeId={SAMPLE.id}
        onClose={onClose}
        onSelect={onSelect}
        onAdd={onAdd}
      />,
    );
    expect(container.querySelectorAll('.instance-tab')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /new instance|add instance|\+/i })).toBeTruthy();
  });

  it('clicking the inactive tab fires onSelect with that instance id, not the active one', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <InstanceTabs
        instances={[SAMPLE, SECOND]}
        activeId={SAMPLE.id}
        onClose={vi.fn()}
        onSelect={onSelect}
        onAdd={vi.fn()}
      />,
    );
    const tabs = container.querySelectorAll('.instance-tab');
    expect(tabs).toHaveLength(2);
    // Second tab is the inactive one.
    fireEvent.click(tabs[1]);
    expect(onSelect).toHaveBeenCalledWith(SECOND.id);
    expect(onSelect).not.toHaveBeenCalledWith(SAMPLE.id);
  });

  it('closing the second tab does not fire onClose for the first', () => {
    const onClose = vi.fn();
    render(
      <InstanceTabs
        instances={[SAMPLE, SECOND]}
        activeId={SAMPLE.id}
        onClose={onClose}
        onSelect={vi.fn()}
        onAdd={vi.fn()}
      />,
    );
    const closeButtons = screen.getAllByRole('button', { name: /close instance/i });
    expect(closeButtons).toHaveLength(2);
    fireEvent.click(closeButtons[1]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(SECOND.id);
  });

  it('add button fires onAdd exactly once per click (regression for double-fire)', () => {
    const onAdd = vi.fn();
    render(
      <InstanceTabs
        instances={[SAMPLE, SECOND]}
        activeId={SAMPLE.id}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onAdd={onAdd}
      />,
    );
    const addBtn = screen.getByRole('button', { name: /new instance|add instance|\+/i });
    fireEvent.click(addBtn);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});
