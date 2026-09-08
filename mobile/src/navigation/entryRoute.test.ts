import { APP, BATTERIES, LOGIN, entryRoute, type EntryState } from './entryRoute';

const at = (over: Partial<EntryState>): EntryState => ({
  authenticated: true,
  connectedBatteryId: 'BAT-00042',
  segment: '(tabs)',
  ...over,
});

/** Every screen the app can be sitting on when the guard runs. */
const ALL_SEGMENTS = [
  undefined,
  '(tabs)',
  'login',
  'batteries',
  'protection',
  'bms-info',
  'device',
  'activity',
  'support-session',
  'help',
  'pin',
  'write',
];

describe('signed out', () => {
  it('sends every screen to Login', () => {
    for (const segment of ALL_SEGMENTS.filter((s) => s !== 'login')) {
      expect(entryRoute(at({ authenticated: false, connectedBatteryId: null, segment }))).toBe(
        LOGIN
      );
    }
  });

  it('leaves Login alone', () => {
    expect(
      entryRoute(at({ authenticated: false, connectedBatteryId: null, segment: 'login' }))
    ).toBeNull();
  });

  /** A stale link must never survive signing out into a reachable app screen. */
  it('sends to Login even if a battery id is somehow still set', () => {
    expect(
      entryRoute(at({ authenticated: false, connectedBatteryId: 'BAT-00042', segment: '(tabs)' }))
    ).toBe(LOGIN);
  });
});

describe('signed in, no link', () => {
  const unlinked = (segment: string | undefined) =>
    entryRoute(at({ connectedBatteryId: null, segment }));

  it('sends every telemetry screen to the Battery List', () => {
    for (const segment of ALL_SEGMENTS.filter((s) => s !== 'batteries' && s !== 'login')) {
      expect(unlinked(segment)).toBe(BATTERIES);
    }
  });

  it('leaves the Battery List alone', () => {
    expect(unlinked('batteries')).toBeNull();
  });

  it('sends Login to the Battery List rather than into the app', () => {
    expect(unlinked('login')).toBe(BATTERIES);
  });
});

describe('signed in and linked', () => {
  const linked = (segment: string | undefined) => entryRoute(at({ segment }));

  it('allows every app screen', () => {
    for (const segment of ALL_SEGMENTS.filter((s) => s !== 'login')) {
      expect(linked(segment)).toBeNull();
    }
  });

  it('closes off Login, sending it into the app', () => {
    expect(linked('login')).toBe(APP);
  });

  /** Switching packs must not require signing out. */
  it('keeps the Battery List reachable', () => {
    expect(linked('batteries')).toBeNull();
  });
});

describe('no redirect loops', () => {
  /**
   * Applying the guard to its own answer must settle immediately. If a target
   * redirected onward, the app would bounce between two screens forever.
   */
  const segmentOf = (route: string): string =>
    route === LOGIN ? 'login' : route === BATTERIES ? 'batteries' : '(tabs)';

  it('settles after a single redirect from every state', () => {
    for (const authenticated of [true, false]) {
      for (const connectedBatteryId of ['BAT-00042', null]) {
        for (const segment of ALL_SEGMENTS) {
          const first = entryRoute({ authenticated, connectedBatteryId, segment });
          if (first === null) continue;

          const second = entryRoute({
            authenticated,
            connectedBatteryId,
            segment: segmentOf(first),
          });
          expect(second).toBeNull();
        }
      }
    }
  });
});
