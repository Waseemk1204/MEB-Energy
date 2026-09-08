import {
  LOG_CAP,
  clearLog,
  formatLog,
  getLog,
  logError,
  logInfo,
  logWarn,
  subscribe,
} from './fieldLog';

beforeEach(() => clearLog());

describe('recording', () => {
  it('keeps entries in the order they happened', () => {
    logInfo('ble', 'first');
    logInfo('ble', 'second');
    expect(getLog().map((e) => e.message)).toEqual(['first', 'second']);
  });

  it('records the level and category', () => {
    logWarn('write', 'timed out', { key: 'cell_ovp' });
    expect(getLog()[0]).toMatchObject({ level: 'warn', category: 'write', message: 'timed out' });
  });

  it('timestamps every entry', () => {
    const before = Date.now();
    logInfo('app', 'started');
    expect(getLog()[0].at).toBeGreaterThanOrEqual(before);
  });

  it('notifies subscribers', () => {
    const seen = jest.fn();
    const stop = subscribe(seen);
    logInfo('ui', 'rendered');
    expect(seen).toHaveBeenCalled();
    stop();
  });

  it('stops notifying once unsubscribed', () => {
    const seen = jest.fn();
    subscribe(seen)();
    logInfo('ui', 'rendered');
    expect(seen).not.toHaveBeenCalled();
  });
});

/**
 * The log is exported by hand from the field, so it must never be able to carry
 * a secret out with it. Redaction happens centrally rather than at call sites,
 * because a call site that forgets is exactly how a leak happens.
 */
describe('redaction', () => {
  it.each(['pin', 'token', 'password', 'authToken', 'apiSecret', 'passphrase'])(
    'never records a value under %s',
    (key) => {
      logInfo('session', 'signed in', { [key]: '481902' });
      expect(getLog()[0].detail?.[key]).toBe('[redacted]');
    }
  );

  it('redacts regardless of case', () => {
    logInfo('session', 'x', { PIN: '1234', Token: 'abc' });
    expect(getLog()[0].detail).toEqual({ PIN: '[redacted]', Token: '[redacted]' });
  });

  it('keeps ordinary diagnostic context', () => {
    logInfo('ble', 'connected', { battery: 'BAT-00042', rssi: -62, verified: true });
    expect(getLog()[0].detail).toEqual({ battery: 'BAT-00042', rssi: -62, verified: true });
  });

  it('never leaks a secret into the formatted export', () => {
    logInfo('session', 'signed in', { token: 'super-secret-value' });
    expect(formatLog()).not.toContain('super-secret-value');
    expect(formatLog()).toContain('[redacted]');
  });
});

describe('the cap', () => {
  it('bounds memory by dropping the oldest', () => {
    for (let i = 0; i < LOG_CAP + 40; i++) logInfo('app', `entry ${i}`);
    expect(getLog()).toHaveLength(LOG_CAP);
    expect(getLog()[0].message).toBe('entry 40');
  });

  it('always keeps the most recent event', () => {
    for (let i = 0; i < LOG_CAP * 2; i++) logInfo('app', `entry ${i}`);
    expect(getLog()[getLog().length - 1].message).toBe(`entry ${LOG_CAP * 2 - 1}`);
  });
});

describe('formatting', () => {
  it('says so plainly when there is nothing to report', () => {
    expect(formatLog()).toBe('No diagnostic entries recorded.');
  });

  it('produces one plain-text line per entry', () => {
    logInfo('ble', 'connected');
    logError('write', 'failed');
    const lines = formatLog().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/INFO {2}ble {5}connected/);
    expect(lines[1]).toMatch(/ERROR write {3}failed/);
  });

  it('includes context on the line it belongs to', () => {
    logWarn('write', 'timeout', { key: 'cell_ovp' });
    expect(formatLog()).toContain('{"key":"cell_ovp"}');
  });
});

describe('clearing', () => {
  it('empties the buffer', () => {
    logInfo('app', 'x');
    clearLog();
    expect(getLog()).toHaveLength(0);
  });
});
