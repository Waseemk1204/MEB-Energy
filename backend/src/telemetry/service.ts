import { randomUUID } from 'node:crypto';
import type { Param, Store } from '../db/client.js';
import { tenantQuery, type Principal } from '../db/tenancy.js';

/**
 * Telemetry history (PRD §9.2; the entity the PRD itself flags as missing from
 * §9.3's data model).
 *
 * The design problem is volume. The app samples at 2 Hz — 172,800 frames per
 * battery per day — and storing every one buys nothing a chart can show. So
 * ingest downsamples to one row per {@link MIN_SAMPLE_INTERVAL_MS}.
 *
 * With one exception, and it is the whole reason this is not a plain interval
 * filter: **a sample whose fault state differs from the last stored one is
 * always kept**. Downsampling away the frame where a cell over-voltage first
 * appeared would erase the moment that matters most, leaving a history that
 * looks calm either side of an event nobody can now find.
 */

/** One stored row per ten seconds of live telemetry, plus every state change. */
export const MIN_SAMPLE_INTERVAL_MS = 10_000;

/** Beyond this, history is the cloud's problem, not this table's. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface Sample {
  recordedAt: number;
  soc: number;
  packVoltage: number;
  packCurrent: number;
  temperatureC: number;
  minCellV: number;
  maxCellV: number;
  deltaMv: number;
  /** Count of active faults at this instant; the state-change trigger. */
  faultCount: number;
  balancing?: boolean;
}

export interface IngestResult {
  received: number;
  stored: number;
  /** Kept despite the interval because the fault state changed. */
  keptForStateChange: number;
}

interface LastRow {
  recorded_at: number;
  fault_count: number;
}

/**
 * Samples arrive as a batch — the app buffers while offline and uploads on
 * reconnect, so they are not necessarily recent and not necessarily in order.
 */
export async function ingestSamples(
  store: Store,
  companyId: string,
  batteryId: string,
  samples: Sample[],
  sessionId: string | null = null
): Promise<IngestResult> {
  const ordered = [...samples].sort((a, b) => a.recordedAt - b.recordedAt);

  let last = await store.get<LastRow>(
    'SELECT recorded_at, fault_count FROM telemetry_readings WHERE battery_id = ? ORDER BY recorded_at DESC LIMIT 1',
    batteryId
  );

  let stored = 0;
  let keptForStateChange = 0;

  await store.transaction(async () => {
    for (const s of ordered) {
      const changedState = last !== undefined && s.faultCount !== last.fault_count;
      const dueBySchedule =
        last === undefined || s.recordedAt - last.recorded_at >= MIN_SAMPLE_INTERVAL_MS;

      if (!dueBySchedule && !changedState) continue;
      if (changedState && !dueBySchedule) keptForStateChange += 1;

      await store.run(
        `INSERT INTO telemetry_readings
         (id, company_id, battery_id, session_id, recorded_at, soc, pack_voltage, pack_current,
          temperature_c, min_cell_v, max_cell_v, delta_mv, fault_count, balancing)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        randomUUID(),
        companyId,
        batteryId,
        sessionId,
        s.recordedAt,
        s.soc,
        s.packVoltage,
        s.packCurrent,
        s.temperatureC,
        s.minCellV,
        s.maxCellV,
        s.deltaMv,
        s.faultCount,
        s.balancing ? 1 : 0
      );
      stored += 1;
      last = { recorded_at: s.recordedAt, fault_count: s.faultCount };
    }
  });

  return { received: samples.length, stored, keptForStateChange };
}

export interface HistoryRow {
  recorded_at: number;
  soc: number;
  pack_voltage: number;
  pack_current: number;
  temperature_c: number;
  delta_mv: number;
  fault_count: number;
}

export interface HistoryQuery {
  batteryId: string;
  from?: number;
  to?: number;
  limit?: number;
}

/** Tenant-scoped like everything else; a foreign battery simply has no rows. */
export async function queryHistory(
  store: Store,
  principal: Principal,
  query: HistoryQuery
): Promise<HistoryRow[]> {
  const clauses = ['battery_id = ?'];
  const params: Param[] = [query.batteryId];

  if (query.from !== undefined) {
    clauses.push('recorded_at >= ?');
    params.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push('recorded_at <= ?');
    params.push(query.to);
  }

  const q = tenantQuery(principal, 'telemetry_readings', {
    columns:
      'recorded_at, soc, pack_voltage, pack_current, temperature_c, delta_mv, fault_count',
    where: clauses.join(' AND '),
    params,
    orderBy: 'recorded_at DESC',
  });

  const limit = Math.min(Math.max(query.limit ?? 500, 1), 5000);
  return await store.all<HistoryRow>(`${q.sql} LIMIT ?`, ...q.params, limit);
}

export interface LastReading {
  battery_id: string;
  soc: number;
  pack_voltage: number;
  fault_count: number;
  recorded_at: number;
}

/**
 * The most recent reading for each of a set of batteries.
 *
 * The fleet list needs this so it can show a real state of charge rather than
 * nothing — but it must come with `recorded_at`, because a number with no age
 * next to it reads as current. A pack last seen three weeks ago showing "41%"
 * is worse than a pack showing nothing at all: a technician can act on it.
 */
export async function lastReadings(
  store: Store,
  principal: Principal,
  batteryIds: string[]
): Promise<Map<string, LastReading>> {
  if (batteryIds.length === 0) return new Map();

  const placeholders = batteryIds.map(() => '?').join(',');
  const q = tenantQuery(principal, 'telemetry_readings', {
    columns: 'battery_id, soc, pack_voltage, fault_count, recorded_at',
    // `latest`, not `inner`: the latter is a reserved word on Postgres.
    where: `battery_id IN (${placeholders}) AND recorded_at = (
      SELECT MAX(latest.recorded_at) FROM telemetry_readings AS latest
      WHERE latest.battery_id = telemetry_readings.battery_id
    )`,
    params: batteryIds,
  });

  return new Map((await store.all<LastReading>(q.sql, ...q.params)).map((r) => [r.battery_id, r]));
}

/** Housekeeping. Unlike the audit ledger, telemetry is expected to age out. */
export async function pruneTelemetry(store: Store, now = Date.now()): Promise<void> {
  await store.run('DELETE FROM telemetry_readings WHERE recorded_at < ?', now - RETENTION_MS);
}
