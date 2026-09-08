import { useSessionStore } from './useSessionStore';
import { login } from '../api/auth';

/**
 * The concurrent-device cap is enforced on the server; this is the half that
 * makes it visible. Signing somebody out silently would be the same event with
 * the only useful part removed.
 *
 * Separate from SignedOutBanner.test.tsx on purpose: that proves the banner
 * renders what the store holds, this proves signing in is what puts it there.
 */

/*
 * OFFLINE_AUTH and DEV_BYPASS_AUTH are `__DEV__ && true`, and `__DEV__` is true
 * under jest — so by default signIn returns a fake session without ever
 * contacting the server, and the whole real sign-in path is unreachable from a
 * test. Both are switched off here so this exercises the real one.
 */
jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  OFFLINE_AUTH: false,
  DEV_BYPASS_AUTH: false,
}));

jest.mock('../diagnostics/fieldLog', () => ({ logWarn: jest.fn(), logInfo: jest.fn() }));
jest.mock('../api/auth', () => ({
  ...jest.requireActual('../api/auth'),
  login: jest.fn(),
}));
jest.mock('./sessionStorage', () => ({
  saveSession: jest.fn(async () => undefined),
  clearSession: jest.fn(async () => undefined),
  loadSession: jest.fn(async () => null),
}));
jest.mock('../api/session', () => ({
  api: {},
  setTokens: jest.fn(),
  onSessionExpired: jest.fn(),
}));

const mockLogin = login as jest.MockedFunction<typeof login>;

const respondsWith = (over: Record<string, unknown>) =>
  mockLogin.mockResolvedValue({
    accessToken: 'a',
    refreshToken: 'r',
    user: { id: 'u', email: 'a@b.c', displayName: 'W Khan', role: 'company' },
    company: { id: 'c', name: 'Aurora Fleet' },
    ...over,
  } as Awaited<ReturnType<typeof login>>);

beforeEach(() => {
  mockLogin.mockReset();
  useSessionStore.setState({ signedOut: [], authenticated: false, signingIn: false });
});

it('starts with nothing signed out', () => {
  expect(useSessionStore.getState().signedOut).toEqual([]);
});

it('records what the sign-in signed out', async () => {
  respondsWith({ signedOut: ['Safari on iPhone, last used 3h ago'] });
  await useSessionStore.getState().signIn('a@b.c', 'pw');

  expect(useSessionStore.getState().signedOut).toEqual(['Safari on iPhone, last used 3h ago']);
});

it('holds nothing when nothing was signed out', async () => {
  respondsWith({ signedOut: [] });
  await useSessionStore.getState().signIn('a@b.c', 'pw');

  expect(useSessionStore.getState().signedOut).toEqual([]);
});

/** An older backend does not send the field; absent must not become undefined. */
it('holds an empty list when the server omits the field', async () => {
  respondsWith({});
  await useSessionStore.getState().signIn('a@b.c', 'pw');

  expect(useSessionStore.getState().signedOut).toEqual([]);
});

/**
 * The next person to use this handset is often a different person. Carrying
 * the last one's notice across would tell them about a device that is not
 * theirs, on an account that is not theirs.
 */
it('clears the notice on sign-out', async () => {
  respondsWith({ signedOut: ['Safari on iPhone, last used 3h ago'] });
  await useSessionStore.getState().signIn('a@b.c', 'pw');

  useSessionStore.getState().signOut();
  expect(useSessionStore.getState().signedOut).toEqual([]);
});

it('does not carry one sign-in’s notice into the next', async () => {
  respondsWith({ signedOut: ['Safari on iPhone, last used 3h ago'] });
  await useSessionStore.getState().signIn('a@b.c', 'pw');

  useSessionStore.getState().signOut();
  respondsWith({ signedOut: [] });
  await useSessionStore.getState().signIn('other@b.c', 'pw');

  expect(useSessionStore.getState().signedOut).toEqual([]);
});

it('can be dismissed without signing out', async () => {
  respondsWith({ signedOut: ['Safari on iPhone, last used 3h ago'] });
  await useSessionStore.getState().signIn('a@b.c', 'pw');

  useSessionStore.getState().dismissSignedOut();
  expect(useSessionStore.getState().signedOut).toEqual([]);
  expect(useSessionStore.getState().authenticated).toBe(true);
});
