import { useEffect, useState } from 'react';
import { TELEMETRY_INTERVAL_MS } from './types';

/**
 * Is what the gauges are showing still live?
 *
 * The store keeps the last snapshot indefinitely, which is correct — losing the
 * reading on a dropped link would be worse. What is not correct is presenting a
 * frozen reading as a current one. A technician standing at a pack, deciding
 * whether it is safe to work on, must be able to tell the difference between
 * "72% right now" and "72% before the link died four minutes ago".
 *
 * The mock emits every 500 ms and so is never stale, which is exactly why this
 * could not be caught on the web target.
 */

/** Six missed frames at 2 Hz. Long enough not to flicker, short enough to trust. */
export const STALE_AFTER_MS = TELEMETRY_INTERVAL_MS * 6;

/** How often staleness is re-evaluated. Independent of the telemetry cadence. */
const TICK_MS = 500;

export interface Freshness {
  /** Age of the newest snapshot, in ms. Infinite when there has never been one. */
  ageMs: number;
  stale: boolean;
  /** "4 s" / "2 min" — for telling the user how old the reading is. */
  ageLabel: string;
}

export function describeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return 'never';
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h`;
}

export function freshnessOf(timestamp: number | undefined, now: number): Freshness {
  const ageMs = timestamp === undefined ? Number.POSITIVE_INFINITY : Math.max(0, now - timestamp);
  return { ageMs, stale: ageMs >= STALE_AFTER_MS, ageLabel: describeAge(ageMs) };
}

/**
 * Ticks on its own rather than off the telemetry stream — a stream that has
 * stopped cannot be what tells you it has stopped.
 */
export function useFreshness(timestamp: number | undefined): Freshness {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  return freshnessOf(timestamp, now);
}
