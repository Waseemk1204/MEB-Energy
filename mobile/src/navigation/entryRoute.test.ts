import {
  ACCEPT_INVITE,
  APP,
  BATTERIES,
  COMPANY,
  LOGIN,
  entryRoute,
  type EntryRole,
  type EntryState,
} from './entryRoute';

const ROLES: EntryRole[] = ['company', 'user'];

// A field technician unless a test says otherwise: the pack flow these cases
// describe is theirs, and the role-specific cases set it explicitly.
const at = (over: Partial<EntryState>): EntryState => ({
  authenticated: true,
  role: 'user',
  connectedBatteryId: 'BAT-00042',
  segment: '(tabs)',
  ...over,
});

/** Every screen the app can be sitting on when the guard runs. */
const ALL_SEGMENTS = [
  undefined,
  'accept-invite',
  'company',
  'users',
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
    for (const segment of ALL_SEGMENTS.filter((s) => s !== 'login' && s !== 'accept-invite')) {
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

  /** The one screen somebody with no account yet is meant to reach. */
  it('leaves the invitation screen alone', () => {
    expect(
      entryRoute(at({ authenticated: false, connectedBatteryId: null, segment: 'accept-invite' }))
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
    const packFlow = ALL_SEGMENTS.filter(
      (s) => !['batteries', 'login', 'accept-invite', 'company', 'users'].includes(s ?? '')
    );
    for (const segment of packFlow) expect(unlinked(segment)).toBe(BATTERIES);
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

  it('allows every screen in the pack flow', () => {
    const packFlow = ALL_SEGMENTS.filter(
      (s) => !['login', 'accept-invite', 'company', 'users'].includes(s ?? '')
    );
    for (const segment of packFlow) expect(linked(segment)).toBeNull();
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
    route === LOGIN ? 'login'
    : route === BATTERIES ? 'batteries'
    : route === COMPANY ? 'company'
    : route === ACCEPT_INVITE ? 'accept-invite'
    : '(tabs)';

  it('settles after a single redirect from every state', () => {
    for (const role of ROLES) {
      for (const authenticated of [true, false]) {
        for (const connectedBatteryId of ['BAT-00042', null]) {
          for (const segment of ALL_SEGMENTS) {
            const first = entryRoute({ authenticated, role, connectedBatteryId, segment });
            if (first === null) continue;

            const second = entryRoute({
              authenticated,
              role,
              connectedBatteryId,
              segment: segmentOf(first),
            });
            expect(second).toBeNull();
          }
        }
      }
    }
  });
});


/**
 * One login, two destinations.
 *
 * This decides where the app *sends* somebody. It is not the security
 * boundary: every route below is checked again on the server against the
 * token, so a tampered role changes what is shown and never what can be read
 * or written.
 */
describe('where each role lands', () => {
  const from = (role: EntryRole, segment: string, connectedBatteryId: string | null = null) =>
    entryRoute({ authenticated: true, role, connectedBatteryId, segment });

  it('sends an administrator to the company surface', () => {
    expect(from('company', 'login')).toBe(COMPANY);
  });

  it('sends a field user to the Battery List, as before', () => {
    expect(from('user', 'login')).toBe(BATTERIES);
  });

  /**
   * A linked session goes back to the pack rather than a role surface: the
   * link is the more specific fact, and it is what the person was doing.
   */
  it('returns any role to a live pack over their home', () => {
    for (const role of ROLES) expect(from(role, 'login', 'BAT-00042')).toBe(APP);
  });
});

describe('surfaces that belong to a role', () => {
  const on = (role: EntryRole, segment: string) =>
    entryRoute({ authenticated: true, role, connectedBatteryId: null, segment });

  it('keeps a technician off the company surface', () => {
    expect(on('user', 'company')).toBe(BATTERIES);
    expect(on('user', 'users')).toBe(BATTERIES);
  });

  it('leaves an administrator alone on their own surface', () => {
    expect(on('company', 'company')).toBeNull();
    expect(on('company', 'users')).toBeNull();
  });

  /**
   * A role surface is not part of the pack flow, so the no-link rule must not
   * drag an administrator towards the Battery List while they are on it.
   */
  it('does not push an unlinked administrator out of their own surface', () => {
    expect(on('company', 'company')).toBeNull();
  });

  /** The pack flow itself is open to everyone who is signed in. */
  it('lets an administrator into the pack flow', () => {
    expect(on('company', 'batteries')).toBeNull();
    expect(entryRoute({ authenticated: true, role: 'company', connectedBatteryId: 'B', segment: '(tabs)' })).toBeNull();
  });

  /**
   * The invitation screen signs somebody in as a new person, so it must stay
   * reachable even while a session exists — it signs that session out itself.
   */
  it('leaves the invitation screen reachable while signed in', () => {
    for (const role of ROLES) expect(on(role, 'accept-invite')).toBeNull();
  });
});
