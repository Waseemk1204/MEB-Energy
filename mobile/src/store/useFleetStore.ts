import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../api/session';
import { logWarn } from '../diagnostics/fieldLog';

/**
 * The company's batteries, as the server reports them.
 *
 * Two rules, and both are about not inventing packs:
 *
 * · **Nothing is shown that the server did not send.** There is no seeded or
 *   fallback fleet. A technician acting on a pack the app made up — trying to
 *   find it, or assuming a pack is missing from the depot — is a worse failure
 *   than an empty list.
 * · **A state of charge is never shown without its age.** `lastReading` carries
 *   `recordedAt`, and a reading with no age beside it reads as current. A pack
 *   last heard from three weeks ago showing "41%" is actively misleading.
 *
 * The last successful fetch is cached so the list still opens with no signal,
 * and `stale` says plainly that is what happened.
 */

const CACHE_KEY = 'knowyourev.fleet.v1';

export interface LastReading {
  soc: number;
  packVoltage: number;
  faultCount: number;
  recordedAt: number;
}

export interface FleetBattery {
  id: string;
  serial: string;
  chemistry: string;
  cellCount: number;
  bmsModel: string | null;
  lastReading: LastReading | null;
}

/** Wire shape: snake_case rows straight from the batteries table. */
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

export function fromRow(row: BatteryRow): FleetBattery {
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

/**
 * A reading is only worth showing next to how old it is. Beyond a day the
 * number stops being a state of charge and becomes a historical note — and one
 * shown bare would be read as current, which is the failure that gets someone
 * to act on a pack they have not actually heard from.
 */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type ReadingTone = 'good' | 'warn' | 'neutral';

export function describeReading(
  reading: LastReading | null,
  now = Date.now()
): { soc: number | null; age: string; tone: ReadingTone } {
  if (!reading) return { soc: null, age: 'Never reported', tone: 'neutral' };

  const elapsed = now - reading.recordedAt;
  if (elapsed < HOUR_MS) return { soc: reading.soc, age: 'Reported recently', tone: 'good' };
  if (elapsed < DAY_MS) {
    // Never round down to zero: "0h ago" would read as live.
    const hours = Math.max(1, Math.round(elapsed / HOUR_MS));
    return { soc: reading.soc, age: `${hours}h ago`, tone: 'warn' };
  }
  const days = Math.max(1, Math.round(elapsed / DAY_MS));
  return { soc: reading.soc, age: `${days}d ago`, tone: 'neutral' };
}

type FleetState = {
  batteries: FleetBattery[];
  loading: boolean;
  /** Set when the list on screen came from cache rather than the server. */
  stale: boolean;
  fetchedAt: number | null;
  error: string | null;
  /** False until the cache has been read; the list shows nothing before it. */
  hydrated: boolean;

  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  clear: () => Promise<void>;
};

export const useFleetStore = create<FleetState>((set, get) => ({
  batteries: [],
  loading: false,
  stale: false,
  fetchedAt: null,
  error: null,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(CACHE_KEY);
      const cached = raw ? (JSON.parse(raw) as { batteries: FleetBattery[]; fetchedAt: number }) : null;
      set(
        cached && Array.isArray(cached.batteries)
          ? { hydrated: true, batteries: cached.batteries, fetchedAt: cached.fetchedAt, stale: true }
          : { hydrated: true }
      );
    } catch {
      // A corrupt cache is not worth failing over; the refresh will replace it.
      set({ hydrated: true });
    }
  },

  refresh: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });

    try {
      const body = await api.get<{ batteries: BatteryRow[] }>('/batteries');
      const batteries = body.batteries.map(fromRow);
      const fetchedAt = Date.now();

      set({ batteries, fetchedAt, stale: false, loading: false, error: null });
      void AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ batteries, fetchedAt })).catch(
        () => undefined
      );
    } catch (error) {
      // The cached list stays on screen, marked stale. It is at least a list of
      // packs that genuinely exist, which is more than a fabricated one.
      const message = error instanceof Error ? error.message : 'Could not load batteries';
      logWarn('app', 'Fleet refresh failed', { reason: message });
      set({ loading: false, error: message, stale: get().batteries.length > 0 });
    }
  },

  clear: async () => {
    set({ batteries: [], fetchedAt: null, stale: false, error: null, hydrated: true });
    await AsyncStorage.removeItem(CACHE_KEY).catch(() => undefined);
  },
}));
