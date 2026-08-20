/** @vitest-environment happy-dom */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ProfileBanner } from '../ProfileBanner.js';
import type { ProfileInfo } from '../../types.js';

const BASE: ProfileInfo = {
  name: 'session-1',
  branch: 'feat/upload-center-diagnostics',
  platform: 'ios',
  dirty: true,
  port: 8081,
  buildType: 'debug',
};

describe('ProfileBanner', () => {
  it('renders the branch always', () => {
    render(<ProfileBanner profile={BASE} />);
    expect(screen.getByText('feat/upload-center-diagnostics')).toBeTruthy();
    cleanup();
  });

  it('renders the short SHA next to the branch when provided', () => {
    // Regression: bug 2026-08-20 — two agents sharing one checkout
    // couldn't see the tree had drifted because the banner showed no
    // HEAD signal. Rendering the short SHA makes drift visible at a
    // glance in both tabs.
    render(<ProfileBanner profile={{ ...BASE, headSha: 'a1b2c3d' }} />);
    expect(screen.getByText('@a1b2c3d')).toBeTruthy();
    cleanup();
  });

  it('omits the SHA element when headSha is null/undefined', () => {
    render(<ProfileBanner profile={{ ...BASE, headSha: null }} />);
    expect(screen.queryByText(/@[a-f0-9]{7}/)).toBeNull();
    cleanup();
  });
});
