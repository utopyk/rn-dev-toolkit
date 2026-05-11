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
