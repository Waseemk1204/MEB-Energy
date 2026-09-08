/**
 * WCAG 2.1 relative luminance and contrast ratio.
 *
 * This exists for one reason: the app's design plan claimed AA compliance, and
 * when the ratios were finally measured, five pairings failed. The palette was
 * corrected and a test was added so the claim could never drift back into
 * being aspirational. The console inherits that palette, and inherits the
 * obligation to prove it rather than assert it.
 */

export function parseHex(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;

  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Not a colour: ${hex}`);
  }

  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** Per WCAG: linearise each channel, then weight for perceived brightness. */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/** AA: 4.5:1 for body text, 3:1 for large text (≥18.66px bold or ≥24px). */
export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;
