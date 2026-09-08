import { angleFor, arcPath, clamp, needlePoints, polar, ticks } from './polar';

const HERO = { a0: -135, a1: 135 };
const METRIC = { a0: -115, a1: 115 };

describe('polar', () => {
  it('puts 0° at 12 o\'clock', () => {
    const pt = polar(100, 100, 50, 0);
    expect(pt.x).toBeCloseTo(100, 6);
    expect(pt.y).toBeCloseTo(50, 6);
  });

  it('rotates clockwise for positive angles', () => {
    const pt = polar(100, 100, 50, 90);
    expect(pt.x).toBeCloseTo(150, 6);
    expect(pt.y).toBeCloseTo(100, 6);
  });
});

describe('angleFor', () => {
  it('places the hero midpoint at 12 o\'clock', () => {
    expect(angleFor(50, 0, 100, HERO.a0, HERO.a1)).toBe(0);
  });

  it('places the hero minimum at the sweep start', () => {
    expect(angleFor(0, 0, 100, HERO.a0, HERO.a1)).toBe(-135);
  });

  it('places the hero maximum at the sweep end', () => {
    expect(angleFor(100, 0, 100, HERO.a0, HERO.a1)).toBe(135);
  });

  it('places bipolar zero at 12 o\'clock', () => {
    expect(angleFor(0, -400, 400, METRIC.a0, METRIC.a1)).toBe(0);
  });

  it('clamps out-of-range values to the arc ends rather than overshooting', () => {
    expect(angleFor(140, 0, 100, HERO.a0, HERO.a1)).toBe(135);
    expect(angleFor(-40, 0, 100, HERO.a0, HERO.a1)).toBe(-135);
    expect(angleFor(-999, -400, 400, METRIC.a0, METRIC.a1)).toBe(-115);
  });

  it('derives the 24S pack-voltage axis without drifting off the arc', () => {
    // 24 cells × 2.6 V release → 62 V floor; × 3.75 V OVP → 90 V ceiling.
    expect(angleFor(62, 62, 90, METRIC.a0, METRIC.a1)).toBe(-115);
    expect(angleFor(90, 62, 90, METRIC.a0, METRIC.a1)).toBe(115);
    expect(angleFor(76, 62, 90, METRIC.a0, METRIC.a1)).toBe(0);
  });
});

describe('clamp', () => {
  it('bounds on both sides', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe('arcPath', () => {
  it('emits a single move-and-arc command', () => {
    const d = arcPath(100, 100, 50, -135, 135);
    expect(d.startsWith('M ')).toBe(true);
    expect(d).toContain(' A 50 50 0 ');
  });

  it('sets the large-arc flag only past 180°', () => {
    expect(arcPath(100, 100, 50, -135, 135)).toContain(' A 50 50 0 1 1 ');
    expect(arcPath(100, 100, 50, -45, 45)).toContain(' A 50 50 0 0 1 ');
  });
});

describe('needlePoints', () => {
  it('returns four vertices', () => {
    const pts = needlePoints(100, 100, 0, 45, 8, 2).split(' ');
    expect(pts).toHaveLength(4);
  });

  it('points the tip along the given angle', () => {
    const pts = needlePoints(100, 100, 0, 45, 8, 2).split(' ');
    // At 0° the two tip vertices sit above the hub.
    const tipY = Number(pts[1].split(',')[1]);
    expect(tipY).toBeCloseTo(55, 0);
  });
});

describe('ticks', () => {
  it('includes both ends', () => {
    expect(ticks(0, 100, 10)).toHaveLength(11);
    expect(ticks(0, 100, 10)[10]).toBe(100);
  });

  it('divides the 24S voltage axis evenly', () => {
    const t = ticks(62, 90, 4);
    expect(t).toHaveLength(8);
    expect(t[t.length - 1]).toBe(90);
  });

  it('spans the bipolar current axis symmetrically', () => {
    const t = ticks(-400, 400, 100);
    expect(t).toHaveLength(9);
    expect(t).toContain(0);
  });
});
