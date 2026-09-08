import { STALE_AFTER_MS, describeAge, freshnessOf } from './freshness';
import { TELEMETRY_INTERVAL_MS } from './types';

/**
 * The rule this enforces: a reading that has stopped updating must never be
 * presentable as current. Everything else about the dashboard is negotiable;
 * this is not.
 */
describe('staleness threshold', () => {
  it('allows several missed frames before crying wolf', () => {
    expect(STALE_AFTER_MS).toBeGreaterThan(TELEMETRY_INTERVAL_MS * 2);
  });

  it('is short enough that a technician cannot act on dead data for long', () => {
    expect(STALE_AFTER_MS).toBeLessThanOrEqual(5000);
  });
});

describe('freshnessOf', () => {
  const now = 1_800_000_000_000;

  it('treats a just-received frame as live', () => {
    expect(freshnessOf(now, now).stale).toBe(false);
  });

  it('tolerates a single dropped frame', () => {
    expect(freshnessOf(now - TELEMETRY_INTERVAL_MS, now).stale).toBe(false);
  });

  it('goes stale exactly at the threshold', () => {
    expect(freshnessOf(now - STALE_AFTER_MS, now).stale).toBe(true);
  });

  it('stays live just under the threshold', () => {
    expect(freshnessOf(now - (STALE_AFTER_MS - 1), now).stale).toBe(false);
  });

  it('reports the age of the reading', () => {
    expect(freshnessOf(now - 12_000, now).ageMs).toBe(12_000);
  });

  /** Before the first frame there is nothing to trust, so nothing is claimed. */
  it('treats "no frame ever received" as stale', () => {
    const f = freshnessOf(undefined, now);
    expect(f.stale).toBe(true);
    expect(f.ageMs).toBe(Number.POSITIVE_INFINITY);
    expect(f.ageLabel).toBe('never');
  });

  /** A clock that jumps backwards must not make dead data look fresh. */
  it('never reports a negative age', () => {
    expect(freshnessOf(now + 5000, now).ageMs).toBe(0);
  });
});

describe('describeAge', () => {
  it('counts whole seconds under a minute', () => {
    expect(describeAge(4_200)).toBe('4 s');
    expect(describeAge(59_000)).toBe('59 s');
  });

  it('switches to minutes', () => {
    expect(describeAge(60_000)).toBe('1 min');
    expect(describeAge(11 * 60_000)).toBe('11 min');
  });

  it('switches to hours', () => {
    expect(describeAge(3 * 60 * 60_000)).toBe('3 h');
  });

  it('says "never" when there has been no frame', () => {
    expect(describeAge(Number.POSITIVE_INFINITY)).toBe('never');
  });
});
