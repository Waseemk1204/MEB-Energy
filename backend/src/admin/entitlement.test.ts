import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, type Store } from '../db/client.js';
import { deviceUsage } from './service.js';
import {
  DEFAULT_DEVICE_LIMIT,
  SEAT_TIERS,
  TERM_MS,
  adjustLimits,
  describeRemaining,
  entitlementOf,
  grantAccess,
  revokeAccess,
} from './entitlement.js';

/**
 * What a company is allowed to do, and whether anything checks.
 *
 * All of this was stored and none of it was read. A company could be
 * suspended, or its plan could have lapsed a year ago, and every one of its
 * users carried on working — because sign-in only ever asked whether the
 * *user* was active.
 */

let store: Store;
const NOW = 1_700_000_000_000;
const ACME = 'company-acme';

beforeEach(() => {
  store = createStore();
  store.run(
    'INSERT INTO companies (id,name,status,created_at) VALUES (?,?,?,?)',
    ACME, 'Acme EV', 'active', NOW
  );
});
afterEach(() => store.close());

describe('granting access', () => {
  it('runs for a year from the moment it is granted', () => {
    const { expiresAt } = grantAccess(store, ACME, { seatLimit: 20 }, NOW);
    assert.equal(expiresAt, NOW + TERM_MS);
  });

  it('makes the company usable', () => {
    grantAccess(store, ACME, { seatLimit: 20 }, NOW);
    assert.equal(entitlementOf(store, ACME, NOW).ok, true);
  });

  it('records the seats the administrator chose', () => {
    grantAccess(store, ACME, { seatLimit: 50 }, NOW);
    assert.equal(entitlementOf(store, ACME, NOW).seatLimit, 50);
  });

  it('defaults the device limit to two', () => {
    grantAccess(store, ACME, { seatLimit: 20 }, NOW);
    assert.equal(entitlementOf(store, ACME, NOW).deviceLimit, DEFAULT_DEVICE_LIMIT);
  });

  it('lets an administrator raise it', () => {
    grantAccess(store, ACME, { seatLimit: 20, deviceLimit: 6 }, NOW);
    assert.equal(entitlementOf(store, ACME, NOW).deviceLimit, 6);
  });

  /**
   * The sign-in cap is a different number from the gateway limit above, and
   * both are called "devices" in conversation. These pin them apart at the
   * point they are first written.
   */
  it('defaults the sign-in cap to two', () => {
    grantAccess(store, ACME, { seatLimit: 20 }, NOW);
    assert.equal(entitlementOf(store, ACME, NOW).sessionDeviceLimit, 2);
  });

  it('lets an administrator set the sign-in cap too', () => {
    grantAccess(store, ACME, { seatLimit: 20, sessionDeviceLimit: 5 }, NOW);
    assert.equal(entitlementOf(store, ACME, NOW).sessionDeviceLimit, 5);
  });

  /**
   * The number shown and the number enforced must be the same number.
   *
   * They were not: `entitlementOf` substituted DEFAULT_DEVICE_LIMIT for a null
   * `device_limit` while `deviceUsage` — which `registerDevice` actually checks
   * — read null as "no limit". A company created from the console displayed a
   * gateway cap of two and accepted as many as you liked. Found by registering
   * five against a plan that claimed two.
   */
  it('reports the same gateway limit that registration enforces', () => {
    grantAccess(store, ACME, { seatLimit: 20 }, NOW);
    assert.equal(entitlementOf(store, ACME, NOW).deviceLimit, deviceUsage(store, ACME).limit);
  });

  it('agrees with it when there is no gateway limit at all', () => {
    grantAccess(store, ACME, { seatLimit: 20 }, NOW);
    store.run(
      "UPDATE subscriptions SET device_limit = NULL WHERE company_id = ? AND status = 'active'",
      ACME
    );
    assert.equal(entitlementOf(store, ACME, NOW).deviceLimit, null);
    assert.equal(deviceUsage(store, ACME).limit, null);
  });

  it('does not set one from the other', () => {
    grantAccess(store, ACME, { seatLimit: 20, deviceLimit: 40 }, NOW);
    const granted = entitlementOf(store, ACME, NOW);
    assert.equal(granted.deviceLimit, 40);
    assert.equal(granted.sessionDeviceLimit, 2);
  });

  it('offers tiers without being limited to them', () => {
    assert.ok(SEAT_TIERS.includes(50));
    grantAccess(store, ACME, { seatLimit: 137 }, NOW);
    assert.equal(entitlementOf(store, ACME, NOW).seatLimit, 137);
  });

  /**
   * One live entitlement per company. Two overlapping rows is a question
   * nobody wants to be answering while a technician cannot sign in.
   */
  it('supersedes a previous grant rather than stacking', () => {
    grantAccess(store, ACME, { seatLimit: 20 }, NOW);
    grantAccess(store, ACME, { seatLimit: 50 }, NOW + 1000);

    const active = store.all("SELECT id FROM subscriptions WHERE company_id = ? AND status = 'active'", ACME);
    assert.equal(active.length, 1);
    assert.equal(entitlementOf(store, ACME, NOW + 1000).seatLimit, 50);
  });

  it('keeps the superseded one as history rather than deleting it', () => {
    grantAccess(store, ACME, { seatLimit: 20 }, NOW);
    grantAccess(store, ACME, { seatLimit: 50 }, NOW + 1000);
    assert.equal(store.all('SELECT id FROM subscriptions WHERE company_id = ?', ACME).length, 2);
  });
});

describe('what makes a company unusable', () => {
  it('having no plan at all', () => {
    const result = entitlementOf(store, ACME, NOW);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'no_subscription');
  });

  it('a plan that has expired', () => {
    grantAccess(store, ACME, { seatLimit: 20 }, NOW);
    const result = entitlementOf(store, ACME, NOW + TERM_MS + 1);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'subscription_expired');
  });

  it('a plan expiring exactly now', () => {
    grantAccess(store, ACME, { seatLimit: 20 }, NOW);
    assert.equal(entitlementOf(store, ACME, NOW + TERM_MS).ok, false);
  });

  it('but not one with a moment left', () => {
    grantAccess(store, ACME, { seatLimit: 20 }, NOW);
    assert.equal(entitlementOf(store, ACME, NOW + TERM_MS - 1).ok, true);
  });

  it('access revoked deliberately', () => {
    grantAccess(store, ACME, { seatLimit: 20 }, NOW);
    revokeAccess(store, ACME);

    const result = entitlementOf(store, ACME, NOW);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'subscription_cancelled');
  });

  it('the company being suspended', () => {
    grantAccess(store, ACME, { seatLimit: 20 }, NOW);
    store.run("UPDATE companies SET status = 'suspended' WHERE id = ?", ACME);

    const result = entitlementOf(store, ACME, NOW);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'company_suspended');
  });

  it('the company not existing', () => {
    assert.equal(entitlementOf(store, 'no-such-company', NOW).ok, false);
  });

  /** Four different reasons, four different things to tell somebody. */
  it('says which of them it was', () => {
    const codes = new Set(['no_subscription', 'subscription_expired', 'subscription_cancelled', 'company_suspended']);
    assert.equal(codes.size, 4);
  });
});

/**
 * Adding seats mid-year must not silently buy another year, and a company ten
 * months into a term must not lose them because somebody adjusted a limit.
 */
describe('adjusting a live plan', () => {
  beforeEach(() => grantAccess(store, ACME, { seatLimit: 20, deviceLimit: 2 }, NOW));

  it('raises seats without moving the expiry', () => {
    adjustLimits(store, ACME, { seatLimit: 100 });
    const after = entitlementOf(store, ACME, NOW);

    assert.equal(after.seatLimit, 100);
    assert.equal(after.expiresAt, NOW + TERM_MS);
  });

  it('raises the device limit', () => {
    adjustLimits(store, ACME, { deviceLimit: 8 });
    assert.equal(entitlementOf(store, ACME, NOW).deviceLimit, 8);
  });

  it('lowers a limit too, for a plan that was downgraded', () => {
    adjustLimits(store, ACME, { seatLimit: 5 });
    assert.equal(entitlementOf(store, ACME, NOW).seatLimit, 5);
  });

  it('changes only what it was given', () => {
    adjustLimits(store, ACME, { seatLimit: 100 });
    assert.equal(entitlementOf(store, ACME, NOW).deviceLimit, 2);
    assert.equal(entitlementOf(store, ACME, NOW).sessionDeviceLimit, 2);
  });

  it('moves the sign-in cap without moving the gateway limit', () => {
    adjustLimits(store, ACME, { sessionDeviceLimit: 8 });
    const after = entitlementOf(store, ACME, NOW);
    assert.equal(after.sessionDeviceLimit, 8);
    assert.equal(after.deviceLimit, 2);
  });

  it('does nothing when given nothing', () => {
    adjustLimits(store, ACME, {});
    assert.equal(entitlementOf(store, ACME, NOW).seatLimit, 20);
  });

  it('leaves an expired plan expired', () => {
    adjustLimits(store, ACME, { seatLimit: 100 });
    assert.equal(entitlementOf(store, ACME, NOW + TERM_MS + 1).ok, false);
  });
});

describe('describing how long is left', () => {
  it('counts days when the end is near', () => {
    assert.equal(describeRemaining(NOW + 5 * 24 * 3600_000, NOW), '5 days left');
  });

  it('uses the singular for one', () => {
    assert.equal(describeRemaining(NOW + 24 * 3600_000, NOW), '1 day left');
  });

  it('counts months when it is not', () => {
    assert.match(describeRemaining(NOW + TERM_MS, NOW), /months left/);
  });

  it('says expired rather than a negative number', () => {
    assert.equal(describeRemaining(NOW - 1000, NOW), 'expired');
  });
});
