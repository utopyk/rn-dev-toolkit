# Electron UI Neumorphic Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Electron renderer's flat Midnight look with the neumorphic "DevSuite" visual language from the provided Figma-style mockups — two locked themes (soft-light with orange glow, soft-dark with purple glow + purple-border active state), floating rounded sidebar that collapses to icons, panel chrome with dual shadows, borderless topbar flowing into content, and professional lucide-react icons replacing the current emoji set. **No content or information-architecture changes** — every view keeps its current structure, children, and behavior; only chrome, tokens, icons, and layout grid change.

**Architecture:** Token-first cascade. Phase 1 defines all design tokens (surface/surface-hi/ink/muted + shadow stacks + radii + accent-border) on `:root` via an extended `Theme`/`ThemeColors` type, plus shared neumorphic utility classes in `global.css`. Phases 2–3 update each component's CSS to consume the tokens and utility classes, so a component-level restyle is a ~30-line CSS diff plus (where relevant) a `<svg>`→`<LucideIcon/>` swap. Phase 4 adds the Settings toggle and a pass of manual QA.

**Tech Stack:** React 19 + Vite in `renderer/`. Electron host. CSS variables for theming (no CSS-in-JS). `lucide-react` for icons (matches mockup's round-cap stroke style). `localStorage` for theme + sidebar-collapse persistence.

**Branch discipline:** Per project convention, work a direct feature branch off `main`, **not** a worktree: `git checkout -b feat/electron-ui-neumorphic-overhaul`. One commit per task, Conventional Commits (`feat(electron-ui): …`, `style(electron): …`, `refactor(electron-ui): …`).

**Testing posture:** Pure CSS/visual changes are verified by launching the Electron dev build (`bun run dev` or `npm run dev` in `renderer/` then `electron .`) and walking each view in both themes. State logic (sidebar collapse persistence, theme-token fixture) gets real vitest unit tests co-located under `renderer/**/__tests__`. Theme switching itself flows through the EXISTING `useTheme()` context + `ModuleConfigForm` + `handleSaved` path in `renderer/views/Settings.tsx` (which already writes to `~/.rn-dev/modules/settings/config.json` via the `modules/config/set` MCP surface — agent-native parity is preserved). No new theme-persistence hook is introduced. Typecheck (`bun run typecheck` at repo root) and existing tests (`npx vitest run` at root) must stay green across every task. New tests that touch the DOM (`useSidebarCollapsed`, testing-library's `renderHook`) declare `/** @vitest-environment jsdom */` at the top of the test file so the root vitest config stays node-env for everything else — no workspace split needed.

---

## Reference — Mockup token map

Extracted verbatim from `devsuite-dashboard.html` (light) and `devsuite-dashboard-dark.html` (dark). **These values are locked — do not drift.**

### Soft-Light theme
```
--bg:             #E8E4F0      /* lavender base */
--bg-soft:        #EEEAF4
--surface:        #F5F2FA      /* panel fill */
--surface-hi:     #FFFFFF      /* active/raised */
--ink:            #1A1F2E      /* primary text */
--ink-soft:       #2A3042      /* section titles */
--muted:          #6B6E7D      /* body-muted */
--muted-2:        #9A9CA8      /* icon-muted */
--glow:           #FF8A2A      /* orange accent */
--glow-warm:      #FFB457
--ready:          #2BD96A
--booting:        #FFB020
--shadow-light:   rgba(255,255,255,0.9)
--shadow-dark:    rgba(163,156,184,0.55)
--shadow-dark-soft: rgba(163,156,184,0.35)
--glow-medium:    0 8px 22px rgb(255 195 146 / 55%), 0 18px 38px rgb(255 224 135 / 28%)
--accent-border:  transparent   /* light theme uses glow-only for active state */

body background:
  radial-gradient(1200px 700px at 85% 10%, #EFE8F5 0%, transparent 60%),
  radial-gradient(900px 700px at 10% 90%, #E2DCEC 0%, transparent 55%),
  var(--bg)
```

### Soft-Dark theme
```
--bg:             #14151E
--bg-soft:        #1A1B26
--surface:        #1E202B
--surface-hi:     #262833
--ink:            #ECEEF5
--ink-soft:       #C5C8D2
--muted:          #7D8192
--muted-2:        #525668
--ready:          #2BD96A
--booting:        #FFB020
--shadow-light:   rgba(255,255,255,0.05)
--shadow-dark:    rgba(0,0,0,0.55)
--shadow-dark-soft: rgba(0,0,0,0.35)
--glow-medium:    0 3px 14px rgb(193 146 255 / 26%), 0 18px 38px rgb(200 135 255 / 28%)
--accent-border:  #cc97cc       /* purple border on active/hover in dark */

body background:
  radial-gradient(1200px 700px at 85% 10%, #1E1F2B 0%, transparent 60%),
  radial-gradient(900px 700px at 10% 90%, #181A24 0%, transparent 55%),
  var(--bg)
```

### Shared radii
```
--radius-sidebar: 28px
--radius-panel:   24px
--radius-card:    20px
--radius-item:    16px
--radius-pill:    999px
```

### Shared shadow recipes
```
--neu-raised:
  -6px -6px 14px var(--shadow-light),
   8px 10px 22px var(--shadow-dark)

--neu-raised-sm:
  -5px -5px 12px var(--shadow-light),
   6px  8px 18px var(--shadow-dark)

--neu-raised-xs:
  -4px -4px 8px var(--shadow-light),
   5px  6px 14px var(--shadow-dark-soft)

--neu-inset:
  inset 3px 3px 6px var(--shadow-dark-soft),
  inset -2px -2px 5px var(--shadow-light)

--neu-inset-strong:
  inset 3px 3px 6px var(--shadow-dark),
  inset -2px -2px 5px var(--shadow-light)

--neu-active-surface:
  inset 2px 2px 5px var(--shadow-light),
  inset -2px -2px 5px rgba(0,0,0,0.03)          /* light */
  /* dark variant uses rgba(0,0,0,0.25) for the second inset */
```

Active/hover state = `background: var(--surface-hi)` + `var(--neu-active-surface)` + `var(--glow-medium)` + (dark only) `border: 1px solid var(--accent-border)`.

---

## File Structure

### New files
- `renderer/theme/themes.ts` — exported `softDark` and `softLight` `Theme` objects with all locked tokens (one responsibility: theme definitions).
- `renderer/components/icons.tsx` — centralized `lucide-react` re-exports + a `getModuleIcon(name)` helper mapping legacy icon strings (emoji/names) to lucide components, so `ModulePanel`-contributed icons keep working (one responsibility: icon registry).
- `renderer/hooks/useSidebarCollapsed.ts` — hook that reads/writes `localStorage['rndev.sidebarCollapsed']`, exposes `{ collapsed, toggle }` (one responsibility: sidebar collapse persistence).

**Note:** No `useThemePreference` hook. Theme switching reuses the existing `useTheme()` context + `ModuleConfigForm`/`handleSaved` flow in `Settings.tsx` — we only swap the `themes[]` array and restyle the picker. Persistence is unchanged from current behavior (through the `settings` module's config-module path).

### Modified files (chrome-only unless noted)
- `renderer/types.ts` — extend `ThemeColors` with new token keys (surface, surfaceHi, ink, inkSoft, muted2, glow, glowWarm, ready, booting, shadowLight, shadowDark, shadowDarkSoft, glowMedium, accentBorder).
- `renderer/theme/ThemeProvider.tsx` — default theme becomes `softDark`; `applyThemeToRoot` writes ALL extended tokens to `:root`; `data-theme` attribute set on `<html>` for theme-gated CSS rules. No persistence added (unchanged from today).
- `renderer/theme/global.css` — update body to radial-gradient bg, define shared `--radius-*` + shadow-recipe vars + utility classes (`.neu-raised`, `.neu-raised-sm`, `.neu-inset`, `.neu-pill`, `.neu-active`). Keep SF Mono font stack.
- `renderer/App.tsx` — replace `<div className="app-root">` flex layout with grid; pass `collapsed` state to `Sidebar`; re-home prompt-modal styling through the utility classes; no behavior changes.
- `renderer/App.css` — grid `260px 1fr` with 28px gap and 28px outer padding; collapsed-state override `72px 1fr`; prompt modal restyle.
- `renderer/components/Sidebar.tsx` — swap ASCII `╦═╗╔╗╗` logo for text "DevSuite" + small subtitle; swap emoji icons for lucide components via `icons.tsx`; add a collapse toggle button at the bottom (above footer or inline with brand); respect `collapsed` prop to hide labels.
- `renderer/components/Sidebar.css` — neumorphic slab; floating with 28px radius; active nav item with `--neu-active-surface` + `--glow-medium` + (dark) purple border; collapsed-mode rules.
- `renderer/components/ProfileBanner.tsx` + `.css` — neumorphic pill/card.
- `renderer/components/StatusBar.tsx` + `.css` — pill shape, inset recess, mono text preserved.
- `renderer/components/InstanceTabs.tsx` + `.css` — tabs as pills-in-a-track with `--neu-inset` track and `--neu-active-surface` + glow on active.
- `renderer/components/LogPanel.tsx` + `.css` — outer container uses `.neu-raised` + `--radius-panel`; inner mono content unchanged.
- `renderer/components/CollapsibleLog.tsx` + `.css` — same.
- `renderer/components/ErrorSummary.tsx` + `.css` — same.
- `renderer/components/ModulePanel.tsx` — wrap module-contributed content in the same `.panel` chrome.
- `renderer/components/ModuleConfigForm.tsx` + `.css` — form inputs get `.neu-inset` track; submit button gets `.neu-raised-xs` + glow hover.
- `renderer/components/ConsentDialog.tsx` + `.css` — modal with `.neu-raised` + 24px radius; backdrop stays dim.
- `renderer/components/UninstallConfirmDialog.tsx` + `.css` — same.
- `renderer/components/SearchableList.tsx` (CSS inline in consumers) — if no dedicated `.css`, inject scoped rules where used (Marketplace, Settings); prefer a single `.searchable-list` class in a new or existing file.
- `renderer/views/DevSpace.tsx` + `.css` — panel chrome on outer containers; no child restructure.
- `renderer/views/MetroLogs.tsx` — wrap in panel chrome.
- `renderer/views/DevToolsView.tsx` + `.css` — panel chrome.
- `renderer/views/Marketplace.tsx` + `.css` — panel chrome; module cards get `.neu-raised-sm` + accent-border hover.
- `renderer/views/Settings.tsx` + `.css` — replace `themes[]` array (Midnight/Ember/Arctic/Neon Drive) with `[softDark, softLight]`; keep the existing theme-grid card UI but restyle cards with neumorphic chrome; `SETTINGS_CONFIG_SCHEMA.properties.theme.enum` naturally becomes `['Soft Dark','Soft Light']` since it is derived from `themes.map(t => t.name)`. The `handleSaved`/`setTheme` flow is preserved verbatim — agent-native parity intact (`modules/config/set { theme: 'Soft Light' }` continues to work).
- `renderer/views/LintTest.tsx` — wrap content in `.neu-raised` chrome (inline styles, matches `MetroLogs.tsx` pattern — no `.css` file exists for this view).
- `renderer/views/Wizard.tsx` + `.css` — dialog chrome, step indicators as pills.
- `renderer/views/NewInstanceDialog.tsx` + `.css` — dialog chrome.
- `renderer/package.json` — add `lucide-react`.

---

## Phase 1 — Foundation

Goal: land tokens + shared utility classes + both themes + icon library, so later phases are mechanical CSS swaps. Nothing visible changes yet for the user because the components haven't adopted the new classes — typecheck must still pass.

### Task 1.1: Extend `ThemeColors` type

**Files:**
- Modify: `renderer/types.ts`

- [ ] **Step 1** — Extend the `ThemeColors` interface in `renderer/types.ts:2-13` to include the full neumorphic token set. Final shape:

```ts
export interface ThemeColors {
  // Legacy (keep to avoid cascading breaks; map to new tokens where sensible)
  bg: string;
  fg: string;
  border: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  muted: string;
  highlight: string;
  selection: string;
  // Neumorphic tokens
  bgSoft: string;
  surface: string;
  surfaceHi: string;
  ink: string;
  inkSoft: string;
  muted2: string;
  glow: string;
  glowWarm: string;
  ready: string;
  booting: string;
  shadowLight: string;
  shadowDark: string;
  shadowDarkSoft: string;
  glowMedium: string;           /* multi-part shadow string, applied verbatim */
  accentBorder: string;         /* 'transparent' in light */
  bodyBg: string;               /* full radial-gradient string incl. fallback */
}
```

- [ ] **Step 2** — Run typecheck: `cd renderer && npx tsc --noEmit`. Expect failures in `ThemeProvider.tsx` (missing fields in `defaultTheme`) — that's fine, Task 1.2 addresses them.

- [ ] **Step 3** — Commit:

```bash
git add renderer/types.ts
git commit -m "refactor(electron-ui): extend ThemeColors with neumorphic tokens"
```

### Task 1.2: Define `softDark` + `softLight` theme objects

**Files:**
- Create: `renderer/theme/themes.ts`
- Test: `renderer/theme/__tests__/themes.test.ts`

- [ ] **Step 1 — Write the failing test** at `renderer/theme/__tests__/themes.test.ts`:

```ts
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
});
```

- [ ] **Step 2 — Run test, verify failure**: `npx vitest run renderer/theme/__tests__/themes.test.ts`. Expected: module-not-found error.

- [ ] **Step 3 — Create `renderer/theme/themes.ts`** with both themes. Use the exact values from the "Reference — Mockup token map" section above. Include the full `bodyBg` radial-gradient string per theme. Map legacy keys so nothing crashes: `bg`, `fg`→`ink`, `border`→`accentBorder` or `shadow-dark-soft`, `accent`→`glow`, `muted`, `success`→`ready`, `warning`→`booting`, `error`=`#f7768e` (keep), `highlight`=`glow`, `selection`=`surfaceHi`.

- [ ] **Step 4 — Re-run test**: `npx vitest run renderer/theme/__tests__/themes.test.ts`. Expected: PASS.

- [ ] **Step 5 — Commit:**

```bash
git add renderer/theme/themes.ts renderer/theme/__tests__/themes.test.ts
git commit -m "feat(electron-ui): define softDark and softLight theme tokens"
```

### Task 1.3: Update `ThemeProvider` to apply all tokens + support named themes

**Files:**
- Modify: `renderer/theme/ThemeProvider.tsx`

- [ ] **Step 1** — Replace `defaultTheme` with `import { softDark } from './themes.js'`. Delete the `darken()` helper (no longer needed; `bgSoft` is explicit now). Expand `applyThemeToRoot` to write every key with the exact `--kebab-case` CSS var name. Important mappings:

```ts
root.style.setProperty('--bg', colors.bg);
root.style.setProperty('--bg-soft', colors.bgSoft);
root.style.setProperty('--surface', colors.surface);
root.style.setProperty('--surface-hi', colors.surfaceHi);
root.style.setProperty('--ink', colors.ink);
root.style.setProperty('--ink-soft', colors.inkSoft);
root.style.setProperty('--fg', colors.ink);                 /* legacy alias */
root.style.setProperty('--muted', colors.muted);
root.style.setProperty('--muted-2', colors.muted2);
root.style.setProperty('--glow', colors.glow);
root.style.setProperty('--glow-warm', colors.glowWarm);
root.style.setProperty('--accent', colors.glow);            /* legacy alias */
root.style.setProperty('--ready', colors.ready);
root.style.setProperty('--booting', colors.booting);
root.style.setProperty('--success', colors.ready);          /* legacy alias */
root.style.setProperty('--warning', colors.booting);        /* legacy alias */
root.style.setProperty('--error', colors.error);
root.style.setProperty('--shadow-light', colors.shadowLight);
root.style.setProperty('--shadow-dark', colors.shadowDark);
root.style.setProperty('--shadow-dark-soft', colors.shadowDarkSoft);
root.style.setProperty('--glow-medium', colors.glowMedium);
root.style.setProperty('--accent-border', colors.accentBorder);
root.style.setProperty('--body-bg', colors.bodyBg);
root.style.setProperty('--border', colors.accentBorder === 'transparent' ? 'rgba(26,31,46,0.15)' : colors.accentBorder);
root.style.setProperty('--selection', colors.surfaceHi);
root.style.setProperty('--highlight', colors.glow);
root.style.setProperty('--panel-focus', colors.surfaceHi);
root.setAttribute('data-theme', theme.name.toLowerCase().replace(/\s+/g, '-'));
```

- [ ] **Step 2** — Run typecheck: `cd renderer && npx tsc --noEmit`. Expected: PASS.

- [ ] **Step 3** — Manual smoke: `cd renderer && npm run dev` (or `bun run dev`). App should still launch. Current flat styling looks the same since no CSS consumes new tokens yet. Kill dev server.

- [ ] **Step 4 — Commit:**

```bash
git add renderer/theme/ThemeProvider.tsx
git commit -m "refactor(electron-ui): apply full neumorphic token set in ThemeProvider"
```

### Task 1.4: Update `global.css` with radii, shadow recipes, utility classes, body radial bg

**Files:**
- Modify: `renderer/theme/global.css`

- [ ] **Step 1** — Append the following to `renderer/theme/global.css` (do not remove existing scrollbar / reset rules, but update `body` block):

```css
/* ── Radii + shadow recipes (consumed by utilities) ── */
:root {
  --radius-sidebar: 28px;
  --radius-panel:   24px;
  --radius-card:    20px;
  --radius-item:    16px;
  --radius-pill:    999px;

  --neu-raised:
    -6px -6px 14px var(--shadow-light),
     8px 10px 22px var(--shadow-dark);

  --neu-raised-sm:
    -5px -5px 12px var(--shadow-light),
     6px  8px 18px var(--shadow-dark);

  --neu-raised-xs:
    -4px -4px 8px var(--shadow-light),
     5px  6px 14px var(--shadow-dark-soft);

  --neu-inset:
    inset 3px 3px 6px var(--shadow-dark-soft),
    inset -2px -2px 5px var(--shadow-light);

  --neu-inset-strong:
    inset 3px 3px 6px var(--shadow-dark),
    inset -2px -2px 5px var(--shadow-light);
}

/* ── Body now paints the radial gradient set by ThemeProvider ── */
body {
  background: var(--body-bg, var(--bg));
  color: var(--ink, var(--fg));
  /* keep existing font-family + font-size + user-select rules */
}

/* ── Neumorphic utility classes ── */
.neu-raised {
  background: var(--surface);
  border-radius: var(--radius-panel);
  box-shadow: var(--neu-raised);
}
.neu-raised-sm {
  background: var(--surface);
  border-radius: var(--radius-card);
  box-shadow: var(--neu-raised-sm);
}
.neu-raised-xs {
  background: var(--surface);
  border-radius: var(--radius-pill);
  box-shadow: var(--neu-raised-xs);
}
.neu-inset {
  background: var(--surface);
  box-shadow: var(--neu-inset);
}
.neu-inset-strong {
  background: var(--surface);
  box-shadow: var(--neu-inset-strong);
}
.neu-pill {
  border-radius: var(--radius-pill);
  padding: 10px 18px;
}
.neu-active {
  background: var(--surface-hi);
  color: var(--ink);
  border: 1px solid var(--accent-border);
  box-shadow:
    inset 2px 2px 5px var(--shadow-light),
    inset -2px -2px 5px rgba(0,0,0,0.03),
    var(--glow-medium);
}
[data-theme^="soft-dark"] .neu-active {
  box-shadow:
    inset 2px 2px 5px var(--shadow-light),
    inset -2px -2px 5px rgba(0,0,0,0.25),
    var(--glow-medium);
}
.neu-hover-accent:hover {
  border: 1px solid var(--accent-border);
  box-shadow: var(--neu-raised-xs), var(--glow-medium);
}
```

- [ ] **Step 2** — Launch dev (`cd renderer && npm run dev` + run Electron). Body should now have the subtle radial-gradient lavender (or near-black) wash. Nothing else changes. Kill.

- [ ] **Step 3 — Commit:**

```bash
git add renderer/theme/global.css
git commit -m "feat(electron-ui): add neumorphic radii, shadow recipes, utility classes"
```

### Task 1.5: Install `lucide-react` + create `icons.tsx` registry

**Files:**
- Modify: `renderer/package.json`
- Create: `renderer/components/icons.tsx`

- [ ] **Step 1** — Install: `cd renderer && npm install lucide-react@^0.460.0 --save`. (Version pinned conservatively; the minor matters less than the API, which has been stable since 0.3xx.)

- [ ] **Step 2** — Create `renderer/components/icons.tsx`:

```tsx
import React from 'react';
import {
  Terminal, Clock, Store, Settings as SettingsIcon,
  Wrench, FlaskConical, Radio, Bell, Zap, User,
  Search, Smartphone, Package, RefreshCw, Menu,
  Trash2, Eye, X, Plus, Play, Square, ChevronLeft,
  ChevronRight, ChevronDown, AlertTriangle, CheckCircle2,
  Gauge, Box, History, type LucideIcon,
} from 'lucide-react';

export const Icons = {
  terminal: Terminal, clock: Clock, store: Store, settings: SettingsIcon,
  wrench: Wrench, flask: FlaskConical, radio: Radio, bell: Bell,
  zap: Zap, user: User, search: Search, phone: Smartphone,
  package: Package, refresh: RefreshCw, menu: Menu, trash: Trash2,
  eye: Eye, close: X, plus: Plus, play: Play, stop: Square,
  chevronLeft: ChevronLeft, chevronRight: ChevronRight, chevronDown: ChevronDown,
  alert: AlertTriangle, check: CheckCircle2, gauge: Gauge, box: Box,
  history: History,
} satisfies Record<string, LucideIcon>;

/** Map legacy emoji/string icon identifiers to lucide components. */
const LEGACY_MAP: Record<string, LucideIcon> = {
  '🚀': Terminal, '🔧': Wrench, '🧪': FlaskConical, '📡': Radio,
  '🛒': Store, '⚙': SettingsIcon, '📦': Package, '💻': Smartphone,
  '📱': Smartphone, '🗑': Trash2,
};

export function getModuleIcon(hint: string | undefined): LucideIcon {
  if (!hint) return Package;
  if (LEGACY_MAP[hint]) return LEGACY_MAP[hint];
  const k = hint.toLowerCase() as keyof typeof Icons;
  if (Icons[k]) return Icons[k];
  return Package;
}

export function ModuleIcon({ hint, size = 18 }: { hint?: string; size?: number }) {
  const Cmp = getModuleIcon(hint);
  return <Cmp size={size} strokeWidth={2} />;
}
```

- [ ] **Step 3** — Typecheck: `cd renderer && npx tsc --noEmit`. Expected: PASS.

- [ ] **Step 4 — Commit:**

```bash
git add renderer/package.json renderer/package-lock.json renderer/components/icons.tsx
git commit -m "feat(electron-ui): add lucide-react and icon registry"
```

---

## Phase 2 — App shell (sidebar, topbar, profile, tabs, status bar)

Goal: the outer chrome now matches the mockup. Content inside each view is untouched.

### Task 2.1: Restructure app grid

**Files:**
- Modify: `renderer/App.tsx`
- Modify: `renderer/App.css`

- [ ] **Step 1** — Replace `.app-root` rules in `renderer/App.css`:

```css
.app-root {
  min-height: 100vh;
  display: grid;
  grid-template-columns: var(--sidebar-w, 260px) 1fr;
  gap: 28px;
  padding: 28px;
  overflow: hidden;
}

.app-root.collapsed { --sidebar-w: 72px; }

.app-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 20px;
  padding: 0;       /* was padding-top: 8px — the grid gap handles spacing */
}

.app-content {
  flex: 1;
  display: flex;
  min-height: 0;
  position: relative;
}
```

- [ ] **Step 2** — In `renderer/App.tsx`, add `const [sidebarCollapsed, setSidebarCollapsed] = useState(false)` (persistence follows in 2.4). Update `.app-root` className to `` `app-root${sidebarCollapsed ? ' collapsed' : ''}` ``. No other behavior changes.

- [ ] **Step 3** — Also update the prompt-modal rules in `renderer/App.css` to use `.neu-raised` chrome:

```css
.prompt-modal {
  background: var(--surface);
  border-radius: var(--radius-panel);
  box-shadow: var(--neu-raised), var(--glow-medium);
  padding: 28px 32px;
  max-width: 480px;
  width: 100%;
  border: 1px solid var(--accent-border);
}

.prompt-title { color: var(--ink); font-size: 16px; margin-bottom: 8px; font-weight: 600; }
.prompt-message { color: var(--muted); font-size: 13px; margin-bottom: 16px; line-height: 1.5; }
.prompt-option {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 18px;
  border-radius: var(--radius-item);
  background: var(--surface);
  color: var(--ink);
  font-size: 13px;
  box-shadow: var(--neu-raised-xs);
  border: 1px solid transparent;
  cursor: pointer;
  transition: box-shadow 220ms ease, border-color 220ms ease;
}
.prompt-option:hover { border-color: var(--accent-border); box-shadow: var(--neu-raised-xs), var(--glow-medium); }
.prompt-option-cleanup { color: var(--booting); font-size: 11px; }
```

- [ ] **Step 4** — Launch Electron. Verify: app paints with 28px outer margin, 28px gap between sidebar and main. Sidebar still looks flat (restyle is next task). No crashes. Kill.

- [ ] **Step 5 — Commit:**

```bash
git add renderer/App.tsx renderer/App.css
git commit -m "style(electron): grid shell with 260px sidebar + 28px gutters"
```

### Task 2.2: Restyle `Sidebar` chrome (slab + brand text + sections)

**Files:**
- Modify: `renderer/components/Sidebar.tsx`
- Modify: `renderer/components/Sidebar.css`

- [ ] **Step 1** — In `Sidebar.tsx`, replace the three `.logo-lN` `<div>`s (lines 60-64) with:

```tsx
<div className="sidebar-brand">
  <h1 className="sidebar-brand-name">RN Dev</h1>
  <span className="sidebar-brand-sub">Developer Suite</span>
</div>
```

Keep everything else (Modules section, Extensions, Shortcuts, Footer) untouched. Icon swaps come in 2.3.

- [ ] **Step 2** — Rewrite `renderer/components/Sidebar.css` from scratch:

```css
/* Frameless-window drag region: the whole sidebar is draggable by default,
   with interactive children explicitly set no-drag. This preserves window
   drag in collapsed mode too (where the brand is hidden). */
.sidebar {
  background: var(--surface);
  border-radius: var(--radius-sidebar);
  padding: 28px 20px;
  display: flex;
  flex-direction: column;
  box-shadow: -8px -8px 20px var(--shadow-light), 10px 12px 28px var(--shadow-dark);
  overflow-y: auto;
  -webkit-app-region: drag;
  transition: padding 220ms ease;
}
.sidebar button,
.sidebar .sidebar-item,
.sidebar .sidebar-shortcut,
.sidebar .sidebar-collapse-toggle,
.sidebar .sidebar-new-worktree { -webkit-app-region: no-drag; }

.sidebar-brand { padding: 6px 10px 26px; }
.sidebar-brand-name {
  font-size: 20px; font-weight: 700; letter-spacing: -0.02em;
  color: var(--ink); margin: 0;
}
.sidebar-brand-sub {
  display: block; margin-top: 4px;
  font-size: 11px; color: var(--muted);
}

.sidebar-section { display: flex; flex-direction: column; gap: 6px; margin-bottom: 20px; }
.sidebar-section-title {
  padding: 0 10px; margin-bottom: 6px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.14em;
  color: var(--muted); text-transform: uppercase;
}

.sidebar-item {
  display: flex; align-items: center; gap: 14px;
  padding: 12px 14px;
  border-radius: var(--radius-item);
  color: var(--muted);
  font-size: 13px;
  font-weight: 500;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  transition: color 160ms ease, background 220ms ease, box-shadow 220ms ease, border-color 220ms ease;
}
.sidebar-item:hover { color: var(--ink); background: var(--surface-hi); border-color: var(--accent-border); box-shadow: var(--glow-medium); }
.sidebar-item.active {
  background: var(--surface-hi);
  color: var(--ink);
  border-color: var(--accent-border);
  box-shadow:
    inset 2px 2px 5px var(--shadow-light),
    inset -2px -2px 5px rgba(0,0,0,0.03),
    var(--glow-medium);
}
[data-theme^="soft-dark"] .sidebar-item.active {
  box-shadow:
    inset 2px 2px 5px var(--shadow-light),
    inset -2px -2px 5px rgba(0,0,0,0.25),
    var(--glow-medium);
}

.sidebar-module-icon {
  width: 18px; height: 18px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--muted-2);
  flex-shrink: 0;
}
.sidebar-item.active .sidebar-module-icon,
.sidebar-item:hover .sidebar-module-icon { color: var(--ink); }

.sidebar-shortcuts {
  margin-top: 8px;
  padding-top: 16px;
  border-top: 1px solid var(--shadow-dark-soft);
}
.sidebar-shortcut {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 14px;
  font-size: 11px;
  color: var(--muted);
  width: 100%; text-align: left;
  border-radius: var(--radius-item);
  background: transparent; border: 0;
  cursor: pointer;
  transition: color 160ms ease, background 160ms ease;
}
.sidebar-shortcut:hover { color: var(--ink); background: var(--surface-hi); }
.sidebar-shortcut .shortcut-key { color: var(--glow); font-weight: 700; min-width: 24px; font-size: 10px; }

.sidebar-footer { margin-top: auto; padding-top: 12px; }
.sidebar-new-worktree {
  width: 100%;
  padding: 10px 14px;
  background: var(--surface);
  border-radius: var(--radius-item);
  border: 1px dashed var(--muted-2);
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 160ms ease, color 160ms ease, box-shadow 220ms ease;
}
.sidebar-new-worktree:hover {
  border-color: var(--accent-border);
  color: var(--ink);
  box-shadow: var(--glow-medium);
}
```

- [ ] **Step 3** — Launch Electron. Verify sidebar is now a floating rounded slab with neumorphic shadow; nav items look like soft pills; active item has glow (and in dark, the purple border). ASCII logo is gone. Icons are still emoji for now. Kill.

- [ ] **Step 4 — Commit:**

```bash
git add renderer/components/Sidebar.tsx renderer/components/Sidebar.css
git commit -m "style(electron): neumorphic floating sidebar chrome + brand text"
```

### Task 2.3: Swap sidebar emoji icons for lucide

**Files:**
- Modify: `renderer/components/Sidebar.tsx`

- [ ] **Step 1** — Add `import { ModuleIcon, Icons } from './icons.js';` at top.

- [ ] **Step 2** — Replace the `builtinModules` array to use lucide refs, and render via `ModuleIcon`:

```tsx
const builtinModules = [
  { id: 'dev-space',  hint: 'terminal', label: 'Dev Space' },
  { id: 'devtools',   hint: 'wrench',   label: 'DevTools' },
  { id: 'lint-test',  hint: 'flask',    label: 'Lint & Test' },
  { id: 'metro-logs', hint: 'radio',    label: 'Metro Logs' },
  { id: 'marketplace',hint: 'store',    label: 'Marketplace' },
  { id: 'settings',   hint: 'settings', label: 'Settings' },
];
```

And in the JSX:

```tsx
<span className="sidebar-module-icon"><ModuleIcon hint={mod.hint} size={18} /></span>
```

For the Extensions loop, use `<ModuleIcon hint={panel.icon} size={18} />` — `getModuleIcon` handles both emoji legacy and name hints.

- [ ] **Step 3** — Launch Electron. Verify every sidebar item is now a lucide line icon, 18×18, stroke matching the design. Emoji are gone. Kill.

- [ ] **Step 4 — Commit:**

```bash
git add renderer/components/Sidebar.tsx
git commit -m "style(electron): replace sidebar emoji icons with lucide-react"
```

### Task 2.4: Sidebar collapse-to-icons (state, hook, toggle button)

**Files:**
- Create: `renderer/hooks/useSidebarCollapsed.ts`
- Create: `renderer/hooks/__tests__/useSidebarCollapsed.test.ts`
- Modify: `renderer/App.tsx`
- Modify: `renderer/components/Sidebar.tsx`
- Modify: `renderer/components/Sidebar.css`

- [ ] **Step 1 — Failing test** at `renderer/hooks/__tests__/useSidebarCollapsed.test.ts`. The `/** @vitest-environment jsdom */` docblock on line 1 gives this file a jsdom environment (root vitest config is node-env by default); no workspace split or new config file needed.

```ts
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
```

Install the test deps at the repo root (where vitest lives): `bun add -d @testing-library/react jsdom` (or `npm install --save-dev @testing-library/react jsdom` depending on your preference — `bun` is the project convention). The root `vitest.config.ts` stays `environment: "node"` unchanged; the per-file docblock flips it for this one test file.

- [ ] **Step 2 — Run test**: `npx vitest run renderer/hooks/__tests__/useSidebarCollapsed.test.ts` (from repo root). Expected: FAIL (module-not-found).

- [ ] **Step 3 — Create hook** at `renderer/hooks/useSidebarCollapsed.ts`:

```ts
import { useState, useCallback } from 'react';

const KEY = 'rndev.sidebarCollapsed';

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  });
  const toggle = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);
  return { collapsed, toggle };
}
```

- [ ] **Step 4 — Re-run test, expect PASS**.

- [ ] **Step 5** — Wire into `App.tsx`: replace the static `useState(false)` with `const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebarCollapsed();`. Pass `collapsed={sidebarCollapsed}` and `onToggleCollapse={toggleSidebar}` into `<Sidebar/>` (all three places it is rendered).

- [ ] **Step 6** — Update `Sidebar.tsx` props interface to include `collapsed: boolean; onToggleCollapse: () => void;`. At the top of the rendered sidebar (just after the brand), add a compact toggle button:

```tsx
<button className="sidebar-collapse-toggle" onClick={onToggleCollapse} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
  <ModuleIcon hint={collapsed ? 'chevronRight' : 'chevronLeft'} size={14} />
</button>
```

Wrap the root div className: `` `sidebar${collapsed ? ' collapsed' : ''}` ``. In collapsed mode, hide labels and section titles via CSS (next step).

- [ ] **Step 7** — Append to `Sidebar.css`:

```css
.sidebar-collapse-toggle {
  position: absolute;
  top: 32px; right: -14px;
  width: 28px; height: 28px;
  border-radius: 50%;
  background: var(--surface-hi);
  border: 1px solid var(--accent-border);
  color: var(--muted);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  box-shadow: var(--neu-raised-xs);
  z-index: 1;
}
.sidebar-collapse-toggle:hover { color: var(--ink); box-shadow: var(--neu-raised-xs), var(--glow-medium); }

.sidebar { position: relative; }

.sidebar.collapsed { padding: 28px 10px; }
.sidebar.collapsed .sidebar-brand,
.sidebar.collapsed .sidebar-section-title,
.sidebar.collapsed .sidebar-item-label,
.sidebar.collapsed .shortcut-label,
.sidebar.collapsed .sidebar-new-worktree,
.sidebar.collapsed .sidebar-footer { display: none; }
.sidebar.collapsed .sidebar-item { justify-content: center; padding: 12px 0; }
.sidebar.collapsed .sidebar-shortcut { justify-content: center; padding: 6px 0; }
```

- [ ] **Step 8** — Launch Electron. Click the toggle button: sidebar collapses to 72px icon-only column; click again: back to 260px. Refresh renderer: state persists. Kill.

- [ ] **Step 9 — Commit:**

```bash
git add renderer/hooks/useSidebarCollapsed.ts renderer/hooks/__tests__/useSidebarCollapsed.test.ts renderer/App.tsx renderer/components/Sidebar.tsx renderer/components/Sidebar.css
git commit -m "feat(electron-ui): collapsible sidebar with persistence"
```

### Task 2.5: Restyle `ProfileBanner`

**Files:**
- Modify: `renderer/components/ProfileBanner.css`

- [ ] **Step 1** — Read current CSS to learn class names: `cat renderer/components/ProfileBanner.css`.

- [ ] **Step 2** — Rewrite root container to use `.neu-raised-sm` equivalents: `background: var(--surface)`, `border-radius: var(--radius-card)`, `box-shadow: var(--neu-raised-sm)`, `padding: 14px 20px`, color: `var(--ink)` for labels, `var(--muted)` for meta. Preserve existing class names.

- [ ] **Step 3** — Launch; verify banner is a rounded raised card, not a flat strip. Kill.

- [ ] **Step 4 — Commit:**

```bash
git add renderer/components/ProfileBanner.css
git commit -m "style(electron): neumorphic chrome on ProfileBanner"
```

### Task 2.6: Restyle `InstanceTabs` as pill-in-track

**Files:**
- Modify: `renderer/components/InstanceTabs.css`

- [ ] **Step 1** — Outer container: `padding: 6px`, `border-radius: var(--radius-pill)`, `background: var(--surface)`, `box-shadow: var(--neu-inset)`. Individual tabs: `border-radius: var(--radius-pill)`, `padding: 8px 16px`, muted color. Active tab: `.neu-active`. Close button + Add button: round `.neu-raised-xs`. Preserve classes.

- [ ] **Step 2** — Verify in app with ≥ 2 instances (or browser-only simulated instance is fine). Kill.

- [ ] **Step 3 — Commit:**

```bash
git add renderer/components/InstanceTabs.css
git commit -m "style(electron): pill-in-track InstanceTabs"
```

### Task 2.7: Restyle `StatusBar`

**Files:**
- Modify: `renderer/components/StatusBar.css`

- [ ] **Step 1** — Container: `background: var(--surface)`, `border-radius: var(--radius-pill)`, `padding: 10px 20px`, `box-shadow: var(--neu-inset)`, `color: var(--muted)`, font-size 12px. Metro-status dot uses `--ready`/`--booting`/`--error` with a 10px circle + `box-shadow: 0 0 10px currentColor;`.

- [ ] **Step 2** — Verify. Kill.

- [ ] **Step 3 — Commit:**

```bash
git add renderer/components/StatusBar.css
git commit -m "style(electron): pill-shaped inset StatusBar"
```

---

## Phase 3 — Panels, views, dialogs

Goal: every scrollable/content area inherits panel chrome. Each task is one logical grouping; keep each to < 50-line CSS diff per file.

### Task 3.1: View panels — DevSpace, MetroLogs, DevToolsView, Marketplace, Settings, LintTest

**Files:**
- Modify: `renderer/views/DevSpace.css`
- Modify: `renderer/views/DevToolsView.css`
- Modify: `renderer/views/Marketplace.css`
- Modify: `renderer/views/Settings.css`
- Modify: `renderer/views/MetroLogs.tsx` (no `.css` — inline-style the wrapper)
- Modify: `renderer/views/LintTest.tsx` (no `.css` — inline-style the wrapper, same pattern as MetroLogs)

- [ ] **Step 1** — For each view's root-container class (e.g. `.dev-space`, `.devtools-view`, `.marketplace`, `.settings-view`): apply `background: var(--surface)`, `border-radius: var(--radius-panel)`, `box-shadow: var(--neu-raised)`, `padding: 24px 28px`, `overflow: auto`. Inner section titles (where present): `font-size: 15px`, `font-weight: 500`, `color: var(--ink-soft)`, `margin-bottom: 14px`.

- [ ] **Step 2** — For `MetroLogs.tsx` and `LintTest.tsx`: add `className="neu-raised"` to the outermost `<div>`, plus `style={{ padding: '24px 28px', overflow: 'auto' }}`. Keep mono content and existing behavior.

- [ ] **Step 3** — Launch, walk every view in both themes (toggle Soft Dark ↔ Soft Light in Settings once Task 4.1 lands; until then, temporarily edit `ThemeProvider`'s default import to force `softLight` for one pass, then revert). Verify: chrome present, no double-scrollbar, mono content readable, no stray legacy `border: 1px solid var(--border)` lines cutting through. Kill.

- [ ] **Step 4 — Commit:**

```bash
git add renderer/views/DevSpace.css renderer/views/DevToolsView.css renderer/views/Marketplace.css renderer/views/Settings.css renderer/views/MetroLogs.tsx renderer/views/LintTest.tsx
git commit -m "style(electron): neumorphic panel chrome on main views"
```

### Task 3.2: Log components — LogPanel, CollapsibleLog, ErrorSummary, ModulePanel

**Files:**
- Modify: `renderer/components/LogPanel.css`
- Modify: `renderer/components/CollapsibleLog.css`
- Modify: `renderer/components/ErrorSummary.css`
- Modify: `renderer/components/ModulePanel.tsx`

- [ ] **Step 1** — LogPanel + CollapsibleLog root: `background: var(--surface)`, `border-radius: var(--radius-panel)`, `box-shadow: var(--neu-raised-sm)`, `overflow: hidden`. Line content keeps SF Mono. Section headers inside CollapsibleLog: `background: var(--surface-hi)`, `padding: 10px 16px`, `border-bottom: 1px solid var(--shadow-dark-soft)`. Status icons → lucide (`Icons.check`, `Icons.alert`, `Icons.play`, `Icons.stop`) via `<ModuleIcon hint="..."/>`.

- [ ] **Step 2** — ErrorSummary root: `.neu-raised-sm` + warning accent border (`border: 1px solid var(--booting)`).

- [ ] **Step 3** — ModulePanel (`ModulePanel.tsx`): wrap the root `<div>` with className that sets `.neu-raised` + `padding: 24px`. If the component currently returns children directly, add a wrapper.

- [ ] **Step 4** — Launch; generate a build/lint run in browser-only mode to populate logs; verify both themes. Kill.

- [ ] **Step 5 — Commit:**

```bash
git add renderer/components/LogPanel.css renderer/components/CollapsibleLog.css renderer/components/ErrorSummary.css renderer/components/ModulePanel.tsx
git commit -m "style(electron): neumorphic chrome on log + module panels"
```

### Task 3.3: Forms and inputs — SearchableList, ModuleConfigForm

**Files:**
- Modify: `renderer/components/SearchableList.tsx`
- Modify: `renderer/components/ModuleConfigForm.css`

- [ ] **Step 1** — SearchableList: the search input gets `.neu-inset` styling — `background: var(--surface)`, `border-radius: var(--radius-pill)`, `padding: 12px 18px`, `box-shadow: var(--neu-inset)`, border 0. List rows: `border-radius: var(--radius-item)`, hover `.neu-hover-accent`.

- [ ] **Step 2** — ModuleConfigForm.css: inputs/selects get `.neu-inset` + pill radius. Submit button `.neu-raised-xs` + glow hover.

- [ ] **Step 3** — Launch, visit Marketplace → install flow, verify consent form / config form. Kill.

- [ ] **Step 4 — Commit:**

```bash
git add renderer/components/SearchableList.tsx renderer/components/ModuleConfigForm.css
git commit -m "style(electron): soft-UI inputs and buttons on forms"
```

### Task 3.4: Dialogs — Wizard, NewInstanceDialog, ConsentDialog, UninstallConfirmDialog

**Files:**
- Modify: `renderer/views/Wizard.css`
- Modify: `renderer/views/NewInstanceDialog.css`
- Modify: `renderer/components/ConsentDialog.css`
- Modify: `renderer/components/UninstallConfirmDialog.css`

- [ ] **Step 1** — For each modal root: backdrop kept as `rgba(0,0,0,0.45)` + `backdrop-filter: blur(2px)`. Modal body: `.neu-raised` + `border: 1px solid var(--accent-border)` + `max-width` between 480–640px depending on current values. Header font 18px weight 600 color `var(--ink)`. Buttons: primary = filled dark with glow shadow (`background: var(--ink); color: #fff`); secondary = `.neu-raised-xs`.

- [ ] **Step 2** — Launch, trigger the Wizard (`onOpenWizard` via footer button), verify. Test Marketplace install → ConsentDialog. Test Marketplace uninstall → UninstallConfirmDialog. Test InstanceTabs "+" → NewInstanceDialog. Kill.

- [ ] **Step 3 — Commit:**

```bash
git add renderer/views/Wizard.css renderer/views/NewInstanceDialog.css renderer/components/ConsentDialog.css renderer/components/UninstallConfirmDialog.css
git commit -m "style(electron): neumorphic dialog chrome across modals"
```

---

## Phase 4 — Settings integration + QA pass

### Task 4.1: Replace `themes[]` with soft-dark + soft-light + restyle picker

**Files:**
- Modify: `renderer/views/Settings.tsx`
- Modify: `renderer/views/Settings.css`

**Context:** `renderer/views/Settings.tsx:13-46` currently declares a `themes: Theme[]` array with Midnight/Ember/Arctic/Neon Drive — all flat, legacy Midnight-era. `SETTINGS_CONFIG_SCHEMA.properties.theme.enum` at line 66 is derived from `themes.map(t => t.name)`. `handleSaved` at lines 79-88 applies the selected theme via `setTheme(match)`. The MCP path is: `modules/config/set { theme: 'Soft Dark' }` → config-module → `onSaved` → `handleSaved` → `setTheme`. We preserve that path entirely; we just replace the array contents and restyle the grid. The server manifest at `src/modules/built-in/manifests.ts` declares only `type: 'string'` with NO enum — so it doesn't need to change. The parity test at `renderer/__tests__/settings-schema-parity.test.ts` checks property names + types only — also unaffected.

- [ ] **Step 1** — In `renderer/views/Settings.tsx`, add `import { softDark, softLight } from '../theme/themes.js';` and replace the entire `themes: Theme[]` array (lines 13-46) with:

```ts
const themes: Theme[] = [softDark, softLight];
```

Delete the inline Midnight/Ember/Arctic/Neon Drive declarations. No other code in the file changes — `themes.map(t => t.name)` now yields `['Soft Dark','Soft Light']` automatically, `handleSaved`/`setTheme` path is untouched, the theme-grid map still works (it will just render 2 cards).

- [ ] **Step 2** — Restyle `.theme-grid`, `.theme-card`, `.theme-preview`, `.theme-swatch`, `.theme-name` in `renderer/views/Settings.css` to match the neumorphic language:

```css
.theme-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 20px;
  max-width: 520px;
}
.theme-card {
  background: var(--surface);
  border: 1px solid transparent;
  border-radius: var(--radius-card);
  box-shadow: var(--neu-raised-sm);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  cursor: pointer;
  transition: transform 220ms ease, box-shadow 260ms ease, border-color 260ms ease;
}
.theme-card:hover { transform: translateY(-2px); border-color: var(--accent-border); box-shadow: var(--neu-raised-sm), var(--glow-medium); }
.theme-card.active {
  border-color: var(--accent-border);
  box-shadow:
    inset 2px 2px 5px var(--shadow-light),
    inset -2px -2px 5px rgba(0,0,0,0.03),
    var(--glow-medium);
}
[data-theme^="soft-dark"] .theme-card.active {
  box-shadow:
    inset 2px 2px 5px var(--shadow-light),
    inset -2px -2px 5px rgba(0,0,0,0.25),
    var(--glow-medium);
}
.theme-preview {
  height: 96px;
  border-radius: var(--radius-item);
  padding: 14px;
  display: flex;
  gap: 10px;
  box-shadow: var(--neu-inset);
}
.theme-swatch {
  width: 18px; height: 18px;
  border-radius: 50%;
  box-shadow: 0 0 8px currentColor;
}
.theme-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  letter-spacing: 0.02em;
}
.settings-view { /* .neu-raised applied in Task 3.1, reconfirm */ }
.settings-title { font-size: 20px; font-weight: 600; color: var(--ink); margin-bottom: 20px; }
.settings-section { margin-bottom: 28px; }
.settings-section-title { font-size: 14px; font-weight: 500; color: var(--ink-soft); margin-bottom: 12px; letter-spacing: -0.01em; }
.settings-section-description { font-size: 12px; color: var(--muted); margin-bottom: 14px; }
```

- [ ] **Step 3** — Launch Electron, open Settings. Verify: two cards render (Soft Dark + Soft Light), swatches use real theme colors (orange/ready/booting for dark, same plus reds for light), clicking a card applies the theme instantly, active card shows the accent glow + purple border (in dark) / orange glow (in light). Then open the `ModuleConfigForm` in Preferences — the `theme` select lists "Soft Dark" and "Soft Light". Change it there; the theme also applies via `handleSaved`. Kill.

- [ ] **Step 4** — Run parity test to confirm no regression: `npx vitest run renderer/__tests__/settings-schema-parity.test.ts`. Expected: PASS.

- [ ] **Step 5 — Commit:**

```bash
git add renderer/views/Settings.tsx renderer/views/Settings.css
git commit -m "feat(electron-ui): replace legacy themes with soft-dark + soft-light"
```

### Task 4.2: Full-app QA sweep + screenshots

**Files:** (no code changes expected; fix any defects found)

- [ ] **Step 1** — Launch Electron. For **each** theme (soft-dark, soft-light), visit every view: Dev Space, DevTools, Lint & Test, Metro Logs, Marketplace, Settings, Wizard, plus any module-contributed panel present. Verify:
  - Sidebar slab shadow renders on both themes (dark: subtle light + deep black; light: bright white + lavender).
  - Active nav item shows glow (orange light / purple dark) AND purple border (dark only).
  - Topbar has NO divider/border separating it from main content area.
  - No stray `border: 1px solid var(--border)` lines bleeding through (legacy rules).
  - Radii look correct: 28 sidebar, 24 panels, 20 small cards, 999 pills.
  - Sidebar collapse works and layout reflows cleanly at 72px.
  - Instance tabs pill look correct with active glow.
  - Log content preserves SF Mono font.
  - Scrollbars are thin and theme-colored, not black.

- [ ] **Step 2** — Save screenshots under `docs/brainstorms/` (not committed to git if too heavy, OR to `/tmp`):
  - `electron-soft-dark-devspace.png`
  - `electron-soft-dark-marketplace.png`
  - `electron-soft-dark-sidebar-collapsed.png`
  - `electron-soft-light-devspace.png`
  - `electron-soft-light-marketplace.png`

- [ ] **Step 3** — For each defect found, open a fix commit (`fix(electron-ui): <what>`). If none, skip.

- [ ] **Step 4 — Run typecheck + tests from the repo root:**

```bash
bun run typecheck
npx vitest run
```

Both must be green. `bun run typecheck` covers BOTH the main project and `renderer/tsconfig.json` per Phase 10's `electron/tsconfig.json` setup (see `project_electron_tsc_gap.md` in memory for history).

- [ ] **Step 5 — Commit** (only if defects found):

```bash
git add <changed-files>
git commit -m "fix(electron-ui): QA-round polish"
```

### Task 4.3: Sweep for legacy Midnight tokens

**Files:** search + fix anywhere they appear.

- [ ] **Step 1** — Search for leftover literal hex codes from the four legacy themes (Midnight/Ember/Arctic/Neon Drive) that should now reference tokens. Covers every accent/bg/fg across all four:

```bash
# Midnight
grep -rn "#1a1b26\|#c0caf5\|#7aa2f7\|#bb9af7\|#565f89\|#283457\|#9ece6a\|#e0af68\|#f7768e" renderer/
# Ember
grep -rn "#1c1210\|#e8d5c4\|#6b4c3b\|#e8976c\|#d08770\|#3b2520\|#a3be8c\|#ebcb8b\|#bf616a" renderer/
# Arctic
grep -rn "#1b2330\|#d8dee9\|#4c566a\|#88c0d0\|#b48ead\|#2e3440" renderer/
# Neon Drive
grep -rn "#0d0d1a\|#e0e0ff\|#3d3d5c\|#00ffcc\|#ff00ff\|#39ff14\|#ffcc00\|#ff0055\|#1a1a33" renderer/
```

Any remaining literal hex codes should become token references (e.g. `var(--surface)`, `var(--ink)`, `var(--glow)`, `var(--ready)`, `var(--booting)`). The four legacy theme definitions in `Settings.tsx` are already gone after Task 4.1.

- [ ] **Step 2** — Also check for lingering `var(--fg)` / `var(--border)` usages that would cascade correctly but read clearer as `var(--ink)` / `var(--accent-border)`. Migration is optional; fix only where a component looks off in one theme.

- [ ] **Step 3 — Commit** (if changes):

```bash
git add <changed-files>
git commit -m "refactor(electron-ui): migrate lingering literal colors to tokens"
```

### Task 4.4: Branch wrap-up

- [ ] **Step 1** — Final `git log --oneline main..HEAD` — should read as a coherent story. Rebase-squash locally is optional; prefer per-task commits preserved for reviewability.

- [ ] **Step 2** — Push branch: `git push -u origin feat/electron-ui-neumorphic-overhaul`.

- [ ] **Step 3** — Open PR via `gh pr create` with title `feat(electron-ui): neumorphic soft-UI overhaul (soft-dark + soft-light)`. Body should include:
  - Before/after screenshot pairs (both themes, sidebar collapsed + expanded).
  - List of locked design tokens (copy from plan's Reference section).
  - Callout that no content or IA changed — chrome only.
  - Call out the lucide-react dependency bump.

---

## Non-goals (YAGNI guardrails)

- **No** new views or features. Electron's current IA is preserved verbatim.
- **No** replacement of SF Mono with Inter/SF Pro anywhere. Mono is the house font.
- **No** FAB / floating terminal button — that was mockup-only.
- **No** auto-theme-from-OS detection in v1. Default `soft-dark`, toggle in Settings. A future task can add `prefers-color-scheme` sync.
- **No** new theme-persistence mechanism. The existing `settings` module config path persists via `~/.rn-dev/modules/settings/config.json` and applies on Settings mount — unchanged.
- **No** animation beyond existing CSS transitions (160–260ms on color/box-shadow/border-color already in the utility classes).
- **No** server-side module-system changes. `src/modules/built-in/manifests.ts` `theme` field is `type: 'string'` with no enum — the renderer-side enum narrowing is where the four legacy theme names get replaced by the two new ones. The parity test at `renderer/__tests__/settings-schema-parity.test.ts` asserts property names + types only, so no server change is required.

## Risks and open decisions

1. **SF Mono + neumorphic**: mono at weight 600–700 can feel heavy. If QA reveals the brand / labels look cramped, *consider* nudging `letter-spacing` looser (e.g. `0.01em`) in `global.css`. Do NOT switch fonts without the user's approval — they explicitly locked SF Mono.
2. **ProfileBanner placement**: the mockup places profile inside the sidebar footer. This plan keeps it in its existing App-level position (just restyled). If the user later asks to move it, that's a separate PR.
3. **`getModuleIcon` legacy map**: emoji strings shipped via MCP `panels[].icon` will now render as lucide equivalents. Any emoji not in `LEGACY_MAP` falls back to the generic `Package` icon. If a third-party module uses an emoji we didn't map, the fallback is acceptable until the module migrates.
4. **Theme flash on launch (pre-existing, unchanged)**: the app always paints `softDark` first, then `ModuleConfigForm` in Settings loads persisted config and may re-apply a different theme. This was already the case with the four legacy themes; this PR doesn't make it worse. Out of scope to fix — would need either an inline bootstrap script reading from disk (requires preload-IPC shim) or a small localStorage first-paint cache. File a follow-up if annoying.
5. **Frameless-window drag region**: Task 2.2's sidebar rewrite makes the entire `.sidebar` draggable (`-webkit-app-region: drag`) with interactive children explicitly `no-drag`. This preserves window drag in collapsed mode (where the brand is hidden) — which the mockup-driven layout otherwise would have lost. Verify during QA by dragging the window both with the sidebar expanded (brand area) and collapsed (icon column).

---

**Estimated total: ~24 commits across 4 phases. First two phases land the visible transformation; phase 3 polishes; phase 4 ships the toggle + QA.**
