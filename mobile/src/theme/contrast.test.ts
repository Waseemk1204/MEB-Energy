import { AA_LARGE, AA_NORMAL, contrast, luminance } from './contrast';
import { palette, type Palette, type ThemeMode } from './tokens';

/**
 * PRD §8: minimum 4.5:1 for text against its background.
 *
 * These pairings are the ones the app actually renders. When a token's colour
 * changes, this is what says whether the change is shippable — the numbers were
 * previously asserted in the design doc without ever being computed, and five
 * pairings turned out to fail.
 *
 * There is one theme now. The olive palette was chosen against these numbers
 * rather than checked afterwards: the gradient's lightest stop is as light as
 * it can be while `leatherInkSoft` still clears 4.5:1 on it, which is the
 * constraint that sets the whole hero's darkness.
 */

type Pair = { name: string; fg: keyof Palette; on: keyof Palette | string };

/** Text on the cream panels. */
const panelText: Pair[] = [
  { name: 'inkStrong on panel', fg: 'inkStrong', on: 'panelBase' },
  { name: 'inkStrong on panelAlt', fg: 'inkStrong', on: 'panelAlt' },
  { name: 'inkSoft on panel', fg: 'inkSoft', on: 'panelBase' },
  { name: 'inkSoft on panelAlt', fg: 'inkSoft', on: 'panelAlt' },
  { name: 'inkFaint on panel', fg: 'inkFaint', on: 'panelBase' },
  { name: 'inkFaint on panelAlt', fg: 'inkFaint', on: 'panelAlt' },
  { name: 'accent on panel', fg: 'accent', on: 'panelBase' },
  { name: 'accent on panelAlt', fg: 'accent', on: 'panelAlt' },
  { name: 'good on panel', fg: 'good', on: 'panelBase' },
  { name: 'good on panelAlt', fg: 'good', on: 'panelAlt' },
  { name: 'warn on panel', fg: 'warn', on: 'panelBase' },
  { name: 'warn on panelAlt', fg: 'warn', on: 'panelAlt' },
  { name: 'critical on panel', fg: 'critical', on: 'panelBase' },
  { name: 'critical on panelAlt', fg: 'critical', on: 'panelAlt' },
  { name: 'navInactive on panel', fg: 'navInactive', on: 'panelBase' },
  { name: 'navPillInk on navPill', fg: 'navPillInk', on: 'navPill' },
];

const leatherInk: Pair[] = [
  { name: 'leatherInk on leather', fg: 'leatherInk', on: 'leather' },
  { name: 'leatherInkSoft on leather', fg: 'leatherInkSoft', on: 'leather' },
];

const modes: ThemeMode[] = ['light'];

describe.each(modes)('%s theme', (mode) => {
  const p = palette[mode] as Palette;
  const stops = p.leatherGradient as unknown as string[];

  describe('text on panels', () => {
    it.each(panelText)('$name meets AA', ({ fg, on }) => {
      expect(contrast(p[fg] as string, p[on as keyof Palette] as string)).toBeGreaterThanOrEqual(
        AA_NORMAL
      );
    });
  });

  /**
   * Leather is a gradient, and text sits over all of it. The worst case for
   * dark ink is the darkest stop, so every stop must clear the bar.
   */
  describe('text on the leather gradient', () => {
    it.each(leatherInk)('$name meets AA at every gradient stop', ({ fg }) => {
      for (const stop of stops) {
        expect(contrast(p[fg] as string, stop)).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    });
  });

  it('keeps a visible hierarchy between strong and soft ink', () => {
    expect(contrast(p.inkStrong, p.inkSoft)).toBeGreaterThan(1.5);
    expect(contrast(p.inkSoft, p.inkFaint)).toBeGreaterThan(1.15);
  });

  /**
   * The gradient has to read as a material, not a flat fill. Black leather is
   * inherently lower-contrast than tan, so the floor is set below what the tan
   * theme achieves (1.47) but high enough to catch an accidentally flat fill.
   */
  it('keeps the leather gradient visibly graded', () => {
    expect(contrast(stops[0], stops[stops.length - 1])).toBeGreaterThan(1.15);
  });

  it('separates the two panel surfaces without them reading as different colours', () => {
    const r = contrast(p.panelBase, p.panelAlt);
    expect(r).toBeGreaterThan(1.02);
    expect(r).toBeLessThan(1.5);
  });

  /**
   * `good` and `warn` sit at nearly identical luminance in the light theme
   * (1.00), so severity is NOT distinguishable by colour alone for a colour-blind
   * or monochrome viewer. That is why DangerDot carries an accessibility label
   * and StatusChip always renders text — see primitives.test.tsx. This asserts
   * only that each status colour is itself legible, which is covered above; the
   * meaning-bearing channel is the label, not the hue.
   */
  it('does not rely on luminance to separate status colours', () => {
    // Documented reality rather than an aspiration: this is why labels exist.
    expect(contrast(p.good, p.warn)).toBeGreaterThan(1);
  });
});

/**
 * There is no second theme to compare against any more. What used to be
 * asserted here — that the palettes were not a naive inversion of each other —
 * is now a property of a single palette: the panel is light and the leather is
 * dark, and text on each is checked above.
 */
describe('the single theme', () => {
  it('keeps panels light and leather dark, so the two materials read apart', () => {
    expect(luminance(palette.light.panelBase)).toBeGreaterThan(0.5);
    const stops = palette.light.leatherGradient as unknown as string[];
    for (const stop of stops) expect(luminance(stop)).toBeLessThan(0.25);
  });
});

describe('non-text graphics', () => {
  /** Needles and tracks are graphics, held to the 3:1 non-text bar. */
  it.each(modes)('%s needle stands off its track', (mode) => {
    const p = palette[mode] as Palette;
    expect(contrast(p.panelNeedle, p.panelTrack)).toBeGreaterThanOrEqual(AA_LARGE);
  });
});
