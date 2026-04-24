import { describe, it, expect } from 'vitest';
import { softDark, softLight } from '../themes.js';

describe('themes', () => {
  it('softDark has purple accent border and black shadow', () => {
    expect(softDark.colors.accentBorder).toBe('#cc97cc');
    expect(softDark.colors.shadowDark).toBe('rgba(0, 0, 0, 0.55)');
    expect(softDark.colors.ink).toBe('#ECEEF5');
  });

  it('softLight has transparent accent border and orange glow', () => {
    expect(softLight.colors.accentBorder).toBe('transparent');
    expect(softLight.colors.glow).toBe('#FF8A2A');
    expect(softLight.colors.bg).toBe('#E8E4F0');
  });

  it('both themes expose all required tokens', () => {
    const required = ['bg','bgSoft','surface','surfaceHi','ink','inkSoft','muted','muted2','glow','glowWarm','ready','booting','shadowLight','shadowDark','shadowDarkSoft','glowMedium','accentBorder','bodyBg'] as const;
    for (const key of required) {
      expect(softDark.colors[key], `dark missing ${key}`).toBeTruthy();
      expect(softLight.colors[key], `light missing ${key}`).toBeTruthy();
    }
  });

  it('softDark uses purple glow (not orange) for accent consistency', () => {
    expect(softDark.colors.glow).toBe('#cc97cc');
    expect(softDark.colors.accent).toBe('#cc97cc');
    expect(softDark.colors.highlight).toBe('#cc97cc');
    expect(softLight.colors.glow).toBe('#FF8A2A');
  });
});
