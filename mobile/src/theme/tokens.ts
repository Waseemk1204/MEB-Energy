/**
 * Design tokens — "Bentley cluster".
 *
 * Two materials, two meanings:
 *   leather = live primary instrumentation, always pinned
 *   panel   = data, lists and controls, always scrolls
 *
 * Both themes are complete token sets. Never derive one by inverting the other.
 */

export const palette = {
  /**
   * One theme, olive and white.
   *
   * The tan leather became olive and, because olive is dark where tan was
   * light, the ink on it inverted: white on the hero, dark on the panels. Both
   * materials still mean what they meant -- leather is live instrumentation and
   * never scrolls, panel is data and always does.
   *
   * There is deliberately no dark palette. A second theme that nothing selects
   * is a second theme nobody checks, and the contrast tests were carrying twice
   * the assertions for a mode the app will not ship.
   *
   * Every value below is held to 4.5:1 by contrast.test.ts. The gradient's
   * lightest stop is as light as it can be while `leatherInkSoft` still clears
   * the bar on it -- that stop is the worst case, and it is what fixes the
   * ceiling here.
   */
  light: {
    leatherGradient: ['#5A6836', '#4E5B2E', '#425027'] as const,
    leatherStitch: '#93A470',
    leatherInk: '#FFFFFF',
    leatherInkSoft: '#DCE7C2',
    leatherTrack: '#76855A',
    leatherNeedle: '#FFFFFF',
    leatherHub: '#2E3A1F',

    panelBase: '#FFFFFF',
    panelAlt: '#F3F6EC',
    panelStitch: '#DDE5CE',
    panelTrack: '#E7EDDD',
    panelNeedle: '#2E3A1F',

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
    backdrop: '#EEF2E4',

    needleEdge: 'rgba(0,0,0,0.28)',
    panelShadow: 'rgba(31,42,22,0.10)',
  },
} as const;

/** One mode. Kept as a type so call sites read the same. */
export type ThemeMode = keyof typeof palette;
export type Palette = (typeof palette)['light'];

export const radii = { hero: 0, panel: 28, card: 20, chip: 999 } as const;

export const space = { gutter: 20, panel: 18, row: 14, grid: 4 } as const;

/** The stitch is the only border in the app. */
export const stitch = {
  inset: 9,
  width: 2,
  dash: [6, 5] as const,
  opacity: 0.9,
} as const;

/** Semantic status colour lookup, shared by DangerDot, chips and fault cards. */
export type DangerLevel = 'Normal' | 'Warning' | 'Critical';

export function dangerColor(p: Palette, level: DangerLevel): string {
  if (level === 'Critical') return p.critical;
  if (level === 'Warning') return p.warn;
  return p.good;
}
