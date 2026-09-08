import type { ApiClient } from './client';

/**
 * Stored telemetry for one battery.
 *
 * The app thins 2 Hz down to roughly one sample per ten seconds before upload,
 * **keeping every frame where the fault count changed**. So a gap in this
 * series is a gap in reporting, not a period of calm — a chart drawn from it
 * must not join two points across hours of silence and imply a smooth line
 * between them.
 */

export interface Reading {
  recordedAt: number;
  soc: number;
  packVoltage: number;
  packCurrent: number;
  temperatureC: number;
  deltaMv: number;
  faultCount: number;
}

interface ReadingRow {
  recorded_at: number;
  soc: number;
  pack_voltage: number;
  pack_current: number;
  temperature_c: number;
  delta_mv: number;
  fault_count: number;
}

export function fromRow(row: ReadingRow): Reading {
  return {
    recordedAt: row.recorded_at,
    soc: row.soc,
    packVoltage: row.pack_voltage,
    packCurrent: row.pack_current,
    temperatureC: row.temperature_c,
    deltaMv: row.delta_mv,
    faultCount: row.fault_count,
  };
}

/** Oldest first, which is the order a chart reads in. */
export async function listHistory(
  api: ApiClient,
  batteryId: string,
  limit = 500
): Promise<Reading[]> {
  const body = await api.get<{ readings: ReadingRow[] }>(
    `/batteries/${encodeURIComponent(batteryId)}/telemetry?limit=${limit}`
  );
  return body.readings.map(fromRow).sort((a, b) => a.recordedAt - b.recordedAt);
}

/**
 * A gap longer than this is a reporting gap, not a reading.
 *
 * The app uploads roughly every ten seconds while linked, so anything past a
 * few minutes means nobody was connected. Six times the sample interval,
 * matching the staleness rule the app already uses for its own gauges.
 */
export const GAP_MS = 60_000;

export interface Series {
  points: { at: number; value: number }[];
  /** Index after which the series is discontinuous; a chart breaks the line here. */
  breaks: number[];
}

/**
 * Turn readings into a series that knows where it is discontinuous.
 *
 * Drawing straight through a gap would assert a state of charge for a period
 * nobody measured — the same failure the fleet list avoids by showing an age
 * beside every number.
 */
export function toSeries(readings: Reading[], pick: (r: Reading) => number): Series {
  const points = readings.map((r) => ({ at: r.recordedAt, value: pick(r) }));
  const breaks: number[] = [];

  for (let i = 1; i < readings.length; i += 1) {
    if (readings[i]!.recordedAt - readings[i - 1]!.recordedAt > GAP_MS) breaks.push(i - 1);
  }

  return { points, breaks };
}

export interface Extent {
  min: number;
  max: number;
}

/** The range a chart should draw, padded so a flat line is not on the axis. */
export function extentOf(points: { value: number }[], floor?: number, ceiling?: number): Extent {
  if (points.length === 0) return { min: floor ?? 0, max: ceiling ?? 1 };

  const values = points.map((p) => p.value);
  let min = Math.min(...values);
  let max = Math.max(...values);

  if (min === max) {
    // A perfectly flat series would otherwise have zero height and vanish.
    min -= 1;
    max += 1;
  }

  const pad = (max - min) * 0.08;
  return {
    min: floor !== undefined ? Math.min(floor, min) : min - pad,
    max: ceiling !== undefined ? Math.max(ceiling, max) : max + pad,
  };
}

/** Points laid out in a 0..1 box, so the caller owns the pixel dimensions. */
export function normalise(series: Series, extent: Extent): { x: number; y: number }[] {
  const { points } = series;
  if (points.length === 0) return [];

  const first = points[0]!.at;
  const last = points[points.length - 1]!.at;
  const span = last - first || 1;
  const height = extent.max - extent.min || 1;

  return points.map((p) => ({
    x: (p.at - first) / span,
    // SVG y grows downward; a higher value should sit higher on screen.
    y: 1 - (p.value - extent.min) / height,
  }));
}

/**
 * An SVG path that lifts the pen across every gap, rather than drawing a line
 * through a period nobody measured.
 */
export function pathFor(series: Series, extent: Extent, width: number, height: number): string {
  const points = normalise(series, extent);
  if (points.length === 0) return '';

  const breaks = new Set(series.breaks);
  return points
    .map((p, i) => {
      const x = (p.x * width).toFixed(2);
      const y = (p.y * height).toFixed(2);
      const command = i === 0 || breaks.has(i - 1) ? 'M' : 'L';
      return `${command}${x},${y}`;
    })
    .join(' ');
}
