import type { BatterySnapshot, Fault } from './types';
import { MAX_BUFFERED, SAMPLE_INTERVAL_MS, UploadBuffer, toSample } from './uploadBuffer';

const fault = (code: string): Fault => ({ code, label: code, level: 'Critical' });

const frame = (over: Partial<BatterySnapshot> = {}): BatterySnapshot =>
  ({
    timestamp: 1_700_000_000_000,
    soc: 72,
    packVoltage: 79.2,
    packCurrent: -12.4,
    temperatures: [24, 26],
    cellVoltages: [],
    cellCount: 24,
    minCellV: 3.28,
    maxCellV: 3.31,
    deltaMv: 30,
    chargeMos: true,
    dischargeMos: true,
    balancing: false,
    balancingCells: [],
    faults: [],
    cycles: 120,
    soh: 98,
    bmsModel: 'JBD SP24S004',
    bmsFirmware: '1.2.3',
    bleState: 'connected',
    location: null,
    ...over,
  }) as BatterySnapshot;

/** Feed frames at 2 Hz starting from t0. */
const stream = (buffer: UploadBuffer, count: number, t0 = 1_700_000_000_000, faults: Fault[] = []) => {
  for (let i = 0; i < count; i += 1) {
    buffer.offer(frame({ timestamp: t0 + i * 500, faults }));
  }
};

describe('mapping a frame to the wire', () => {
  it('takes the highest probe, not an average', () => {
    // A mean would hide the thermal event this is recorded for.
    expect(toSample(frame({ temperatures: [24, 71] })).temperatureC).toBe(71);
  });

  it('survives a BMS reporting no probes at all', () => {
    expect(toSample(frame({ temperatures: [] })).temperatureC).toBe(0);
  });

  it('sends the fault count, which is what the server keys state changes on', () => {
    expect(toSample(frame({ faults: [fault('COV'), fault('OT')] })).faultCount).toBe(2);
  });
});

describe('thinning 2 Hz down to something uploadable', () => {
  it('keeps the first frame it sees', () => {
    const b = new UploadBuffer();
    expect(b.offer(frame())).toBe(true);
    expect(b.size).toBe(1);
  });

  it('drops the frames between intervals', () => {
    const b = new UploadBuffer();
    stream(b, 20); // 20 frames at 2 Hz span 9.5s — the 10s mark is not reached.
    expect(b.size).toBe(1);

    stream(b, 1, 1_700_000_000_000 + 10_000);
    expect(b.size).toBe(2);
  });

  it('keeps roughly one frame per interval over a long run', () => {
    const b = new UploadBuffer();
    stream(b, 2 * 60 * 2); // 240 frames spanning 119.5s
    expect(b.size).toBe(12); // t=0 plus the marks at 10s…110s
  });

  it('reports a frame it did not keep', () => {
    const b = new UploadBuffer();
    b.offer(frame({ timestamp: 1000 }));
    expect(b.offer(frame({ timestamp: 1500 }))).toBe(false);
  });

  it('measures the interval from the last kept frame, not from the clock', () => {
    const b = new UploadBuffer();
    b.offer(frame({ timestamp: 0 }));
    b.offer(frame({ timestamp: SAMPLE_INTERVAL_MS - 1 }));
    expect(b.size).toBe(1);
    b.offer(frame({ timestamp: SAMPLE_INTERVAL_MS }));
    expect(b.size).toBe(2);
  });
});

/**
 * The rule this class exists for. A frame discarded here is gone for good —
 * the server's own version of this rule can only protect what reaches it.
 */
describe('fault state changes are never thinned away', () => {
  it('keeps the frame where a fault first appears, mid-interval', () => {
    const b = new UploadBuffer();
    b.offer(frame({ timestamp: 0 }));
    // 1.5 seconds later, well inside the interval.
    expect(b.offer(frame({ timestamp: 1500, faults: [fault('COV')] }))).toBe(true);
    expect(b.size).toBe(2);
  });

  it('keeps the frame where a fault clears', () => {
    const b = new UploadBuffer();
    b.offer(frame({ timestamp: 0, faults: [fault('COV')] }));
    expect(b.offer(frame({ timestamp: 1000, faults: [] }))).toBe(true);
  });

  it('keeps a second fault arriving on top of the first', () => {
    const b = new UploadBuffer();
    b.offer(frame({ timestamp: 0, faults: [fault('COV')] }));
    expect(b.offer(frame({ timestamp: 800, faults: [fault('COV'), fault('OT')] }))).toBe(true);
  });

  it('marks such a frame so the cap knows not to drop it', () => {
    const b = new UploadBuffer();
    b.offer(frame({ timestamp: 0 }));
    b.offer(frame({ timestamp: 1500, faults: [fault('COV')] }));
    expect(b.peek()[1]!.stateChange).toBe(true);
  });

  it('does not mark a frame that was due anyway', () => {
    const b = new UploadBuffer();
    b.offer(frame({ timestamp: 0 }));
    b.offer(frame({ timestamp: SAMPLE_INTERVAL_MS, faults: [fault('COV')] }));
    expect(b.peek()[1]!.stateChange).toBe(false);
  });

  it('does not keep a frame merely because a fault is still present', () => {
    const b = new UploadBuffer();
    b.offer(frame({ timestamp: 0, faults: [fault('COV')] }));
    // Same fault, one second later: nothing changed.
    expect(b.offer(frame({ timestamp: 1000, faults: [fault('COV')] }))).toBe(false);
  });

  it('captures a fault that appears and clears inside one interval', () => {
    const b = new UploadBuffer();
    b.offer(frame({ timestamp: 0 }));
    b.offer(frame({ timestamp: 2000, faults: [fault('COV')] }));
    b.offer(frame({ timestamp: 4000, faults: [] }));
    expect(b.peek().map((s) => s.faultCount)).toEqual([0, 1, 0]);
  });
});

describe('the buffer’s bound', () => {
  it('stops growing past the cap', () => {
    const b = new UploadBuffer();
    stream(b, (MAX_BUFFERED + 50) * SAMPLE_INTERVAL_MS / 500);
    expect(b.size).toBe(MAX_BUFFERED);
  });

  it('drops ordinary frames rather than the ones recording a change', () => {
    const b = new UploadBuffer();
    // A fault appears early, then a long quiet run pushes past the cap.
    b.offer(frame({ timestamp: 0 }));
    b.offer(frame({ timestamp: 500, faults: [fault('COV')] }));

    for (let i = 1; i <= MAX_BUFFERED + 100; i += 1) {
      b.offer(frame({ timestamp: i * SAMPLE_INTERVAL_MS, faults: [fault('COV')] }));
    }

    expect(b.size).toBe(MAX_BUFFERED);
    expect(b.peek().some((s) => s.stateChange)).toBe(true);
  });

  it('counts what it dropped rather than hiding it', () => {
    const b = new UploadBuffer();
    stream(b, (MAX_BUFFERED + 20) * SAMPLE_INTERVAL_MS / 500);
    expect(b.dropped).toBeGreaterThan(0);
  });
});

describe('retiring what the server accepted', () => {
  it('removes the oldest frames, in the order they were sent', () => {
    const b = new UploadBuffer();
    stream(b, 60); // 30s → 4 frames
    const before = b.peek().map((s) => s.recordedAt);

    b.retire(2);
    expect(b.peek().map((s) => s.recordedAt)).toEqual(before.slice(2));
  });

  it('leaves frames that arrived while the upload was in flight', () => {
    const b = new UploadBuffer();
    b.offer(frame({ timestamp: 0 }));
    b.offer(frame({ timestamp: SAMPLE_INTERVAL_MS }));
    const sent = b.peek().length;

    // A frame arrives after the request went out.
    b.offer(frame({ timestamp: 2 * SAMPLE_INTERVAL_MS }));
    b.retire(sent);

    expect(b.size).toBe(1);
    expect(b.peek()[0]!.recordedAt).toBe(2 * SAMPLE_INTERVAL_MS);
  });

  it('ignores a nonsensical count rather than emptying itself', () => {
    const b = new UploadBuffer();
    b.offer(frame());
    b.retire(0);
    b.retire(-5);
    expect(b.size).toBe(1);
  });

  it('tolerates being told more was accepted than it holds', () => {
    const b = new UploadBuffer();
    b.offer(frame());
    b.retire(99);
    expect(b.size).toBe(0);
  });

  /**
   * After a flush the comparison must continue from what was last sent, or a
   * fault clearing immediately afterwards would look like no change at all.
   */
  it('still notices a change in the first frame after a flush', () => {
    const b = new UploadBuffer();
    b.offer(frame({ timestamp: 0, faults: [fault('COV')] }));
    b.retire(1);
    expect(b.offer(frame({ timestamp: 500, faults: [] }))).toBe(true);
  });
});

describe('linking to a different pack', () => {
  it('carries nothing over from the previous one', () => {
    const b = new UploadBuffer();
    stream(b, 40, 0, [fault('COV')]);
    b.reset();

    expect(b.size).toBe(0);
    expect(b.dropped).toBe(0);
    // The first frame of the new pack is kept unconditionally.
    expect(b.offer(frame({ timestamp: 999_999 }))).toBe(true);
  });
});

/**
 * A fabricated reading is indistinguishable from a measured one once it is a
 * row in a table. `72.81 %` says nothing about where it came from — so the
 * only place that can refuse it is the point where the source is still known.
 *
 * `USE_MOCK` being off is not a sufficient guard on its own: a flag can be
 * flipped by mistake, and nothing downstream could tell afterwards. This is
 * the second one.
 */
describe('frames that did not come from hardware', () => {
  it('are refused', () => {
    const b = new UploadBuffer();
    expect(b.offer(frame(), true)).toBe(false);
    expect(b.size).toBe(0);
  });

  it('are refused however many arrive', () => {
    const b = new UploadBuffer();
    for (let i = 0; i < 50; i += 1) b.offer(frame({ timestamp: i * 10_000 }), true);
    expect(b.size).toBe(0);
  });

  it('are counted rather than silently dropped', () => {
    const b = new UploadBuffer();
    for (let i = 0; i < 3; i += 1) b.offer(frame({ timestamp: i * 10_000 }), true);
    expect(b.refused).toBe(3);
  });

  /**
   * A refused frame must not count against the interval either, or the first
   * real frame after a simulated one would be thinned away for arriving too
   * soon after something that was never uploaded.
   */
  it('do not disturb the thinning of real ones', () => {
    const b = new UploadBuffer();
    b.offer(frame({ timestamp: 0 }), true);
    expect(b.offer(frame({ timestamp: 100 }), false)).toBe(true);
    expect(b.size).toBe(1);
  });

  it('do not consume a fault transition', () => {
    const b = new UploadBuffer();
    b.offer(frame({ timestamp: 0, faults: [fault('COV')] }), true);

    // The first real frame is kept unconditionally; the transition after it
    // must still register.
    b.offer(frame({ timestamp: 1000 }), false);
    expect(b.offer(frame({ timestamp: 1500, faults: [fault('COV')] }), false)).toBe(true);
  });

  it('still lets real frames through by default', () => {
    const b = new UploadBuffer();
    expect(b.offer(frame())).toBe(true);
    expect(b.refused).toBe(0);
  });
});
