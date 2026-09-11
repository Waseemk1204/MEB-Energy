/**
 * The palette, in TypeScript, so it can be asserted against.
 *
 * The console renders from CSS custom properties — this is the same set of
 * values in a form a test can read. It exists because the app already learned
 * that a written claim about contrast is worth nothing until it is measured,
 * and because two copies of a palette drift exactly the way two copies of a
 * capability profile did.
 */

export const light = {
  /**
   * Olive and white, mirroring the app. One theme: the app dropped its dark
   * palette because a mode nothing selects is a mode nobody checks, and the
   * console follows so parity.test.ts has one thing to compare against.
   *
   * `leather` is flat here where the app has a gradient — this is a browser
   * chrome, not an instrument cluster — and it takes the app's middle stop so
   * text checked against the gradient is checked against this too.
   */
  leather: '#4E5B2E',
  leatherStitch: '#93A470',
  leatherInk: '#FFFFFF',
  leatherInkSoft: '#DCE7C2',

  panelBase: '#FFFFFF',
  panelAlt: '#F3F6EC',
  panelStitch: '#DDE5CE',

  inkStrong: '#1F2A16',
  inkSoft: '#53634A',
  inkFaint: '#62725A',

  accent: '#55663A',
  good: '#3B7343',
  warn: '#84620F',
  critical: '#A2391F',

  navPill: '#4A582E',
  navPillInk: '#FFFFFF',
  navInactive: '#62725A',

  /**
   * The focus ring is per-surface, not per-theme.
   *
   * `accent` reads well on the white panel and fails on olive leather, which
   * is where the whole sign-in screen sits — so that surface gets white,
   * measured against the leather rather than assumed.
   */
  focusOnPanel: '#55663A',
  focusOnLeather: '#FFFFFF',
} as const;

/**
 * Kept as an alias so the handful of call sites that still ask for a theme by
 * name resolve, rather than being edited across the console for a distinction
 * that no longer exists.
 */
export const dark = light;

export type Palette = typeof light;
export type ThemeMode = 'light' | 'dark';
