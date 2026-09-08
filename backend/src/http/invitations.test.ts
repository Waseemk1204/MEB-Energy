import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createStore, type Store } from '../db/client.js';
import { hashPassword } from '../auth/password.js';
import { secretFrom } from '../auth/tokens.js';
import { NO_PASSWORD } from '../auth/invitations.js';
import { seedParameterDefinitions } from '../policy/seed.js';
import type { Dispatcher } from '../policy/writeService.js';
import { createLimiter } from './rateLimit.js';
import { buildServer } from '../server.js';
import { seedCompany } from '../db/testFixtures.js';

/**
 * Inviting somebody, over HTTP, the way the console does it.
 */

const SECRET = secretFrom('an-invitation-signing-secret-length!!');
const CHEAP = { N: 2 ** 12, r: 8, p: 1 };
const PASSWORD = 'correct-horse-battery-staple';
const ACME = 'company-acme';

let store: Store;
let app: FastifyInstance;

const dispatcher: Dispatcher = { send: async ({ value }) => ({ result: 'success', readBack: value }) };

beforeEach(async () => {
  store = createStore();
  seedParameterDefinitions(store);
  const now = Date.now();
  const hash = await hashPassword(PASSWORD, CHEAP);

  seedCompany(store, ACME, 'Acme EV', {}, now);
  store.run(
    'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
    'u-admin', null, 'ops@knowyourev.example', 'Ops', 'admin', hash, 'active', now
  );
  store.run(
    'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
    'u-admin-2', null, 'ops2@knowyourev.example', 'Ops Two', 'admin', hash, 'active', now
  );

  app = buildServer({
    store,
    secret: SECRET,
    dispatcher,
    loginLimiter: createLimiter(50, 60_000),
    inviteLimiter: createLimiter(50, 60_000),
  });
});

afterEach(() => store.close());

const adminToken = async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'ops@knowyourev.example', password: PASSWORD },
  });
  return (res.json() as { accessToken: string }).accessToken;
};

const invite = async (over: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: '/users',
    headers: { authorization: `Bearer ${await adminToken()}` },
    payload: {
      companyId: ACME,
      email: 'new@acme.example',
      displayName: 'New Person',
      role: 'user',
      ...over,
    },
  });

const accept = (token: string, password: string) =>
  app.inject({ method: 'POST', url: '/auth/accept-invite', payload: { token, password } });

const login = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });

describe('creating a user by invitation', () => {
  it('returns a token, once', async () => {
    const res = await invite();
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().status, 'invited');
    assert.ok(res.json().invitation.token);
  });

  it('never returns a password, because there is not one', async () => {
    const body = (await invite()).json();
    assert.ok(!('password' in body));
    assert.ok(!JSON.stringify(body).includes(PASSWORD));
  });

  it('creates an account that cannot be signed into yet', async () => {
    await invite();
    const res = await login('new@acme.example', 'anything-at-all-here');
    assert.equal(res.statusCode, 401);
  });

  /**
   * Two independent reasons the account is unusable: the status is not
   * 'active', and the stored hash is not a valid scrypt hash so verification
   * fails closed even if the status check were somehow missed.
   */
  it('stores no usable password hash', async () => {
    await invite();
    const row = store.get<{ password_hash: string; status: string }>(
      'SELECT password_hash, status FROM users WHERE email = ?',
      'new@acme.example'
    );
    assert.equal(row?.password_hash, NO_PASSWORD);
    assert.equal(row?.status, 'invited');
  });

  it('still accepts an explicit password for the paths that need one', async () => {
    const res = await invite({ email: 'direct@acme.example', password: 'a-directly-set-password' });
    assert.equal(res.json().status, 'active');
    assert.equal(res.json().invitation, null);
    assert.equal((await login('direct@acme.example', 'a-directly-set-password')).statusCode, 200);
  });
});

describe('accepting the invitation', () => {
  it('sets a password and signs the person straight in', async () => {
    const { invitation } = (await invite()).json();
    const res = await accept(invitation.token, 'my-own-first-passphrase');

    assert.equal(res.statusCode, 200);
    assert.ok(res.json().accessToken);
    assert.equal(res.json().user.email, 'new@acme.example');
    assert.equal(res.json().company.name, 'Acme EV');
  });

  it('lets them sign in normally afterwards', async () => {
    const { invitation } = (await invite()).json();
    await accept(invitation.token, 'my-own-first-passphrase');
    assert.equal((await login('new@acme.example', 'my-own-first-passphrase')).statusCode, 200);
  });

  it('refuses a second use of the same link', async () => {
    const { invitation } = (await invite()).json();
    await accept(invitation.token, 'my-own-first-passphrase');

    const res = await accept(invitation.token, 'somebody-elses-passphrase');
    assert.equal(res.statusCode, 400);
    // The first password still stands.
    assert.equal((await login('new@acme.example', 'my-own-first-passphrase')).statusCode, 200);
    assert.equal((await login('new@acme.example', 'somebody-elses-passphrase')).statusCode, 401);
  });

  /** A guess must not learn whether a token ever existed. */
  it('reads the same for an unknown token as for a spent one', async () => {
    const { invitation } = (await invite()).json();
    await accept(invitation.token, 'my-own-first-passphrase');

    const spent = await accept(invitation.token, 'another-passphrase-x');
    const unknown = await accept('a'.repeat(43), 'another-passphrase-x');

    assert.equal(spent.statusCode, unknown.statusCode);
    assert.deepEqual(spent.json(), unknown.json());
  });

  it('says what is wrong with a weak password, which is actionable', async () => {
    const { invitation } = (await invite()).json();
    const res = await accept(invitation.token, 'short');
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /at least \d+ characters/);
  });

  it('rate-limits attempts on a token', async () => {
    const limited = buildServer({
      store,
      secret: SECRET,
      dispatcher,
      loginLimiter: createLimiter(50, 60_000),
      inviteLimiter: createLimiter(2, 60_000),
    });

    const token = 'b'.repeat(43);
    for (let i = 0; i < 2; i += 1) {
      await limited.inject({ method: 'POST', url: '/auth/accept-invite', payload: { token, password: 'a-long-enough-one' } });
    }
    const res = await limited.inject({
      method: 'POST',
      url: '/auth/accept-invite',
      payload: { token, password: 'a-long-enough-one' },
    });
    assert.equal(res.statusCode, 429);
  });

  it('needs no authentication, since the person has none yet', async () => {
    const { invitation } = (await invite()).json();
    const res = await accept(invitation.token, 'my-own-first-passphrase');
    assert.equal(res.statusCode, 200);
  });
});

/**
 * Flipping an unaccepted account to 'active' would produce one that looks
 * usable and cannot be signed into — worse than the honest state it is in.
 */
describe('an invitation nobody has accepted', () => {
  it('cannot be activated by hand', async () => {
    const created = (await invite()).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${created.id}/status`,
      headers: { authorization: `Bearer ${await adminToken()}` },
      payload: { status: 'active' },
    });

    assert.equal(res.statusCode, 409);
    assert.match(res.json().message, /has not been accepted/);
  });

  it('can still be suspended, which is how you cancel one', async () => {
    const created = (await invite()).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${created.id}/status`,
      headers: { authorization: `Bearer ${await adminToken()}` },
      payload: { status: 'suspended' },
    });
    assert.equal(res.statusCode, 204);
  });

  it('shows as invited in the user list', async () => {
    await invite();
    const res = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { authorization: `Bearer ${await adminToken()}` },
    });
    const row = (res.json().users as { email: string; status: string }[]).find(
      (u) => u.email === 'new@acme.example'
    );
    assert.equal(row?.status, 'invited');
  });
});
