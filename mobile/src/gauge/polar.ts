/**
 * Gauge geometry. 0° is 12 o'clock, clockwise positive.
 *
 * Every function here is a worklet: the needle and value arc are recomputed on
 * the UI thread each frame by Reanimated, so this module must be callable from
 * both threads.
 */

export type Point = { x: number; y: number };

export function polar(cx: number, cy: number, r: number, deg: number): Point {
  'worklet';
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

export function arcPath(
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number
): string {
  'worklet';
  const s = polar(cx, cy, r, a0);
  const e = polar(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 >= a0 ? 1 : 0;
  return `M ${s.x.toFixed(3)} ${s.y.toFixed(3)} A ${r} ${r} 0 ${large} ${sweep} ${e.x.toFixed(3)} ${e.y.toFixed(3)}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  'worklet';
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Map a value onto the sweep. Out-of-range values clamp to the arc ends rather
 * than overshooting — a needle that leaves the dial reads as a broken instrument,
 * not as an extreme reading.
 */
export function angleFor(
  v: number,
  min: number,
  max: number,
  a0: number,
  a1: number
): number {
  'worklet';
  const t = clamp((v - min) / (max - min), 0, 1);
  return a0 + t * (a1 - a0);
}

/**
 * Tapered needle as an SVG polygon: wide at the hub, near-pointed at the tip.
 * Returned as a `points` string so it can be driven straight into AnimatedPolygon.
 */
export function needlePoints(
  cx: number,
  cy: number,
  angle: number,
  tipRadius: number,
  hubWidth: number,
  tipWidth: number
): string {
  'worklet';
  const hw = hubWidth / 2;
  const tw = tipWidth / 2;
  const tip = polar(cx, cy, tipRadius, angle);
  const b1 = polar(cx, cy, hw, angle + 90);
  const b2 = polar(cx, cy, hw, angle - 90);
  // Offset the tip corners perpendicular to the needle axis.
  const rad = (angle * Math.PI) / 180;
  const px = Math.cos(rad) * tw;
  const py = Math.sin(rad) * tw;
  return (
    `${b1.x.toFixed(2)},${b1.y.toFixed(2)} ` +
    `${(tip.x + px).toFixed(2)},${(tip.y + py).toFixed(2)} ` +
    `${(tip.x - px).toFixed(2)},${(tip.y - py).toFixed(2)} ` +
    `${b2.x.toFixed(2)},${b2.y.toFixed(2)}`
  );
}

/** Evenly spaced tick values from min to max inclusive, tolerant of float drift. */
export function ticks(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  const n = Math.round((max - min) / step);
  for (let i = 0; i <= n; i++) out.push(min + i * step);
  return out;
}
