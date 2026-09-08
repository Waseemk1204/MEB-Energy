import { describe, expect, it } from 'vitest';
import { AA_LARGE, AA_NORMAL, contrastRatio, luminance, parseHex } from './contrast';
import { dark, light, type Palette } from './palette';

/**
 * Every text pairing the console actually renders, measured.
 *
 * The list below is not "some colours we thought about" — each entry names a
 * place in the stylesheet where that foreground sits on that background. If a
 * pairing is added to `chrome.css` and not here, it is untested; if one is
 * here and no longer rendered, it should be removed rather than left passing.
 */

interface Pairing {
  where: string;
  fg: keyof Palette;
  bg: keyof Palette;
  /** Large text only: the wordmark and page titles. */
  large?: boolean;
}

const PAIRINGS: Pairing[] = [
  // Masthead and rail — leather.
  { where: 'wordmark on leather', fg: 'leatherInk', bg: 'leather', large: true },
  { where: 'masthead subtitle on leather', fg: 'leatherInkSoft', bg: 'leather' },
  { where: 'rail section label on leather', fg: 'leatherInkSoft', bg: 'leather' },
  { where: 'rail link on leather', fg: 'leatherInkSoft', bg: 'leather' },
  { where: 'rail link hovered on leather', fg: 'leatherInk', bg: 'leather' },
  { where: 'current rail link on its pill', fg: 'navPillInk', bg: 'navPill' },

  // Content — cream panel.
  { where: 'page title on panel', fg: 'inkStrong', bg: 'panelBase', large: true },
  { where: 'page subtitle on panel', fg: 'inkSoft', bg: 'panelBase' },
  { where: 'table cell on panel', fg: 'inkStrong', bg: 'panelBase' },
  { where: 'table header on panel', fg: 'inkFaint', bg: 'panelBase' },
  { where: 'panel note on panel', fg: 'inkFaint', bg: 'panelBase' },
  { where: 'empty-state text on panel', fg: 'inkFaint', bg: 'panelBase' },
  { where: 'form label on panel', fg: 'inkSoft', bg: 'panelBase' },
  { where: 'input text on panel', fg: 'inkStrong', bg: 'panelBase' },

  // Hovered rows sit on the alternate panel tone.
  { where: 'table cell on hovered row', fg: 'inkStrong', bg: 'panelAlt' },
  { where: 'muted cell on hovered row', fg: 'inkFaint', bg: 'panelAlt' },

  // Status chips carry meaning by colour, so they must be legible.
  { where: 'good chip on panel', fg: 'good', bg: 'panelBase' },
  { where: 'warning chip on panel', fg: 'warn', bg: 'panelBase' },
  { where: 'critical chip on panel', fg: 'critical', bg: 'panelBase' },
  { where: 'neutral chip on panel', fg: 'inkFaint', bg: 'panelBase' },
  { where: 'good chip on hovered row', fg: 'good', bg: 'panelAlt' },
  { where: 'warning chip on hovered row', fg: 'warn', bg: 'panelAlt' },
  { where: 'critical chip on hovered row', fg: 'critical', bg: 'panelAlt' },

  // Notices.
  { where: 'error notice on panel', fg: 'critical', bg: 'panelBase' },
  { where: 'warning notice on panel', fg: 'warn', bg: 'panelBase' },

  // Buttons.
  { where: 'primary button label', fg: 'navPillInk', bg: 'navPill' },
  { where: 'secondary button label on panel', fg: 'inkStrong', bg: 'panelBase' },

  // Sign-in screen — full-bleed leather.
  { where: 'sign-in wordmark on leather', fg: 'leatherInk', bg: 'leather', large: true },
  { where: 'sign-in subtitle on leather', fg: 'leatherInkSoft', bg: 'leather' },
  { where: 'sign-in field label on leather', fg: 'leatherInkSoft', bg: 'leather' },
  { where: 'sign-in input text on leather', fg: 'leatherInk', bg: 'leather' },
  { where: 'sign-in error on leather', fg: 'leatherInk', bg: 'leather' },
  { where: 'sign-in footnote on leather', fg: 'leatherInkSoft', bg: 'leather' },
  { where: 'sign-in button label', fg: 'leatherStitch', bg: 'leatherInk' },

  // The focus ring has to be visible against everything it can land on.
  // A focus indicator needs 3:1 against what it sits on, and the two surfaces
  // need different rings to get there.
  { where: 'focus ring on panel', fg: 'focusOnPanel', bg: 'panelBase', large: true },
  { where: 'focus ring on hovered row', fg: 'focusOnPanel', bg: 'panelAlt', large: true },
  { where: 'focus ring on leather', fg: 'focusOnLeather', bg: 'leather', large: true },
];

describe('the ratio calculation itself', () => {
  it('gives 21:1 for black on white', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
  });

  it('gives 1:1 for a colour against itself', () => {
    expect(contrastRatio('#8B6238', '#8B6238')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#241809', '#FCFAF5')).toBeCloseTo(
      contrastRatio('#FCFAF5', '#241809'),
      10
    );
  });

  it('reads shorthand hex', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
  });

  it('refuses something that is not a colour', () => {
    expect(() => parseHex('var(--accent)')).toThrow();
  });

  it('puts white at full luminance and black at none', () => {
    expect(luminance('#FFFFFF')).toBeCloseTo(1, 5);
    expect(luminance('#000000')).toBeCloseTo(0, 5);
  });
});

for (const [name, theme] of [
  ['light', light],
  ['dark', dark],
] as const) {
  describe(`${name} theme meets WCAG AA`, () => {
    for (const pairing of PAIRINGS) {
      const threshold = pairing.large ? AA_LARGE : AA_NORMAL;

      it(`${pairing.where} (needs ${threshold}:1)`, () => {
        const ratio = contrastRatio(theme[pairing.fg], theme[pairing.bg]);
        expect(
          ratio,
          `${pairing.where}: ${theme[pairing.fg]} on ${theme[pairing.bg]} is ${ratio.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(threshold);
      });
    }
  });
}

describe('both themes are complete', () => {
  it('define exactly the same tokens', () => {
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });

  it('are genuinely different palettes, not one inverted', () => {
    const shared = Object.keys(light).filter(
      (k) => (light[k as keyof Palette] as string) === (dark[k as keyof Palette] as string)
    );
    expect(shared).toEqual([]);
  });

  it('put the panel on opposite sides of mid-grey, as a light and dark theme must', () => {
    expect(luminance(light.panelBase)).toBeGreaterThan(0.5);
    expect(luminance(dark.panelBase)).toBeLessThan(0.1);
  });
});
