import { describe, expect, it } from 'vitest';
import {
  GAP_MS,
  extentOf,
  fromRow,
  normalise,
  pathFor,
  toSeries,
  type Reading,
} from './history';

const reading = (at: number, soc = 50, faults = 0): Reading => ({
  recordedAt: at,
  soc,
  packVoltage: 79.2,
  packCurrent: -12,
  temperatureC: 24,
  deltaMv: 30,
  faultCount: faults,
});

/** Readings ten seconds apart, the interval the app uploads at. */
const contiguous = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => reading(from + i * 10_000, 50 + i));

describe('reading the wire shape', () => {
  it('maps a row', () => {
    expect(
      fromRow({
        recorded_at: 1000,
        soc: 72,
        pack_voltage: 79.2,
        pack_current: -12.4,
        temperature_c: 24,
        delta_mv: 30,
        fault_count: 1,
      })
    ).toEqual({
      recordedAt: 1000,
      soc: 72,
      packVoltage: 79.2,
      packCurrent: -12.4,
      temperatureC: 24,
      deltaMv: 30,
      faultCount: 1,
    });
  });
});

/**
 * The property this module exists for. The app uploads only while a technician
 * is linked, so a series can jump hours between points. Drawing through that
 * asserts a state of charge for a period nobody measured.
 */
describe('finding the gaps', () => {
  it('reports none in a contiguous series', () => {
    expect(toSeries(contiguous(10), (r) => r.soc).breaks).toEqual([]);
  });

  it('finds one where reporting stopped', () => {
    const readings = [
      reading(0),
      reading(10_000),
      // Two hours of nothing.
      reading(10_000 + 2 * 60 * 60 * 1000),
      reading(10_000 + 2 * 60 * 60 * 1000 + 10_000),
    ];
    expect(toSeries(readings, (r) => r.soc).breaks).toEqual([1]);
  });

  it('finds several', () => {
    const readings = [reading(0), reading(GAP_MS * 3), reading(GAP_MS * 6), reading(GAP_MS * 6 + 1000)];
    expect(toSeries(readings, (r) => r.soc).breaks).toEqual([0, 1]);
  });

  it('does not call a normal interval a gap', () => {
    expect(toSeries([reading(0), reading(GAP_MS - 1)], (r) => r.soc).breaks).toEqual([]);
  });

  it('treats exactly the threshold as contiguous, and one past it as a gap', () => {
    expect(toSeries([reading(0), reading(GAP_MS)], (r) => r.soc).breaks).toEqual([]);
    expect(toSeries([reading(0), reading(GAP_MS + 1)], (r) => r.soc).breaks).toEqual([0]);
  });

  it('handles a single reading', () => {
    expect(toSeries([reading(0)], (r) => r.soc).breaks).toEqual([]);
  });

  it('handles no readings at all', () => {
    expect(toSeries([], (r) => r.soc)).toEqual({ points: [], breaks: [] });
  });
});

describe('the range a chart draws', () => {
  it('covers the data', () => {
    const { min, max } = extentOf([{ value: 10 }, { value: 90 }]);
    expect(min).toBeLessThanOrEqual(10);
    expect(max).toBeGreaterThanOrEqual(90);
  });

  /** A percentage chart that starts at 41% exaggerates every wiggle. */
  it('honours a floor and ceiling, so a percentage reads as a percentage', () => {
    expect(extentOf([{ value: 41 }, { value: 44 }], 0, 100)).toEqual({ min: 0, max: 100 });
  });

  it('still covers data outside the given floor or ceiling', () => {
    const { min, max } = extentOf([{ value: -5 }, { value: 120 }], 0, 100);
    expect(min).toBeLessThanOrEqual(-5);
    expect(max).toBeGreaterThanOrEqual(120);
  });

  /** A flat series with zero height would vanish entirely. */
  it('gives a perfectly flat series some height', () => {
    const { min, max } = extentOf([{ value: 50 }, { value: 50 }]);
    expect(max).toBeGreaterThan(min);
  });

  it('has a sensible range for no data', () => {
    const { min, max } = extentOf([]);
    expect(max).toBeGreaterThan(min);
  });
});

describe('laying points out', () => {
  const extent = { min: 0, max: 100 };

  it('puts the first point at the left and the last at the right', () => {
    const points = normalise(toSeries(contiguous(5), (r) => r.soc), extent);
    expect(points[0]!.x).toBe(0);
    expect(points[points.length - 1]!.x).toBe(1);
  });

  /** SVG y grows downward, so a higher value must produce a smaller y. */
  it('puts a higher value higher on screen', () => {
    const points = normalise(toSeries([reading(0, 10), reading(10_000, 90)], (r) => r.soc), extent);
    expect(points[1]!.y).toBeLessThan(points[0]!.y);
  });

  it('puts the maximum at the top and the minimum at the bottom', () => {
    const points = normalise(toSeries([reading(0, 0), reading(10_000, 100)], (r) => r.soc), extent);
    expect(points[0]!.y).toBeCloseTo(1, 5);
    expect(points[1]!.y).toBeCloseTo(0, 5);
  });

  it('handles a single point without dividing by zero', () => {
    const points = normalise(toSeries([reading(0, 50)], (r) => r.soc), extent);
    expect(points).toHaveLength(1);
    expect(Number.isFinite(points[0]!.x)).toBe(true);
    expect(Number.isFinite(points[0]!.y)).toBe(true);
  });
});

describe('the drawn path', () => {
  const extent = { min: 0, max: 100 };

  it('is one continuous stroke when nothing was missed', () => {
    const path = pathFor(toSeries(contiguous(5), (r) => r.soc), extent, 100, 50);
    expect(path.match(/M/g)).toHaveLength(1);
  });

  /**
   * The whole point: a second `M` is the pen lifting. Without it the chart
   * draws a straight line through hours nobody measured.
   */
  it('lifts the pen across a gap', () => {
    const readings = [reading(0), reading(10_000), reading(10_000 + GAP_MS * 5), reading(10_000 + GAP_MS * 5 + 10_000)];
    const path = pathFor(toSeries(readings, (r) => r.soc), extent, 100, 50);
    expect(path.match(/M/g)).toHaveLength(2);
  });

  it('lifts it once per gap', () => {
    const readings = [reading(0), reading(GAP_MS * 3), reading(GAP_MS * 6), reading(GAP_MS * 9)];
    const path = pathFor(toSeries(readings, (r) => r.soc), extent, 100, 50);
    expect(path.match(/M/g)).toHaveLength(4);
  });

  it('scales to the box it is given', () => {
    const path = pathFor(toSeries(contiguous(2), (r) => r.soc), extent, 200, 80);
    const xs = [...path.matchAll(/[ML](-?[\d.]+),/g)].map((m) => Number(m[1]));
    expect(Math.max(...xs)).toBeCloseTo(200, 1);
  });

  it('draws nothing for no readings', () => {
    expect(pathFor(toSeries([], (r) => r.soc), extent, 100, 50)).toBe('');
  });

  it('produces only finite coordinates', () => {
    const path = pathFor(toSeries(contiguous(20), (r) => r.soc), extentOf([{ value: 50 }]), 620, 120);
    const numbers = [...path.matchAll(/(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(numbers.every((n) => Number.isFinite(n))).toBe(true);
  });
});
