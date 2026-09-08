import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, type Store } from '../db/client.js';
import { DEFAULT_COST, hashPassword, needsRehash, verifyPassword } from './password.js';
import { NO_PASSWORD } from './invitations.js';
import {
  ACCESS_TTL_SECONDS,
  AuthError,
  issueAccessToken,
  issueRefreshToken,
  revokeAllForUser,
  revokeRefreshToken,
  rotateRefreshToken,
  secretFrom,
  verifyAccessToken,
} from './tokens.js';
import type { Principal } from '../db/tenancy.js';
import { seedCompany } from '../db/testFixtures.js';

/** Cheap parameters so the suite stays fast; production uses DEFAULT_COST. */
const TEST_COST = { N: 2 ** 12, r: 8, p: 1 };

const SECRET = secretFrom('a-test-signing-secret-of-sufficient-length');

let store: Store;
const USER = 'user-1';
const COMPANY = 'company-acme';

beforeEach(() => {
  store = createStore();
  const now = Date.now();
  seedCompany(store, COMPANY, 'Acme EV', {}, now);
  store.run(
    'INSERT INTO users (id, company_id, email, display_name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?)',
    USER,
    COMPANY,
    'w@acme.example',
    'W',
    'user',
    'x',
    now
  );
});

afterEach(() => store.close());

describe('password hashing', () => {
  it('verifies the correct password', async () => {
    const stored = await hashPassword('correct-horse-battery-staple', TEST_COST);
    assert.equal(await verifyPassword('correct-horse-battery-staple', stored), true);
  });

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('correct-horse', TEST_COST);
    assert.equal(await verifyPassword('incorrect-horse', stored), false);
  });

  it('never stores the password itself', async () => {
    const stored = await hashPassword('hunter2', TEST_COST);
    assert.ok(!stored.includes('hunter2'));
  });

  /** Two users with the same password must not share a hash. */
  it('salts every hash', async () => {
    const a = await hashPassword('same-password', TEST_COST);
    const b = await hashPassword('same-password', TEST_COST);
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('same-password', a), true);
    assert.equal(await verifyPassword('same-password', b), true);
  });

  it('records the cost so it can be raised later', async () => {
    const stored = await hashPassword('x', TEST_COST);
    assert.ok(stored.startsWith(`scrypt$${TEST_COST.N}$${TEST_COST.r}$${TEST_COST.p}$`));
  });

  it('flags a hash made with weaker parameters for upgrade', async () => {
    const weak = await hashPassword('x', TEST_COST);
    assert.equal(needsRehash(weak, DEFAULT_COST), true);
  });

  it('does not flag a current hash', async () => {
    const stored = await hashPassword('x', TEST_COST);
    assert.equal(needsRehash(stored, TEST_COST), false);
  });

  it('refuses an empty password', async () => {
    await assert.rejects(() => hashPassword('', TEST_COST), /must not be empty/);
  });

  /** A corrupt record must fail closed, not crash the sign-in path. */
  for (const malformed of ['', 'nonsense', 'scrypt$1$2', 'bcrypt$1$8$1$aaa$bbb', 'scrypt$x$8$1$aa$bb']) {
    it(`returns false for a malformed stored hash: ${JSON.stringify(malformed)}`, async () => {
      assert.equal(await verifyPassword('anything', malformed), false);
    });
  }
});

describe('access tokens', () => {
  const principal: Principal = { userId: USER, role: 'user', companyId: COMPANY };

  it('round-trips a principal', async () => {
    const token = await issueAccessToken(principal, SECRET);
    assert.deepEqual(await verifyAccessToken(token, SECRET), principal);
  });

  it('carries an admin with no tenant', async () => {
    const admin: Principal = { userId: 'admin-1', role: 'admin', companyId: null };
    const token = await issueAccessToken(admin, SECRET);
    assert.deepEqual(await verifyAccessToken(token, SECRET), admin);
  });

  it('rejects a token signed with another secret', async () => {
    const token = await issueAccessToken(principal, secretFrom('a-different-secret-of-enough-length!!'));
    await assert.rejects(() => verifyAccessToken(token, SECRET), AuthError);
  });

  it('rejects a tampered token', async () => {
    const token = await issueAccessToken(principal, SECRET);
    const [h, p, s] = token.split('.');
    const forged = `${h}.${Buffer.from('{"sub":"attacker","role":"admin","cid":null}').toString('base64url')}.${s}`;
    await assert.rejects(() => verifyAccessToken(forged, SECRET), AuthError);
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - ACCESS_TTL_SECONDS - 60;
    const token = await issueAccessToken(principal, SECRET, past);
    await assert.rejects(
      () => verifyAccessToken(token, SECRET),
      (e: AuthError) => e.code === 'expired_token'
    );
  });

  /** The schema's rule, restated at the token boundary. */
  it('rejects an admin token that also claims a tenant', async () => {
    const token = await issueAccessToken(
      { userId: 'x', role: 'admin', companyId: 'company-acme' },
      SECRET
    );
    await assert.rejects(() => verifyAccessToken(token, SECRET), /disagree/);
  });

  it('rejects a non-admin token with no tenant', async () => {
    const token = await issueAccessToken({ userId: 'x', role: 'user', companyId: null }, SECRET);
    await assert.rejects(() => verifyAccessToken(token, SECRET), /disagree/);
  });

  it('is short-lived', () => {
    assert.ok(ACCESS_TTL_SECONDS <= 30 * 60);
  });

  it('refuses a signing secret that is too short', () => {
    assert.throws(() => secretFrom('too-short'), /at least 32/);
  });
});

describe('refresh tokens', () => {
  it('issues a token that is not stored in the clear', () => {
    const { token } = issueRefreshToken(store, USER);
    const rows = store.all<{ token_hash: string }>('SELECT token_hash FROM refresh_tokens');
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]!.token_hash, token);
  });

  it('rotates to a new token', () => {
    const first = issueRefreshToken(store, USER);
    const second = rotateRefreshToken(store, first.token);
    assert.notEqual(second.token, first.token);
  });

  it('marks the old token as replaced by the new one', () => {
    const first = issueRefreshToken(store, USER);
    const second = rotateRefreshToken(store, first.token);
    const row = store.get<{ revoked_at: number; replaced_by: string }>(
      'SELECT revoked_at, replaced_by FROM refresh_tokens WHERE id = ?',
      first.id
    );
    assert.ok(row?.revoked_at);
    assert.equal(row?.replaced_by, second.id);
  });

  it('rejects a token it has never seen', () => {
    assert.throws(
      () => rotateRefreshToken(store, 'not-a-real-token'),
      (e: AuthError) => e.code === 'unknown_token'
    );
  });

  it('rejects an expired token', () => {
    const { token } = issueRefreshToken(store, USER, Date.now() - 40 * 24 * 60 * 60 * 1000);
    assert.throws(
      () => rotateRefreshToken(store, token),
      (e: AuthError) => e.code === 'expired_token'
    );
  });

  /**
   * The security property that justifies rotation at all. A replayed token
   * cannot be distinguished from a confused client, and only one of those is
   * safe to assume — so the whole chain goes.
   */
  describe('reuse detection', () => {
    it('rejects a token that has already been rotated', () => {
      const first = issueRefreshToken(store, USER);
      rotateRefreshToken(store, first.token);
      assert.throws(
        () => rotateRefreshToken(store, first.token),
        (e: AuthError) => e.code === 'reuse_detected'
      );
    });

    it('revokes the entire chain, not just the replayed token', () => {
      const first = issueRefreshToken(store, USER);
      const second = rotateRefreshToken(store, first.token);
      const third = rotateRefreshToken(store, second.token);

      try {
        rotateRefreshToken(store, first.token);
      } catch {
        /* expected */
      }

      // The newest token, held by whoever was legitimate, is dead too.
      assert.throws(
        () => rotateRefreshToken(store, third.token),
        (e: AuthError) => e.code === 'reuse_detected' || e.code === 'unknown_token'
      );
      const live = store.all('SELECT id FROM refresh_tokens WHERE revoked_at IS NULL');
      assert.equal(live.length, 0);
    });

    it('does not touch another user’s sessions', () => {
      store.run(
        'INSERT INTO users (id, company_id, email, display_name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?)',
        'user-2',
        COMPANY,
        'other@acme.example',
        'O',
        'user',
        'x',
        Date.now()
      );
      const mine = issueRefreshToken(store, USER);
      const theirs = issueRefreshToken(store, 'user-2');
      rotateRefreshToken(store, mine.token);
      try {
        rotateRefreshToken(store, mine.token);
      } catch {
        /* expected */
      }
      assert.doesNotThrow(() => rotateRefreshToken(store, theirs.token));
    });
  });

  describe('sign-out', () => {
    it('revokes the presented token', () => {
      const { token } = issueRefreshToken(store, USER);
      revokeRefreshToken(store, token);
      assert.throws(
        () => rotateRefreshToken(store, token),
        (e: AuthError) => e.code === 'reuse_detected'
      );
    });

    it('is idempotent for an unknown token', () => {
      assert.doesNotThrow(() => revokeRefreshToken(store, 'never-existed'));
    });

    it('revokes every session for a user on demand', () => {
      issueRefreshToken(store, USER);
      issueRefreshToken(store, USER);
      revokeAllForUser(store, USER);
      assert.equal(store.all('SELECT id FROM refresh_tokens WHERE revoked_at IS NULL').length, 0);
    });
  });
});

/**
 * Verification failing closed.
 *
 * This is load-bearing in two places. An invited account stores `$invited$`
 * rather than a hash, and its unverifiability is the second of the two
 * independent reasons such an account cannot be signed into — the first being
 * its status. And a corrupt record must refuse a sign-in rather than crash the
 * path or, worse, be processed under the wrong algorithm.
 *
 * None of it was tested: removing the shape check passed the whole suite.
 */
describe('a stored hash that is not one', () => {
  const NOTHING = 'any-password-at-all';

  it('never verifies the invited-account placeholder', async () => {
    assert.equal(await verifyPassword(NOTHING, NO_PASSWORD), false);
  });

  it('never verifies an empty string', async () => {
    assert.equal(await verifyPassword(NOTHING, ''), false);
  });

  /**
   * A real scrypt hash with the algorithm label changed.
   *
   * This is the case the prefix check exists for, and the only one that can
   * demonstrate it: a made-up hash from another algorithm is refused anyway
   * because the digest does not match, so it proves nothing. This one *would*
   * verify without the check — the password is correct and the parameters are
   * genuine. Only the label says it is not scrypt.
   */
  it('refuses a hash whose algorithm label is not scrypt', async () => {
    const real = await hashPassword('a-real-password', { N: 2 ** 12, r: 8, p: 1 });
    assert.equal(await verifyPassword('a-real-password', real), true);

    const relabelled = real.replace(/^scrypt/, 'argon2id');
    assert.equal(await verifyPassword('a-real-password', relabelled), false);
  });

  it('refuses a hash with the wrong number of parts', async () => {
    for (const stored of ['scrypt$16384$8$1$c2FsdA==', 'scrypt$16384$8$1$c2FsdA==$aGFzaA==$extra']) {
      assert.equal(await verifyPassword(NOTHING, stored), false);
    }
  });

  it('refuses non-numeric cost parameters', async () => {
    assert.equal(
      await verifyPassword(NOTHING, 'scrypt$notanumber$8$1$c2FsdA==$aGFzaA=='),
      false
    );
  });

  it('refuses an empty salt or an empty digest', async () => {
    assert.equal(await verifyPassword(NOTHING, 'scrypt$16384$8$1$$aGFzaA=='), false);
    assert.equal(await verifyPassword(NOTHING, 'scrypt$16384$8$1$c2FsdA==$'), false);
  });

  /** Returns false rather than throwing — the sign-in path must not crash. */
  it('does not throw on any of them', async () => {
    for (const stored of ['', '$invited$', 'nonsense', 'scrypt$$$$$', 'a$b$c$d$e$f']) {
      await assert.doesNotReject(() => verifyPassword(NOTHING, stored));
    }
  });

  it('still verifies a genuine hash', async () => {
    const hash = await hashPassword('a-real-password', { N: 2 ** 12, r: 8, p: 1 });
    assert.equal(await verifyPassword('a-real-password', hash), true);
    assert.equal(await verifyPassword('a-different-password', hash), false);
  });
});
