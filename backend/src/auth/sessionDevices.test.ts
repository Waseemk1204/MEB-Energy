import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, type Store } from '../db/client.js';
import { issueRefreshToken, revokeRefreshToken, rotateRefreshToken } from './tokens.js';
import { adjustLimits } from '../admin/entitlement.js';
import { seedCompany } from '../db/testFixtures.js';
import {
  DEFAULT_SESSION_DEVICES,
  describeDevice,
  enforceDeviceLimit,
  labelFor,
  liveSessions,
  sessionDeviceLimit,
  sessionDeviceUsage,
} from './sessionDevices.js';

/**
 * A company owner's login is the credential most likely to be shared. These
 * are the rules that stop one paid account becoming a floating licence.
 */

let store: Store;
const NOW = 1_700_000_000_000;
const ACME = 'c-acme';

const owner = { id: 'u-owner', role: 'company', companyId: ACME, company_id: ACME };
const tech = { id: 'u-tech', role: 'user', companyId: ACME, company_id: ACME };
const admin = { id: 'u-admin', role: 'admin', companyId: null, company_id: null };

/** A sign-in: make room, then take the slot — the order login uses. */
const signIn = (
  user: { id: string; role: string; company_id: string | null },
  label: string,
  at: number
) => {
  const evicted = enforceDeviceLimit(store, user, at);
  const issued = issueRefreshToken(store, user.id, at, label);
  return { evicted, token: issued.token };
};

const labelsOf = (userId: string) =>
  liveSessions(store, userId, NOW + 1)
    .map((s) => s.device_label)
    .sort();

beforeEach(() => {
  store = createStore();
  seedCompany(store, ACME, 'Acme EV', {}, NOW);
  const insert = (u: { id: string; role: string; company_id: string | null }) =>
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      u.id, u.company_id, `${u.id}@acme.example`, u.id, u.role, 'x', 'active', NOW
    );
  insert(owner);
  insert(tech);
  insert(admin);
});

afterEach(() => store.close());

describe('the limit itself', () => {
  it('is two unless somebody changes it', () => {
    assert.equal(DEFAULT_SESSION_DEVICES, 2);
    assert.equal(sessionDeviceLimit(store, ACME), 2);
  });

  it('takes whatever the plan says', () => {
    adjustLimits(store, ACME, { sessionDeviceLimit: 5 });
    assert.equal(sessionDeviceLimit(store, ACME), 5);
  });

  /**
   * The gateway `device_limit` counts knowyourEV hardware. Two different
   * things called "device" is exactly how the two get conflated, so this
   * pins them apart: moving one must not move the other.
   */
  it('is a different number from the gateway limit', () => {
    adjustLimits(store, ACME, { deviceLimit: 40 });
    assert.equal(sessionDeviceLimit(store, ACME), 2);

    adjustLimits(store, ACME, { sessionDeviceLimit: 6 });
    const row = store.get<{ device_limit: number }>(
      "SELECT device_limit FROM subscriptions WHERE company_id = ? AND status = 'active'",
      ACME
    );
    assert.equal(row?.device_limit, 40);
  });
});

describe('signing in on more devices than allowed', () => {
  it('lets the first two through untouched', () => {
    assert.deepEqual(signIn(owner, 'phone', NOW).evicted, []);
    assert.deepEqual(signIn(owner, 'laptop', NOW + 1).evicted, []);
    assert.deepEqual(labelsOf(owner.id), ['laptop', 'phone']);
  });

  it('signs out the oldest when a third arrives', () => {
    signIn(owner, 'phone', NOW);
    signIn(owner, 'laptop', NOW + 1);
    const third = signIn(owner, 'tablet', NOW + 2);

    assert.equal(third.evicted.length, 1);
    assert.equal(third.evicted[0]!.label, 'phone');
    assert.deepEqual(labelsOf(owner.id), ['laptop', 'tablet']);
  });

  /** The point of the cap: the count never exceeds it, however many sign in. */
  it('never leaves more than the limit live', () => {
    for (let i = 0; i < 8; i += 1) signIn(owner, `device-${i}`, NOW + i);
    assert.equal(liveSessions(store, owner.id, NOW + 100).length, 2);
  });

  it('evicts enough at once when the limit has been lowered under them', () => {
    adjustLimits(store, ACME, { sessionDeviceLimit: 4 });
    for (let i = 0; i < 4; i += 1) signIn(owner, `device-${i}`, NOW + i);

    adjustLimits(store, ACME, { sessionDeviceLimit: 2 });
    const next = signIn(owner, 'newest', NOW + 10);

    assert.equal(next.evicted.length, 3);
    assert.equal(liveSessions(store, owner.id, NOW + 100).length, 2);
  });

  it('lets a raised limit hold more', () => {
    adjustLimits(store, ACME, { sessionDeviceLimit: 4 });
    for (let i = 0; i < 4; i += 1) assert.deepEqual(signIn(owner, `d${i}`, NOW + i).evicted, []);
    assert.equal(liveSessions(store, owner.id, NOW + 100).length, 4);
  });

  /**
   * An evicted token is revoked, not deleted — so the device holding it finds
   * out at its next renewal rather than carrying on for a fortnight.
   */
  it('makes the evicted device’s token stop working', () => {
    const first = signIn(owner, 'phone', NOW);
    signIn(owner, 'laptop', NOW + 1);
    signIn(owner, 'tablet', NOW + 2);

    assert.throws(() => rotateRefreshToken(store, first.token, NOW + 3), /already been used/);
  });

  it('leaves the surviving devices working', () => {
    signIn(owner, 'phone', NOW);
    const second = signIn(owner, 'laptop', NOW + 1);
    signIn(owner, 'tablet', NOW + 2);

    assert.doesNotThrow(() => rotateRefreshToken(store, second.token, NOW + 3));
  });

  it('tells the new device what it signed out', () => {
    signIn(owner, 'Safari on iPhone', NOW);
    signIn(owner, 'Chrome on Mac', NOW + 1);
    const third = signIn(owner, 'tablet', NOW + 2);

    assert.match(describeDevice(third.evicted[0]!, NOW + 2), /Safari on iPhone/);
  });
});

describe('who the cap applies to', () => {
  /**
   * The company *account* is capped; technicians hold their own seats and are
   * counted by the seat limit instead. Capping them too would mean a field
   * user with a phone and a tablet losing one at every sign-in.
   */
  it('does not touch a field user', () => {
    for (let i = 0; i < 6; i += 1) signIn(tech, `d${i}`, NOW + i);
    assert.equal(liveSessions(store, tech.id, NOW + 100).length, 6);
  });

  it('does not touch a platform administrator', () => {
    for (let i = 0; i < 6; i += 1) signIn(admin, `d${i}`, NOW + i);
    assert.equal(liveSessions(store, admin.id, NOW + 100).length, 6);
  });

  /** One owner reaching the cap must not sign another owner out. */
  it('counts each account separately', () => {
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      'u-owner-2', ACME, 'owner2@acme.example', 'Owner Two', 'company', 'x', 'active', NOW
    );
    const other = { id: 'u-owner-2', role: 'company', company_id: ACME };

    signIn(other, 'their-phone', NOW);
    for (let i = 0; i < 5; i += 1) signIn(owner, `d${i}`, NOW + i);

    assert.deepEqual(labelsOf('u-owner-2'), ['their-phone']);
  });
});

describe('what counts as live', () => {
  it('ignores an expired session', () => {
    signIn(owner, 'phone', NOW);
    signIn(owner, 'laptop', NOW + 1);

    // Far enough ahead that both refresh tokens have lapsed on their own.
    const later = NOW + 400 * 24 * 60 * 60 * 1000;
    assert.deepEqual(signIn(owner, 'tablet', later).evicted, []);
  });

  it('ignores a session that was signed out', () => {
    const first = signIn(owner, 'phone', NOW);
    signIn(owner, 'laptop', NOW + 1);
    revokeRefreshToken(store, first.token, NOW + 2);

    // The freed slot is the whole point: signing out on one device is how you
    // make room on another without waiting for an eviction.
    assert.deepEqual(signIn(owner, 'tablet', NOW + 3).evicted, []);
    assert.deepEqual(labelsOf(owner.id), ['laptop', 'tablet']);
  });

  /**
   * Rotation is the same device continuing. If it counted as a new one, a
   * device would evict its own sibling every fifteen minutes.
   */
  it('does not treat a renewal as another device', () => {
    const first = signIn(owner, 'phone', NOW);
    signIn(owner, 'laptop', NOW + 1);

    rotateRefreshToken(store, first.token, NOW + 2);

    assert.equal(liveSessions(store, owner.id, NOW + 3).length, 2);
    assert.deepEqual(labelsOf(owner.id), ['laptop', 'phone']);
  });
});

describe('reporting it to an administrator', () => {
  it('counts the owner devices in use against the cap', () => {
    signIn(owner, 'phone', NOW);
    assert.deepEqual(sessionDeviceUsage(store, ACME, NOW + 1), { used: 1, limit: 2 });
  });

  it('does not count a field user’s devices towards it', () => {
    signIn(tech, 'phone', NOW);
    assert.equal(sessionDeviceUsage(store, ACME, NOW + 1).used, 0);
  });
});

describe('naming the device', () => {
  const cases: [string, string][] = [
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605 Safari/604.1', 'Safari on iPhone'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0 Safari/537', 'Chrome on Mac'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/120 Safari/537 Edg/120', 'Edge on Windows'],
    ['Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537', 'Chrome on Android'],
    ['knowyourEV/1.0 CFNetwork/1490 Darwin/23.0', 'knowyourEV app'],
  ];

  for (const [agent, expected] of cases) {
    it(`reads ${expected}`, () => assert.equal(labelFor(agent), expected));
  }

  it('has no name for a client that sends none', () => {
    assert.equal(labelFor(undefined), null);
  });

  it('says something rather than nothing for an unfamiliar client', () => {
    assert.equal(labelFor('curl/8.4.0'), 'curl/8.4.0');
  });

  it('describes a device without a name rather than printing null', () => {
    const described = describeDevice({ label: null, lastUsedAt: NOW }, NOW + 60_000);
    assert.match(described, /unrecognised device/);
    assert.ok(!described.includes('null'));
  });
});
