/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNotificationsPanelExpanded } from '../useNotificationsPanelExpanded.js';

describe('useNotificationsPanelExpanded', () => {
  beforeEach(() => { localStorage.clear(); });

  it('defaults to not expanded (collapsed)', () => {
    const { result } = renderHook(() => useNotificationsPanelExpanded());
    expect(result.current.expanded).toBe(false);
  });

  it('toggles and persists', () => {
    const { result } = renderHook(() => useNotificationsPanelExpanded());
    act(() => { result.current.toggle(); });
    expect(result.current.expanded).toBe(true);
    expect(localStorage.getItem('rndev.notificationsPanelExpanded')).toBe('1');
  });

  it('reads persisted value on init', () => {
    localStorage.setItem('rndev.notificationsPanelExpanded', '1');
    const { result } = renderHook(() => useNotificationsPanelExpanded());
    expect(result.current.expanded).toBe(true);
  });
});
