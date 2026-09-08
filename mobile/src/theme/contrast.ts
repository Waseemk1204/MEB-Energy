/**
 * WCAG 2.1 relative luminance and contrast ratio.
 *
 * PRD §8 and the UI plan require a minimum of 4.5:1 for text against its
 * background in both themes. These are the numbers behind that claim, so it can
 * be asserted rather than asserted-about.
 */

export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two colours, 1 (identical) to 21 (black on white). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA minimums. Large means >=18pt, or >=14pt bold. */
export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;
