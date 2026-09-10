/**
 * KnowyourEV design tokens — "Bentley cluster".
 *
 * Two materials, two meanings:
 *   leather = live primary instrumentation, always pinned
 *   panel   = data, lists and controls, always scrolls
 *
 * Both themes are complete token sets. Never derive one by inverting the other.
 */

export const palette = {
  light: {
    leatherGradient: ['#D2B189', '#C39D71', '#B58F62'] as const,
    leatherStitch: '#EFE0C4',
    leatherInk: '#24180A',
    leatherInkSoft: '#3A2B19',
    leatherTrack: '#E6D6BA',
    leatherNeedle: '#F6EDDB',
    leatherHub: '#3A2A17',

    panelBase: '#FCFAF5',
    panelAlt: '#F4EEE2',
    panelStitch: '#E4D8C2',
    panelTrack: '#E9DFCC',
    panelNeedle: '#3A2A17',

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
    backdrop: '#EDE4D3',

    needleEdge: 'rgba(0,0,0,0.28)',
    panelShadow: 'rgba(60,40,15,0.10)',
  },
  dark: {
    leatherGradient: ['#262019', '#1A1611', '#100D09'] as const,
    leatherStitch: '#4B3E2C',
    leatherInk: '#F3E9D9',
    leatherInkSoft: '#B39A72',
    leatherTrack: '#33291D',
    leatherNeedle: '#E8C088',
    leatherHub: '#0E0B08',

    panelBase: '#191510',
    panelAlt: '#211C15',
    panelStitch: '#362E22',
    panelTrack: '#2E271D',
    panelNeedle: '#E8C088',

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
    backdrop: '#0A0908',

    needleEdge: 'rgba(0,0,0,0.45)',
    panelShadow: 'rgba(0,0,0,0.45)',
  },
} as const;

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
