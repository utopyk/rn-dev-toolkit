import type { Theme } from '../types.js';

export const softDark: Theme = {
  name: 'Soft Dark',
  colors: {
    // Neumorphic tokens
    bg:             '#14151E',
    bgSoft:         '#1A1B26',
    surface:        '#1E202B',
    surfaceHi:      '#262833',
    ink:            '#ECEEF5',
    inkSoft:        '#C5C8D2',
    muted:          '#7D8192',
    muted2:         '#525668',
    glow:           '#cc97cc',
    glowWarm:       '#d9b0d9',
    ready:          '#2BD96A',
    booting:        '#FFB020',
    shadowLight:    'rgba(255, 255, 255, 0.05)',
    shadowDark:     'rgba(0, 0, 0, 0.55)',
    shadowDarkSoft: 'rgba(0, 0, 0, 0.35)',
    glowMedium:     '0 3px 14px rgb(193 146 255 / 26%), 0 18px 38px rgb(200 135 255 / 28%)',
    accentBorder:   '#cc97cc',
    bodyBg:         'radial-gradient(1200px 700px at 85% 10%, #1E1F2B 0%, transparent 60%), radial-gradient(900px 700px at 10% 90%, #181A24 0%, transparent 55%), #14151E',
    // Legacy keys
    fg:             '#ECEEF5',
    border:         '#cc97cc',
    accent:         '#cc97cc',
    success:        '#2BD96A',
    warning:        '#FFB020',
    error:          '#f7768e',
    highlight:      '#cc97cc',
    selection:      '#262833',
  },
};

export const softLight: Theme = {
  name: 'Soft Light',
  colors: {
    // Neumorphic tokens
    bg:             '#E8E4F0',
    bgSoft:         '#EEEAF4',
    surface:        '#F5F2FA',
    surfaceHi:      '#FFFFFF',
    ink:            '#1A1F2E',
    inkSoft:        '#2A3042',
    muted:          '#6B6E7D',
    muted2:         '#9A9CA8',
    glow:           '#FF8A2A',
    glowWarm:       '#FFB457',
    ready:          '#2BD96A',
    booting:        '#FFB020',
    shadowLight:    'rgba(255, 255, 255, 0.9)',
    shadowDark:     'rgba(163, 156, 184, 0.55)',
    shadowDarkSoft: 'rgba(163, 156, 184, 0.35)',
    glowMedium:     '0 8px 22px rgb(255 195 146 / 55%), 0 18px 38px rgb(255 224 135 / 28%)',
    accentBorder:   'transparent',
    bodyBg:         'radial-gradient(1200px 700px at 85% 10%, #EFE8F5 0%, transparent 60%), radial-gradient(900px 700px at 10% 90%, #E2DCEC 0%, transparent 55%), #E8E4F0',
    // Legacy keys
    fg:             '#1A1F2E',
    border:         'rgba(163, 156, 184, 0.35)',
    accent:         '#FF8A2A',
    success:        '#2BD96A',
    warning:        '#FFB020',
    error:          '#f7768e',
    highlight:      '#FF8A2A',
    selection:      '#FFFFFF',
  },
};

export const midnight: Theme = {
  name: 'Midnight',
  colors: {
    bg:             '#1a1b26',
    bgSoft:         '#1e1f2e',
    surface:        '#242635',
    surfaceHi:      '#2d2f46',
    ink:            '#c0caf5',
    inkSoft:        '#a9b1d6',
    muted:          '#7a82a8',
    muted2:         '#565f89',
    glow:           '#7aa2f7',
    glowWarm:       '#9dc1ff',
    ready:          '#9ece6a',
    booting:        '#e0af68',
    shadowLight:    'rgba(255, 255, 255, 0.05)',
    shadowDark:     'rgba(0, 0, 0, 0.55)',
    shadowDarkSoft: 'rgba(0, 0, 0, 0.35)',
    glowMedium:     '0 3px 14px rgb(122 162 247 / 32%), 0 18px 38px rgb(157 193 255 / 30%)',
    accentBorder:   '#7aa2f7',
    bodyBg:         'radial-gradient(1200px 700px at 85% 10%, #1e1f2e 0%, transparent 60%), radial-gradient(900px 700px at 10% 90%, #16172a 0%, transparent 55%), #1a1b26',
    fg:             '#c0caf5',
    border:         '#7aa2f7',
    accent:         '#7aa2f7',
    success:        '#9ece6a',
    warning:        '#e0af68',
    error:          '#f7768e',
    highlight:      '#7aa2f7',
    selection:      '#2d2f46',
  },
};

export const ember: Theme = {
  name: 'Ember',
  colors: {
    bg:             '#1c1210',
    bgSoft:         '#221714',
    surface:        '#2a1d19',
    surfaceHi:      '#352520',
    ink:            '#e8d5c4',
    inkSoft:        '#c9b8a8',
    muted:          '#8a6b56',
    muted2:         '#6b4c3b',
    glow:           '#e8976c',
    glowWarm:       '#ffb48a',
    ready:          '#a3be8c',
    booting:        '#ebcb8b',
    shadowLight:    'rgba(255, 220, 200, 0.04)',
    shadowDark:     'rgba(0, 0, 0, 0.55)',
    shadowDarkSoft: 'rgba(0, 0, 0, 0.35)',
    glowMedium:     '0 3px 14px rgb(232 151 108 / 32%), 0 18px 38px rgb(255 180 138 / 30%)',
    accentBorder:   '#e8976c',
    bodyBg:         'radial-gradient(1200px 700px at 85% 10%, #251813 0%, transparent 60%), radial-gradient(900px 700px at 10% 90%, #1e1410 0%, transparent 55%), #1c1210',
    fg:             '#e8d5c4',
    border:         '#e8976c',
    accent:         '#e8976c',
    success:        '#a3be8c',
    warning:        '#ebcb8b',
    error:          '#bf616a',
    highlight:      '#d08770',
    selection:      '#352520',
  },
};

export const arctic: Theme = {
  name: 'Arctic',
  colors: {
    bg:             '#1b2330',
    bgSoft:         '#202a3a',
    surface:        '#253042',
    surfaceHi:      '#2e3a4e',
    ink:            '#d8dee9',
    inkSoft:        '#b8c0cc',
    muted:          '#6b7282',
    muted2:         '#4c566a',
    glow:           '#88c0d0',
    glowWarm:       '#a6d0e0',
    ready:          '#a3be8c',
    booting:        '#ebcb8b',
    shadowLight:    'rgba(255, 255, 255, 0.05)',
    shadowDark:     'rgba(0, 0, 0, 0.55)',
    shadowDarkSoft: 'rgba(0, 0, 0, 0.35)',
    glowMedium:     '0 3px 14px rgb(136 192 208 / 32%), 0 18px 38px rgb(166 208 224 / 30%)',
    accentBorder:   '#88c0d0',
    bodyBg:         'radial-gradient(1200px 700px at 85% 10%, #202a3a 0%, transparent 60%), radial-gradient(900px 700px at 10% 90%, #182030 0%, transparent 55%), #1b2330',
    fg:             '#d8dee9',
    border:         '#88c0d0',
    accent:         '#88c0d0',
    success:        '#a3be8c',
    warning:        '#ebcb8b',
    error:          '#bf616a',
    highlight:      '#b48ead',
    selection:      '#2e3a4e',
  },
};

export const neonDrive: Theme = {
  name: 'Neon Drive',
  colors: {
    bg:             '#0d0d1a',
    bgSoft:         '#111124',
    surface:        '#17172e',
    surfaceHi:      '#20203d',
    ink:            '#e0e0ff',
    inkSoft:        '#bcbcea',
    muted:          '#6060a0',
    muted2:         '#3d3d5c',
    glow:           '#00ffcc',
    glowWarm:       '#40ffe0',
    ready:          '#39ff14',
    booting:        '#ffcc00',
    shadowLight:    'rgba(200, 255, 240, 0.04)',
    shadowDark:     'rgba(0, 0, 0, 0.65)',
    shadowDarkSoft: 'rgba(0, 0, 0, 0.4)',
    glowMedium:     '0 3px 14px rgb(0 255 204 / 32%), 0 18px 38px rgb(255 0 255 / 24%)',
    accentBorder:   '#00ffcc',
    bodyBg:         'radial-gradient(1200px 700px at 85% 10%, #111124 0%, transparent 60%), radial-gradient(900px 700px at 10% 90%, #0a0a18 0%, transparent 55%), #0d0d1a',
    fg:             '#e0e0ff',
    border:         '#00ffcc',
    accent:         '#00ffcc',
    success:        '#39ff14',
    warning:        '#ffcc00',
    error:          '#ff0055',
    highlight:      '#ff00ff',
    selection:      '#20203d',
  },
};

/**
 * Flat — intentionally minimal reference theme. No shadows, no glow, no
 * neumorphic elevation. Structural separation comes from the bg/surface
 * contrast + a visible accent-border on active/hover states. Useful as a
 * starting point for authors who want to build a theme without committing
 * to the soft-UI language.
 *
 * All shadow tokens are `transparent` or zero-offset/transparent strings
 * so the global `--neu-raised` / `--neu-inset` / `--glow-medium` recipes
 * still compose against valid CSS but render invisibly.
 */
export const flat: Theme = {
  name: 'Flat',
  colors: {
    bg:             '#EEF0F4',
    bgSoft:         '#F4F6F9',
    surface:        '#FFFFFF',
    surfaceHi:      '#F4F5F8',
    ink:            '#0F1115',
    inkSoft:        '#2A2F36',
    muted:          '#6B7280',
    muted2:         '#9CA3AF',
    glow:           '#2563EB',
    glowWarm:       '#3B82F6',
    ready:          '#10B981',
    booting:        '#F59E0B',
    shadowLight:    'transparent',
    shadowDark:     'transparent',
    shadowDarkSoft: 'transparent',
    glowMedium:     '0 0 0 transparent, 0 0 0 transparent',
    accentBorder:   '#2563EB',
    bodyBg:         '#EEF0F4',
    fg:             '#0F1115',
    border:         'rgba(15, 17, 21, 0.12)',
    accent:         '#2563EB',
    success:        '#10B981',
    warning:        '#F59E0B',
    error:          '#EF4444',
    highlight:      '#2563EB',
    selection:      '#F4F5F8',
  },
};

/**
 * Cyberneurosis — Edgerunners palette distributed across the status
 * surfaces so every accent (#00F0FF cyan, #F8E602 yellow, #4BFF21 green,
 * #FF2A6D pink, #772289 purple) shows up somewhere in the chrome. Base
 * is a cool blue-black midnight so the neons read as lit signage rather
 * than bruise. glow-medium layers cyan + magenta + green at different
 * radii, echoing the scene's stacked neon bleed.
 */
export const cyberneurosis: Theme = {
  name: 'Cyberneurosis',
  colors: {
    bg:             '#08091A',
    bgSoft:         '#0D0F22',
    surface:        '#12152F',
    surfaceHi:      '#1C2046',
    ink:            '#F4D5FD',
    inkSoft:        '#D9B4E3',
    muted:          '#7A7AA8',
    muted2:         '#4A4A72',
    // Neon-green primary accent (distinct from Neon Drive's teal-cyan).
    // Yellow gets the glow-warm slot so it shows in hover/secondary
    // surfaces, not just booting-status dots.
    glow:           '#4BFF21',
    glowWarm:       '#F8E602',
    ready:          '#4BFF21',
    booting:        '#F8E602',
    shadowLight:    'rgba(244, 213, 253, 0.06)',
    shadowDark:     'rgba(0, 0, 0, 0.7)',
    shadowDarkSoft: 'rgba(0, 0, 0, 0.45)',
    // Triple-halo: green core + yellow mid + pink spread. Cyan sits out
    // of the primary glow to keep a clear separation from Neon Drive.
    glowMedium:     '0 0 14px rgb(75 255 33 / 60%), 0 0 28px rgb(248 230 2 / 35%), 0 18px 42px rgb(255 42 109 / 22%)',
    accentBorder:   '#4BFF21',
    bodyBg:         'radial-gradient(1200px 700px at 85% 10%, #12152F 0%, transparent 60%), radial-gradient(900px 700px at 10% 90%, #0A0A1E 0%, transparent 55%), #08091A',
    fg:             '#F4D5FD',
    border:         '#4BFF21',
    accent:         '#4BFF21',
    success:        '#4BFF21',
    warning:        '#F8E602',
    error:          '#FF2A6D',
    // Cyan finds a home in highlights (log-info), not the hero accent.
    highlight:      '#00F0FF',
    selection:      '#772289',
  },
};

export const allThemes: readonly Theme[] = [softDark, softLight, midnight, ember, arctic, neonDrive, flat, cyberneurosis];

export function getThemeByName(name: string): Theme | undefined {
  return allThemes.find((t) => t.name === name);
}
