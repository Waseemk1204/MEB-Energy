import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, type Store } from '../db/client.js';
import type { Principal } from '../db/tenancy.js';
import {
  SESSION_STALE_MS,
  activeSessionFor,
  closeSession,
  heartbeat,
  isSessionActive,
  openSession,
  reapStaleSessions,
} from './bleSession.js';
import { seedCompany } from '../db/testFixtures.js';

/**
 * Mode 1 (PRD §7.3) only means something if presence is a fact the server
 * establishes. These tests exist because the first version of the write route
 * took `bleSessionActive` from the request body — which let any caller assert
 * it, and let an administrator assert something about a technician's link that
 * their browser could not possibly know.
 */

let store: Store;

const ACME = 'company-acme';
const BATTERY = 'bat-acme';
const OTHER_BATTERY = 'bat-acme-2';

const tech: Principal = { userId: 'u-tech', role: 'user', companyId: ACME };
const otherTech: Principal = { userId: 'u-other', role: 'user', companyId: ACME };

beforeEach(() => {
  store = createStore();
  const now = Date.now();
  seedCompany(store, ACME, 'Acme', {}, now);
  for (const [id, serial] of [
    [BATTERY, 'BAT-1'],
    [OTHER_BATTERY, 'BAT-2'],
  ] as const) {
    store.run(
      'INSERT INTO batteries (id, company_id, serial, chemistry, cell_count, created_at) VALUES (?,?,?,?,?,?)',
      id, ACME, serial, 'LiFePO4', 24, now
    );
  }
  for (const p of [tech, otherTech]) {
    store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?)',
      p.userId, ACME, `${p.userId}@acme.example`, p.userId, 'user', 'x', now
    );
  }
});

afterEach(() => store.close());

describe('opening a session', () => {
  it('makes the battery reachable', () => {
    assert.equal(isSessionActive(store, BATTERY), false);
    openSession(store, tech, BATTERY, ACME);
    assert.equal(isSessionActive(store, BATTERY), true);
  });

  /** Reconnecting after a dropped link must not pile up sessions. */
  it('is idempotent for the same user and battery', () => {
    const first = openSession(store, tech, BATTERY, ACME);
    const second = openSession(store, tech, BATTERY, ACME);
    assert.equal(first, second);
    assert.equal(store.all('SELECT id FROM ble_sessions').length, 1);
  });

  it('does not make other batteries reachable', () => {
    openSession(store, tech, BATTERY, ACME);
    assert.equal(isSessionActive(store, OTHER_BATTERY), false);
  });
});

describe('heartbeats', () => {
  it('keeps a session alive past the timeout', () => {
    const start = Date.now();
    openSession(store, tech, BATTERY, ACME, null, start);
    assert.equal(isSessionActive(store, BATTERY, start + SESSION_STALE_MS + 1), false);

    heartbeat(store, tech, BATTERY, start + SESSION_STALE_MS - 1);
    assert.equal(isSessionActive(store, BATTERY, start + SESSION_STALE_MS + 1), true);
  });

  it('reports failure when there is no session to refresh', () => {
    assert.equal(heartbeat(store, tech, BATTERY), false);
  });

  it('will not revive a closed session', () => {
    openSession(store, tech, BATTERY, ACME);
    closeSession(store, tech, BATTERY);
    assert.equal(heartbeat(store, tech, BATTERY), false);
    assert.equal(isSessionActive(store, BATTERY), false);
  });
});

/**
 * A phone that walks out of range stops sending heartbeats without telling
 * anyone. Silence has to mean gone, or a dead link stays writable.
 */
describe('a link that goes quiet', () => {
  it('is treated as gone once heartbeats stop', () => {
    const start = Date.now();
    openSession(store, tech, BATTERY, ACME, null, start);
    assert.equal(isSessionActive(store, BATTERY, start + SESSION_STALE_MS - 1), true);
    assert.equal(isSessionActive(store, BATTERY, start + SESSION_STALE_MS), false);
  });

  it('is reaped so it stops being listed as open', () => {
    const start = Date.now();
    openSession(store, tech, BATTERY, ACME, null, start);
    reapStaleSessions(store, start + SESSION_STALE_MS + 1);
    const row = store.get<{ ended_at: number | null }>('SELECT ended_at FROM ble_sessions');
    assert.ok(row?.ended_at);
  });
});

describe('closing', () => {
  it('ends the session immediately', () => {
    openSession(store, tech, BATTERY, ACME);
    closeSession(store, tech, BATTERY);
    assert.equal(isSessionActive(store, BATTERY), false);
  });

  it('closes only the caller’s own session', () => {
    openSession(store, tech, BATTERY, ACME);
    openSession(store, otherTech, BATTERY, ACME);
    closeSession(store, tech, BATTERY);
    // Someone is still on site, so the battery stays reachable.
    assert.equal(isSessionActive(store, BATTERY), true);
    assert.equal(activeSessionFor(store, BATTERY)?.userId, otherTech.userId);
  });
});

/**
 * The question is "is anyone on site", not "does the caller have a session".
 * An administrator writing remotely never holds one, and their command rides
 * the technician's link.
 */
describe('what the policy engine asks', () => {
  it('reports whoever is present, not who is asking', () => {
    openSession(store, otherTech, BATTERY, ACME);
    const session = activeSessionFor(store, BATTERY);
    assert.equal(session?.userId, otherTech.userId);
  });

  it('prefers the most recent heartbeat when two are on site', () => {
    const start = Date.now();
    openSession(store, tech, BATTERY, ACME, null, start);
    openSession(store, otherTech, BATTERY, ACME, null, start);
    heartbeat(store, otherTech, BATTERY, start + 100);
    assert.equal(activeSessionFor(store, BATTERY, start + 200)?.userId, otherTech.userId);
  });

  it('returns null when nobody is present', () => {
    assert.equal(activeSessionFor(store, BATTERY), null);
  });
});

describe('the timeout itself', () => {
  it('is short enough that a dead link cannot stay writable for long', () => {
    assert.ok(SESSION_STALE_MS <= 60_000);
  });

  it('is long enough to survive a missed heartbeat', () => {
    assert.ok(SESSION_STALE_MS >= 10_000);
  });
});
