/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSidebarCollapsed } from '../useSidebarCollapsed.js';

describe('useSidebarCollapsed', () => {
  beforeEach(() => { localStorage.clear(); });

  it('defaults to not collapsed', () => {
    const { result } = renderHook(() => useSidebarCollapsed());
    expect(result.current.collapsed).toBe(false);
  });

  it('toggles and persists', () => {
    const { result } = renderHook(() => useSidebarCollapsed());
    act(() => { result.current.toggle(); });
    expect(result.current.collapsed).toBe(true);
    expect(localStorage.getItem('rndev.sidebarCollapsed')).toBe('1');
  });

  it('reads persisted value on init', () => {
    localStorage.setItem('rndev.sidebarCollapsed', '1');
    const { result } = renderHook(() => useSidebarCollapsed());
    expect(result.current.collapsed).toBe(true);
  });
});
