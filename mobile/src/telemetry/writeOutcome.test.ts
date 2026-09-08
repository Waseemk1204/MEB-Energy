import {
  LinkLostError,
  WRITE_TIMEOUT_MS,
  WriteTimeoutError,
  classifyWrite,
  executeWrite,
  isLinkLoss,
  valuesMatch,
} from './writeOutcome';
import type { TelemetrySource } from './types';

const source = (writeSetting: TelemetrySource['writeSetting']): TelemetrySource => ({
  simulated: false,
    start: jest.fn(),
  stop: jest.fn(),
  readSetting: jest.fn(async () => 0),
  writeSetting,
});

/**
 * The rule these enforce: the app may only claim a value is on the BMS when it
 * has read that value back. Everything else is reported as unknown.
 */
describe('classifyWrite', () => {
  it('confirms a write whose read-back matches', () => {
    const c = classifyWrite(3.8, 3, { ok: true, readBack: 3.8 }, null);
    expect(c.outcome).toBe('success');
    expect(c.confirmedValue).toBe(3.8);
    expect(c.message).toBeNull();
  });

  it('reports a BMS rejection as a rejection', () => {
    const c = classifyWrite(3.8, 3, { ok: false, error: 'Out of range' }, null);
    expect(c.outcome).toBe('rejected');
    expect(c.confirmedValue).toBeNull();
    expect(c.message).toBe('Out of range');
  });

  /** A clamp or rounding rule on the BMS side. The write worked; the value differs. */
  it('flags a value the BMS stored differently', () => {
    const c = classifyWrite(3.8, 3, { ok: true, readBack: 3.75 }, null);
    expect(c.outcome).toBe('adjusted');
    expect(c.confirmedValue).toBe(3.75);
    expect(c.message).toMatch(/stored 3\.750 rather than 3\.800/);
  });

  it('does not mistake float noise for an adjusted value', () => {
    const c = classifyWrite(3.8, 3, { ok: true, readBack: 3.8000001 }, null);
    expect(c.outcome).toBe('success');
  });

  /** Accepted, but nothing came back — so nothing is confirmed. */
  it('treats an accepted write with no read-back as unknown', () => {
    const c = classifyWrite(3.8, 3, { ok: true }, null);
    expect(c.outcome).toBe('indeterminate');
    expect(c.confirmedValue).toBeNull();
  });

  it('treats a timeout as unknown, never as failure', () => {
    const c = classifyWrite(3.8, 3, undefined, new WriteTimeoutError());
    expect(c.outcome).toBe('timeout');
    expect(c.confirmedValue).toBeNull();
    expect(c.message).toMatch(/may or may not have been applied/);
  });

  it('treats a lost link as unknown, never as failure', () => {
    const c = classifyWrite(3.8, 3, undefined, new LinkLostError());
    expect(c.outcome).toBe('indeterminate');
    expect(c.confirmedValue).toBeNull();
    expect(c.message).toMatch(/may or may not have changed/);
  });

  it('never confirms a value for any unknown outcome', () => {
    for (const error of [new WriteTimeoutError(), new LinkLostError()]) {
      expect(classifyWrite(3.8, 3, undefined, error).confirmedValue).toBeNull();
    }
    expect(classifyWrite(3.8, 3, { ok: true }, null).confirmedValue).toBeNull();
  });
});

describe('valuesMatch', () => {
  it('compares at the parameter precision', () => {
    expect(valuesMatch(3.8, 3.8004, 3)).toBe(true);
    expect(valuesMatch(3.8, 3.806, 3)).toBe(false);
  });

  it('handles whole-number parameters', () => {
    expect(valuesMatch(65, 65, 0)).toBe(true);
    expect(valuesMatch(65, 66, 0)).toBe(false);
  });
});

describe('isLinkLoss', () => {
  it.each([
    'Device disconnected',
    'BLE connection lost',
    'Operation was cancelled',
    'Device is not connected',
  ])('recognises %s as a possible in-flight command', (message) => {
    expect(isLinkLoss(new Error(message))).toBe(true);
  });

  it('does not treat an ordinary failure as a lost link', () => {
    expect(isLinkLoss(new Error('Checksum mismatch'))).toBe(false);
  });
});

describe('executeWrite', () => {
  it('returns success when the source confirms', async () => {
    const s = source(jest.fn(async (_k, v) => ({ ok: true, readBack: v })));
    await expect(executeWrite(s, 'cell_ovp', 3.8, 3)).resolves.toMatchObject({
      outcome: 'success',
      confirmedValue: 3.8,
    });
  });

  it('reports unknown rather than hanging when the BMS never answers', async () => {
    const s = source(() => new Promise(() => undefined)); // never settles
    const c = await executeWrite(s, 'cell_ovp', 3.8, 3, 30);
    expect(c.outcome).toBe('timeout');
    expect(c.confirmedValue).toBeNull();
  });

  it('reports unknown when the link drops mid-write', async () => {
    const s = source(async () => {
      throw new Error('Device disconnected');
    });
    const c = await executeWrite(s, 'cell_ovp', 3.8, 3);
    expect(c.outcome).toBe('indeterminate');
  });

  it('reports a rejection for an ordinary error', async () => {
    const s = source(async () => {
      throw new Error('Checksum mismatch');
    });
    const c = await executeWrite(s, 'cell_ovp', 3.8, 3);
    expect(c.outcome).toBe('rejected');
  });

  it('refuses to write with no source rather than pretending', async () => {
    const c = await executeWrite(null, 'cell_ovp', 3.8, 3);
    expect(c.outcome).toBe('rejected');
    expect(c.message).toMatch(/Not connected/);
  });

  it('gives the radio a bounded but realistic deadline', () => {
    expect(WRITE_TIMEOUT_MS).toBeGreaterThanOrEqual(3000);
    expect(WRITE_TIMEOUT_MS).toBeLessThanOrEqual(15000);
  });
});
