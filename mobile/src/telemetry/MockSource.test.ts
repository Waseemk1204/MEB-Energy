import { MockSource } from './MockSource';
import type { BatterySnapshot } from './types';

/** Grab the first snapshot without leaving an interval running. */
function firstSnapshot(source: MockSource): BatterySnapshot {
  let snap: BatterySnapshot | null = null;
  source.start((s) => {
    snap ??= s;
  });
  source.stop();
  return snap!;
}

describe('MockSource physics', () => {
  it('keeps pack voltage equal to the sum of its cells', () => {
    const s = firstSnapshot(new MockSource());
    const sum = s.cellVoltages.reduce((a, b) => a + b, 0);
    expect(s.packVoltage).toBeCloseTo(sum, 6);
  });

  it('reports one voltage per series cell', () => {
    const s = firstSnapshot(new MockSource());
    expect(s.cellCount).toBe(24);
    expect(s.cellVoltages).toHaveLength(24);
  });

  it('keeps min/max/delta consistent with the cell array', () => {
    const s = firstSnapshot(new MockSource());
    expect(s.minCellV).toBe(Math.min(...s.cellVoltages));
    expect(s.maxCellV).toBe(Math.max(...s.cellVoltages));
    expect(s.deltaMv).toBeCloseTo((s.maxCellV - s.minCellV) * 1000, 6);
  });

  it('holds cells in a plausible LiFePO4 band', () => {
    const s = firstSnapshot(new MockSource());
    for (const v of s.cellVoltages) {
      expect(v).toBeGreaterThan(2.5);
      expect(v).toBeLessThan(3.9);
    }
  });

  it('keeps SOC inside its bounds', () => {
    const s = firstSnapshot(new MockSource());
    expect(s.soc).toBeGreaterThanOrEqual(4);
    expect(s.soc).toBeLessThanOrEqual(100);
  });

  /** PRD §7.16 — the field is reserved and stays null until GPS hardware exists. */
  it('never invents a location', () => {
    expect(firstSnapshot(new MockSource()).location).toBeNull();
  });

  it('is deterministic for a given seed', () => {
    const a = firstSnapshot(new MockSource(12345));
    const b = firstSnapshot(new MockSource(12345));
    expect(a.soc).toBe(b.soc);
    expect(a.packCurrent).toBe(b.packCurrent);
    expect(a.cellVoltages).toEqual(b.cellVoltages);
  });

  it('diverges for different seeds', () => {
    const a = firstSnapshot(new MockSource(1));
    const b = firstSnapshot(new MockSource(2));
    expect(a.cellVoltages).not.toEqual(b.cellVoltages);
  });

  it('raises a critical fault only when a cell is genuinely over the limit', () => {
    const s = firstSnapshot(new MockSource());
    const ovp = s.faults.find((f) => f.code === 'CELL_OVP');
    if (ovp) {
      expect(s.maxCellV).toBeGreaterThan(3.75);
      expect(ovp.level).toBe('Critical');
    } else {
      expect(s.maxCellV).toBeLessThanOrEqual(3.75);
    }
  });
});

describe('MockSource streaming', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('emits at 2 Hz and stops cleanly', () => {
    const source = new MockSource();
    const seen: BatterySnapshot[] = [];
    source.start((s) => seen.push(s));

    expect(seen).toHaveLength(1); // immediate first frame, no blank dashboard
    jest.advanceTimersByTime(2000);
    expect(seen).toHaveLength(5); // 1 + 4 ticks at 500ms

    source.stop();
    jest.advanceTimersByTime(2000);
    expect(seen).toHaveLength(5);
  });

  it('moves SOC and current together rather than independently', () => {
    const source = new MockSource();
    const seen: BatterySnapshot[] = [];
    source.start((s) => seen.push(s));
    jest.advanceTimersByTime(10_000);
    source.stop();

    // Over any step where current was clearly charging, SOC must not fall.
    let checked = 0;
    for (let i = 1; i < seen.length; i++) {
      if (seen[i].packCurrent > 50) {
        expect(seen[i].soc).toBeGreaterThanOrEqual(seen[i - 1].soc);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('re-starting does not leave the previous interval running', () => {
    const source = new MockSource();
    const seen: BatterySnapshot[] = [];
    source.start((s) => seen.push(s));
    source.start((s) => seen.push(s));
    seen.length = 0;
    jest.advanceTimersByTime(1000);
    expect(seen).toHaveLength(2); // one stream, not two
    source.stop();
  });
});

describe('MockSource writes', () => {
  it('reads back the value it was given', async () => {
    const source = new MockSource();
    const result = await source.writeSetting('cell_ovp', 3.8);
    expect(result.ok).toBe(true);
    expect(result.readBack).toBe(3.8);
    expect(await source.readSetting('cell_ovp')).toBe(3.8);
  });
});
