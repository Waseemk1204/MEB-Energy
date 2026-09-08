import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, type Store } from '../db/client.js';
import type { Principal } from '../db/tenancy.js';
import {
  MIN_SAMPLE_INTERVAL_MS,
  RETENTION_MS,
  ingestSamples,
  pruneTelemetry,
  queryHistory,
  type Sample,
} from './service.js';
import { seedCompany } from '../db/testFixtures.js';

let store: Store;

const ACME = 'company-acme';
const RIVAL = 'company-rival';
const ACME_BATTERY = 'bat-acme';
const RIVAL_BATTERY = 'bat-rival';

const acme: Principal = { userId: 'u-acme', role: 'user', companyId: ACME };
const rival: Principal = { userId: 'u-rival', role: 'user', companyId: RIVAL };
const admin: Principal = { userId: 'u-admin', role: 'admin', companyId: null };

const T0 = 1_800_000_000_000;

const sample = (over: Partial<Sample> = {}): Sample => ({
  recordedAt: T0,
  soc: 72,
  packVoltage: 79.2,
  packCurrent: 140,
  temperatureC: 24,
  minCellV: 3.29,
  maxCellV: 3.33,
  deltaMv: 40,
  faultCount: 0,
  ...over,
});

/** A realistic 2 Hz stream: one frame every 500 ms. */
const stream = (count: number, over: (i: number) => Partial<Sample> = () => ({})) =>
  Array.from({ length: count }, (_, i) =>
    sample({ recordedAt: T0 + i * 500, soc: 72 - i * 0.01, ...over(i) })
  );

const rowsFor = (p: Principal, batteryId = ACME_BATTERY) =>
  queryHistory(store, p, { batteryId, limit: 5000 });

beforeEach(() => {
  store = createStore();
  const now = Date.now();
  for (const [id, name] of [
    [ACME, 'Acme EV'],
    [RIVAL, 'Rival Fleet'],
  ] as const) {
    seedCompany(store, id, name, {}, now);
  }
  for (const [id, company, serial] of [
    [ACME_BATTERY, ACME, 'BAT-ACME-1'],
    [RIVAL_BATTERY, RIVAL, 'BAT-RIVAL-1'],
  ] as const) {
    store.run(
      'INSERT INTO batteries (id, company_id, serial, chemistry, cell_count, created_at) VALUES (?,?,?,?,?,?)',
      id, company, serial, 'LiFePO4', 24, now
    );
  }
});

afterEach(() => store.close());

/**
 * 2 Hz is 172,800 frames per battery per day. Storing all of them buys nothing
 * a chart can show.
 */
describe('downsampling', () => {
  it('keeps roughly one row per interval from a 2 Hz stream', () => {
    // 120 frames at 500 ms spans 0…59,500 ms — so the marks are 0, 10k, 20k,
    // 30k, 40k and 50k. Six rows, not seven: 59.5 s never reaches the seventh.
    const result = ingestSamples(store, ACME, ACME_BATTERY, stream(120));
    assert.equal(result.received, 120);
    assert.equal(result.stored, 6);
  });

  it('discards the overwhelming majority of a live stream', () => {
    const result = ingestSamples(store, ACME, ACME_BATTERY, stream(1200)); // 10 minutes
    // A 10 s interval over 500 ms frames is exactly one row per twenty, so the
    // assertion is that relationship rather than a round percentage.
    const framesPerRow = MIN_SAMPLE_INTERVAL_MS / 500;
    assert.ok(result.stored <= result.received / framesPerRow + 1);
    assert.ok(result.stored >= result.received / framesPerRow - 1);
  });

  it('stores the first sample unconditionally', () => {
    const result = ingestSamples(store, ACME, ACME_BATTERY, [sample()]);
    assert.equal(result.stored, 1);
  });

  it('continues the cadence across separate batches', () => {
    ingestSamples(store, ACME, ACME_BATTERY, stream(20)); // 10 s
    const second = ingestSamples(
      store,
      ACME,
      ACME_BATTERY,
      stream(20).map((s) => ({ ...s, recordedAt: s.recordedAt + 10_000 }))
    );
    // A batch boundary is not an excuse to store an extra frame.
    assert.ok(second.stored <= 2);
  });

  it('handles a batch that arrives out of order', () => {
    const shuffled = [...stream(40)].reverse();
    const result = ingestSamples(store, ACME, ACME_BATTERY, shuffled);
    const rows = rowsFor(acme).map((r) => r.recorded_at);
    assert.ok(result.stored >= 2);
    // Sorted before storing, so the timeline is coherent regardless of arrival.
    assert.deepEqual([...rows], [...rows].sort((a, b) => b - a));
  });
});

/**
 * The exception that justifies not using a plain interval filter: losing the
 * frame where a fault first appeared would erase the moment that matters most.
 */
describe('fault transitions are never downsampled away', () => {
  it('keeps a sample that raises a fault mid-interval', () => {
    // A fault appears one second in — well inside the 10 s window.
    const samples = stream(20, (i) => (i === 2 ? { faultCount: 1 } : {}));
    const result = ingestSamples(store, ACME, ACME_BATTERY, samples);
    assert.ok(result.keptForStateChange >= 1);
    assert.ok(rowsFor(acme).some((r) => r.fault_count === 1));
  });

  it('keeps the sample that clears a fault too', () => {
    const samples = stream(20, (i) => (i >= 2 && i <= 4 ? { faultCount: 1 } : {}));
    ingestSamples(store, ACME, ACME_BATTERY, samples);
    const faults = rowsFor(acme).map((r) => r.fault_count);
    assert.ok(faults.includes(1), 'the fault appearing');
    assert.ok(faults.includes(0), 'the fault clearing');
  });

  it('records the exact moment the fault appeared', () => {
    const samples = stream(20, (i) => (i === 6 ? { faultCount: 2 } : {}));
    ingestSamples(store, ACME, ACME_BATTERY, samples);
    const row = rowsFor(acme).find((r) => r.fault_count === 2);
    assert.equal(row?.recorded_at, T0 + 6 * 500);
  });

  it('does not keep every frame of a sustained fault', () => {
    // Faulted throughout: the state never changes, so normal cadence applies.
    const result = ingestSamples(store, ACME, ACME_BATTERY, stream(120, () => ({ faultCount: 1 })));
    assert.equal(result.keptForStateChange, 0);
    assert.ok(result.stored < 10);
  });
});

describe('querying history', () => {
  beforeEach(() => {
    ingestSamples(store, ACME, ACME_BATTERY, stream(240)); // 120 s
    ingestSamples(store, RIVAL, RIVAL_BATTERY, stream(240));
  });

  it('returns newest first', () => {
    const rows = rowsFor(acme);
    assert.ok(rows[0]!.recorded_at > rows[rows.length - 1]!.recorded_at);
  });

  it('filters by time range', () => {
    const rows = queryHistory(store, acme, {
      batteryId: ACME_BATTERY,
      from: T0 + 30_000,
      to: T0 + 60_000,
    });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.recorded_at >= T0 + 30_000 && r.recorded_at <= T0 + 60_000));
  });

  it('caps an absurd limit rather than trusting it', () => {
    assert.doesNotThrow(() => queryHistory(store, acme, { batteryId: ACME_BATTERY, limit: 10_000_000 }));
  });

  it('shows a tenant nothing of another’s battery', () => {
    assert.equal(rowsFor(rival, ACME_BATTERY).length, 0);
  });

  it('lets an admin read across tenants', () => {
    assert.ok(rowsFor(admin, RIVAL_BATTERY).length > 0);
  });
});

/** Unlike the audit ledger, telemetry is expected to age out. */
describe('retention', () => {
  it('drops readings past the window', () => {
    const old = Date.now() - RETENTION_MS - 60_000;
    ingestSamples(store, ACME, ACME_BATTERY, [sample({ recordedAt: old })]);
    ingestSamples(store, ACME, ACME_BATTERY, [sample({ recordedAt: Date.now() })]);
    assert.equal(rowsFor(acme).length, 2);

    pruneTelemetry(store);
    assert.equal(rowsFor(acme).length, 1);
  });

  it('keeps readings inside the window', () => {
    ingestSamples(store, ACME, ACME_BATTERY, [
      sample({ recordedAt: Date.now() - RETENTION_MS + 60_000 }),
    ]);
    pruneTelemetry(store);
    assert.equal(rowsFor(acme).length, 1);
  });

  /** Telemetry ages out; the audit trail does not. */
  it('is a shorter horizon than the audit ledger, which never prunes', () => {
    assert.ok(RETENTION_MS <= 90 * 24 * 60 * 60 * 1000);
  });
});

describe('the interval itself', () => {
  it('is coarse enough to bound storage', () => {
    assert.ok(MIN_SAMPLE_INTERVAL_MS >= 5_000);
  });

  it('is fine enough to draw a useful trend', () => {
    assert.ok(MIN_SAMPLE_INTERVAL_MS <= 60_000);
  });
});
