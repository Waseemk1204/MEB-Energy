import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dark, light, type Palette } from './palette';

/**
 * The console's palette against the app's.
 *
 * These are the same colours, typed out twice, in two packages that do not
 * share a build. That is precisely the arrangement that produced twelve silent
 * divergences between the app's capability profile and the backend's seed —
 * so it gets the same treatment: a test that fails and names the token.
 *
 * The app's file is the source. If a colour changes there, it changes here.
 *
 * Skips when the app is not checked out beside the console, so the console
 * still tests standalone.
 */

// Resolved from the project root rather than `import.meta.url`: Vite rewrites
// module URLs during transform, and they are not file: URLs by the time this runs.
const APP_TOKENS = resolve(process.cwd(), '../mobile/src/theme/tokens.ts');

/**
 * Read the app's palette from source rather than importing it: `tokens.ts`
 * lives in a React Native package with its own toolchain, and pulling it
 * through this build to read six strings is not worth the coupling.
 */
function appPalette(theme: 'light' | 'dark'): Record<string, string> {
  const source = readFileSync(APP_TOKENS, 'utf8');
  const start = source.indexOf(`  ${theme}: {`);
  if (start === -1) throw new Error(`No ${theme} palette in ${APP_TOKENS}`);

  const end = source.indexOf('\n  },', start);
  const block = source.slice(start, end);

  const found: Record<string, string> = {};
  for (const [, key, value] of block.matchAll(/(\w+):\s*'(#[0-9a-fA-F]{6})'/g)) {
    found[key!] = value!.toUpperCase();
  }
  return found;
}

/**
 * Console token → app token. Named explicitly rather than matched by string,
 * because two of them differ on purpose and that has to be visible.
 */
const SHARED: Partial<Record<keyof Palette, string>> = {
  leatherStitch: 'leatherStitch',
  leatherInk: 'leatherInk',
  leatherInkSoft: 'leatherInkSoft',
  panelBase: 'panelBase',
  panelAlt: 'panelAlt',
  panelStitch: 'panelStitch',
  inkStrong: 'inkStrong',
  inkSoft: 'inkSoft',
  inkFaint: 'inkFaint',
  accent: 'accent',
  good: 'good',
  warn: 'warn',
  critical: 'critical',
  navPill: 'navPill',
  navPillInk: 'navPillInk',
  navInactive: 'navInactive',
};

describe.skipIf(!existsSync(APP_TOKENS))('the console palette matches the app’s', () => {
  for (const [name, theme] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it(`agrees on every shared ${name} token`, () => {
      const app = appPalette(name);
      const disagreements: string[] = [];

      for (const [consoleKey, appKey] of Object.entries(SHARED)) {
        const mine = (theme[consoleKey as keyof Palette] as string).toUpperCase();
        const theirs = app[appKey];

        if (theirs === undefined) {
          disagreements.push(`${appKey}: not defined by the app`);
        } else if (mine !== theirs) {
          disagreements.push(`${consoleKey}: console ${mine}, app ${theirs}`);
        }
      }

      expect(disagreements).toEqual([]);
    });
  }

  /**
   * The app's leather is a three-stop gradient; a console table needs one flat
   * colour to measure contrast against, so it takes the middle stop. This is a
   * deliberate difference, and it is asserted so it stays deliberate.
   */
  it('takes its flat leather from the middle of the app’s gradient', () => {
    const source = readFileSync(APP_TOKENS, 'utf8');
    const [, lightMid] = source.match(/leatherGradient: \['#\w{6}', '(#\w{6})'/) ?? [];
    expect(light.leather.toUpperCase()).toBe(lightMid?.toUpperCase());
  });

  it('reads the app’s file at all, so a rename cannot make this vacuous', () => {
    expect(Object.keys(appPalette('light')).length).toBeGreaterThan(10);
  });
});
