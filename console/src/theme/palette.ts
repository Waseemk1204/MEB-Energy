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
  leather: '#C39D71',
  leatherStitch: '#EFE0C4',
  leatherInk: '#24180A',
  leatherInkSoft: '#3A2B19',

  panelBase: '#FCFAF5',
  panelAlt: '#F4EEE2',
  panelStitch: '#E4D8C2',

  inkStrong: '#241809',
  inkSoft: '#6E5B44',
  inkFaint: '#776B58',

  accent: '#8B6238',
  good: '#4D764C',
  warn: '#936217',
  critical: '#A63B27',

  navPill: '#43301A',
  navPillInk: '#F6EDDB',
  navInactive: '#7F715E',

  /**
   * The focus ring is per-surface, not per-theme.
   *
   * `accent` reads well on the cream panel and fails on leather — measured at
   * 2.15:1, under the 3:1 a focus indicator needs. Since the whole sign-in
   * screen is leather, that is the first thing a keyboard user would have hit.
   */
  focusOnPanel: '#8B6238',
  focusOnLeather: '#24180A',
} as const;

export const dark = {
  leather: '#1A1611',
  leatherStitch: '#4B3E2C',
  leatherInk: '#F3E9D9',
  leatherInkSoft: '#B39A72',

  panelBase: '#191510',
  panelAlt: '#211C15',
  panelStitch: '#362E22',

  inkStrong: '#F3E9D9',
  inkSoft: '#B3A48A',
  inkFaint: '#8F826F',

  accent: '#D6AD73',
  good: '#8AC78E',
  warn: '#DCA84E',
  critical: '#E2775C',

  navPill: '#D6AD73',
  navPillInk: '#171310',
  navInactive: '#867E73',

  focusOnPanel: '#D6AD73',
  focusOnLeather: '#E8C088',
} as const;

export type Palette = typeof light;
export type ThemeMode = 'light' | 'dark';
