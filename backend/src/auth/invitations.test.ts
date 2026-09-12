import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, type Store } from '../db/client.js';
import { verifyPassword } from './password.js';
import {
  INVITATION_TTL_MS,
  InvitationError,
  MIN_PASSWORD_LENGTH,
  NO_PASSWORD,
  acceptInvitation,
  createInvitation,
  pendingInvitations,
} from './invitations.js';
import { seedCompany } from '../db/testFixtures.js';

/**
 * Invitations exist so that nobody but the account holder ever knows their
 * password. These are the rules that make that true.
 */

let store: Store;
const NOW = 1_700_000_000_000;
const GOOD_PASSWORD = 'a-real-first-passphrase';

const seedUser = (id: string, email: string, status = 'invited', hash = NO_PASSWORD) => {
  store.run(
    'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
    id, 'c1', email, email, 'user', hash, status, NOW
  );
};

beforeEach(() => {
  store = createStore();
  seedCompany(store, 'c1', 'Acme', NOW);
  store.run(
    'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
    'admin-1', 'c1', 'ops@acme.example', 'Ops', 'company', 'hash', 'active', NOW
  );
  seedUser('u-invited', 'new@acme.example');
});

afterEach(() => store.close());

describe('issuing an invitation', () => {
  it('returns a token the caller can hand over', () => {
    const invitation = createInvitation(store, 'u-invited', 'admin-1', NOW);
    assert.ok(invitation.token.length >= 40);
    assert.equal(invitation.expiresAt, NOW + INVITATION_TTL_MS);
  });

  /** A database dump must not hand someone every outstanding invitation. */
  it('never stores the token itself', () => {
    const { token } = createInvitation(store, 'u-invited', 'admin-1', NOW);
    const rows = store.all<{ token_hash: string }>('SELECT token_hash FROM user_invitations');
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]!.token_hash, token);
    assert.ok(!rows[0]!.token_hash.includes(token));
  });

  it('issues a different token every time', () => {
    const seen = new Set(
      Array.from({ length: 25 }, () => createInvitation(store, 'u-invited', 'admin-1', NOW).token)
    );
    assert.equal(seen.size, 25);
  });

  it('records who issued it', () => {
    createInvitation(store, 'u-invited', 'admin-1', NOW);
    const row = store.get<{ invited_by: string }>('SELECT invited_by FROM user_invitations');
    assert.equal(row?.invited_by, 'admin-1');
  });
});

describe('accepting an invitation', () => {
  it('sets the password and activates the account', async () => {
    const { token } = createInvitation(store, 'u-invited', 'admin-1', NOW);
    const { userId } = await acceptInvitation(store, token, GOOD_PASSWORD, NOW + 1000);

    assert.equal(userId, 'u-invited');
    const row = store.get<{ status: string; password_hash: string }>(
      'SELECT status, password_hash FROM users WHERE id = ?',
      'u-invited'
    );
    assert.equal(row?.status, 'active');
    assert.equal(await verifyPassword(GOOD_PASSWORD, row!.password_hash), true);
  });

  it('replaces the placeholder that made the account unusable', async () => {
    const { token } = createInvitation(store, 'u-invited', 'admin-1', NOW);
    await acceptInvitation(store, token, GOOD_PASSWORD, NOW + 1000);
    const row = store.get<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = ?',
      'u-invited'
    );
    assert.notEqual(row?.password_hash, NO_PASSWORD);
  });

  it('marks the invitation as spent', async () => {
    const { token } = createInvitation(store, 'u-invited', 'admin-1', NOW);
    await acceptInvitation(store, token, GOOD_PASSWORD, NOW + 1000);
    const row = store.get<{ accepted_at: number | null }>(
      'SELECT accepted_at FROM user_invitations'
    );
    assert.equal(row?.accepted_at, NOW + 1000);
  });
});

describe('what an invitation refuses', () => {
  /** The property the whole feature rests on: a link works exactly once. */
  it('cannot be used twice', async () => {
    const { token } = createInvitation(store, 'u-invited', 'admin-1', NOW);
    await acceptInvitation(store, token, GOOD_PASSWORD, NOW + 1000);

    await assert.rejects(
      () => acceptInvitation(store, token, 'a-different-passphrase', NOW + 2000),
      (error: InvitationError) => error.code === 'already_used'
    );
  });

  it('leaves the first password in place after a second attempt', async () => {
    const { token } = createInvitation(store, 'u-invited', 'admin-1', NOW);
    await acceptInvitation(store, token, GOOD_PASSWORD, NOW + 1000);
    await acceptInvitation(store, token, 'a-different-passphrase', NOW + 2000).catch(() => undefined);

    const row = store.get<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = ?',
      'u-invited'
    );
    assert.equal(await verifyPassword(GOOD_PASSWORD, row!.password_hash), true);
    assert.equal(await verifyPassword('a-different-passphrase', row!.password_hash), false);
  });

  it('expires', async () => {
    const { token } = createInvitation(store, 'u-invited', 'admin-1', NOW);
    await assert.rejects(
      () => acceptInvitation(store, token, GOOD_PASSWORD, NOW + INVITATION_TTL_MS + 1),
      (error: InvitationError) => error.code === 'expired'
    );
  });

  it('works right up to the moment it expires', async () => {
    const { token } = createInvitation(store, 'u-invited', 'admin-1', NOW);
    await assert.doesNotReject(() =>
      acceptInvitation(store, token, GOOD_PASSWORD, NOW + INVITATION_TTL_MS - 1)
    );
  });

  it('rejects a token nobody issued', async () => {
    await assert.rejects(
      () => acceptInvitation(store, 'not-a-real-token-at-all', GOOD_PASSWORD, NOW),
      (error: InvitationError) => error.code === 'not_found'
    );
  });

  it('rejects a password too short to be worth setting', async () => {
    const { token } = createInvitation(store, 'u-invited', 'admin-1', NOW);
    await assert.rejects(
      () => acceptInvitation(store, token, 'x'.repeat(MIN_PASSWORD_LENGTH - 1), NOW + 1000),
      (error: InvitationError) => error.code === 'weak_password'
    );
  });

  /** A rejected weak password must not consume the invitation. */
  it('does not spend the invitation on a rejected password', async () => {
    const { token } = createInvitation(store, 'u-invited', 'admin-1', NOW);
    await acceptInvitation(store, token, 'short', NOW + 1000).catch(() => undefined);

    await assert.doesNotReject(() => acceptInvitation(store, token, GOOD_PASSWORD, NOW + 2000));
  });

  it('does not activate the account when it refuses', async () => {
    const { token } = createInvitation(store, 'u-invited', 'admin-1', NOW);
    await acceptInvitation(store, token, GOOD_PASSWORD, NOW + INVITATION_TTL_MS + 1).catch(
      () => undefined
    );

    const row = store.get<{ status: string }>('SELECT status FROM users WHERE id = ?', 'u-invited');
    assert.equal(row?.status, 'invited');
  });
});

describe('what is still outstanding', () => {
  it('lists an unaccepted invitation without exposing its token', () => {
    createInvitation(store, 'u-invited', 'admin-1', NOW);
    const pending = pendingInvitations(store, ['u-invited']);

    const entry = pending.get('u-invited');
    assert.ok(entry);
    assert.equal(entry.expiresAt, NOW + INVITATION_TTL_MS);
    assert.ok(!('token' in entry));
  });

  it('drops one that has been accepted', async () => {
    const { token } = createInvitation(store, 'u-invited', 'admin-1', NOW);
    await acceptInvitation(store, token, GOOD_PASSWORD, NOW + 1000);
    assert.equal(pendingInvitations(store, ['u-invited']).size, 0);
  });

  it('reports the newest when an account was invited more than once', () => {
    createInvitation(store, 'u-invited', 'admin-1', NOW);
    createInvitation(store, 'u-invited', 'admin-1', NOW + 5000);
    const entry = pendingInvitations(store, ['u-invited']).get('u-invited');
    assert.equal(entry?.expiresAt, NOW + 5000 + INVITATION_TTL_MS);
  });

  it('is empty for a user who was never invited', () => {
    seedUser('u-direct', 'direct@acme.example', 'active', 'a-real-hash');
    assert.equal(pendingInvitations(store, ['u-direct']).size, 0);
  });

  it('handles being asked about nobody', () => {
    assert.equal(pendingInvitations(store, []).size, 0);
  });
});
