import type { ApiClient } from './client';

/**
 * The fleet, as the console reads it.
 *
 * The same rule the app enforces holds here: **a state of charge is never
 * shown without its age.** On a console it matters more, not less — an
 * administrator looking at fifty rows is further from the hardware than a
 * technician standing in front of one pack, and has no other way to tell a
 * live number from a three-week-old one.
 */

export interface LastReading {
  soc: number;
  packVoltage: number;
  faultCount: number;
  recordedAt: number;
}

export interface Battery {
  id: string;
  serial: string;
  chemistry: string;
  cellCount: number;
  bmsModel: string | null;
  lastReading: LastReading | null;
}

interface BatteryRow {
  id: string;
  serial: string;
  chemistry: string;
  cell_count: number;
  bms_model: string | null;
  lastReading: {
    soc: number;
    pack_voltage: number;
    fault_count: number;
    recorded_at: number;
  } | null;
}

export function fromRow(row: BatteryRow): Battery {
  return {
    id: row.id,
    serial: row.serial,
    chemistry: row.chemistry,
    cellCount: row.cell_count,
    bmsModel: row.bms_model,
    lastReading: row.lastReading
      ? {
          soc: row.lastReading.soc,
          packVoltage: row.lastReading.pack_voltage,
          faultCount: row.lastReading.fault_count,
          recordedAt: row.lastReading.recorded_at,
        }
      : null,
  };
}

export interface Fleet {
  batteries: Battery[];
  /** True when the server returned only part of the fleet. */
  truncated: boolean;
}

export async function listBatteries(api: ApiClient): Promise<Fleet> {
  const body = await api.get<{ batteries: BatteryRow[]; truncated?: boolean }>('/batteries');
  return { batteries: body.batteries.map(fromRow), truncated: body.truncated === true };
}

/**
 * One battery, fetched directly.
 *
 * Not picked out of the fleet listing: that listing is bounded, so scanning it
 * for one pack works until a fleet grows past the page and then silently stops
 * finding batteries that plainly exist.
 */
export async function getBattery(api: ApiClient, id: string): Promise<Battery> {
  return fromRow(await api.get<BatteryRow>(`/batteries/${encodeURIComponent(id)}`));
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type Freshness = 'good' | 'warn' | 'neutral';

export interface ReadingSummary {
  soc: string;
  age: string;
  tone: Freshness;
  /** True when the pack has reported at all. */
  known: boolean;
}

export function describeReading(reading: LastReading | null, now = Date.now()): ReadingSummary {
  if (!reading) return { soc: '—', age: 'Never reported', tone: 'neutral', known: false };

  const elapsed = now - reading.recordedAt;
  const soc = `${Math.round(reading.soc)}%`;

  if (elapsed < HOUR_MS) return { soc, age: 'Reported recently', tone: 'good', known: true };
  if (elapsed < DAY_MS) {
    // Never round down to zero: "0h ago" would read as live.
    return { soc, age: `${Math.max(1, Math.round(elapsed / HOUR_MS))}h ago`, tone: 'warn', known: true };
  }
  return { soc, age: `${Math.max(1, Math.round(elapsed / DAY_MS))}d ago`, tone: 'neutral', known: true };
}

/** Faults on a pack are the reason to open this page at all, so they sort first. */
export function byAttention(a: Battery, b: Battery): number {
  const faults = (x: Battery) => x.lastReading?.faultCount ?? 0;
  if (faults(a) !== faults(b)) return faults(b) - faults(a);
  return a.serial.localeCompare(b.serial);
}
