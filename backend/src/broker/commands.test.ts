import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from '../db/client.js';
import { TenantScopeError, type Principal } from '../db/tenancy.js';
import { queryAudit } from '../audit/service.js';
import { JBD_SP24S004, seedParameterDefinitions } from '../policy/seed.js';
import { closeSession, openSession } from '../session/bleSession.js';
import {
  BrokerError,
  COMMAND_TTL_MS,
  claimCommands,
  completeCommand,
  endSupportSession,
  expireStaleCommands,
  issueCommand,
  listCommands,
  startSupportSession,
} from './commands.js';
import { createTestStore, seedCompany } from '../db/testFixtures.js';

/**
 * Assisted remote control (Mode 1). The rule under test throughout is that a
 * command reaches a BMS only by being collected by a technician who is actually
 * on site — and that no flag, role or urgency changes it.
 */

let store: Store;

const ACME = 'company-acme';
const RIVAL = 'company-rival';
const BATTERY = 'bat-acme';
const RIVAL_BATTERY = 'bat-rival';

/** The company's administrators: inside the company, like everyone. */
const admin: Principal = { userId: 'u-admin', role: 'company', companyId: ACME };
const otherAdmin: Principal = { userId: 'u-admin-2', role: 'company', companyId: ACME };
const tech: Principal = { userId: 'u-tech', role: 'user', companyId: ACME };
const otherTech: Principal = { userId: 'u-tech-2', role: 'user', companyId: ACME };
const rivalTech: Principal = { userId: 'u-rival', role: 'user', companyId: RIVAL };

const REASON = 'Vendor bulletin 2026-114';

const onSite = async (who: Principal = tech, battery = BATTERY, company = ACME) =>
  await openSession(store, who, battery, company);

const openTicket = async (battery = BATTERY) => await startSupportSession(store, admin, battery);

const codeOf = async (fn: () => unknown): Promise<string | null> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof BrokerError ? e.code : `unexpected:${(e as Error).name}`;
  }
};

beforeEach(async () => {
  store = await createTestStore();
  await seedParameterDefinitions(store);
  const now = Date.now();

  for (const [id, name] of [
    [ACME, 'Acme EV'],
    [RIVAL, 'Rival Fleet'],
  ] as const) {
    await seedCompany(store, id, name, now);
  }
  for (const [id, company, serial] of [
    [BATTERY, ACME, 'BAT-ACME-1'],
    [RIVAL_BATTERY, RIVAL, 'BAT-RIVAL-1'],
  ] as const) {
    await store.run(
      `INSERT INTO batteries (id, company_id, serial, chemistry, cell_count, bms_model, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      id, company, serial, 'LiFePO4', 24, JBD_SP24S004, now
    );
  }
  for (const [id, company, role] of [
    ['u-admin', ACME, 'company'],
    ['u-admin-2', ACME, 'company'],
    ['u-tech', ACME, 'user'],
    ['u-tech-2', ACME, 'user'],
    ['u-rival', RIVAL, 'user'],
  ] as const) {
    await store.run(
      'INSERT INTO users (id, company_id, email, display_name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?)',
      id, company, `${id}@example.com`, id, role, 'x', now
    );
  }
});

afterEach(() => store.close());

describe('opening a support session', () => {
  it('is available to an administrator', async () => {
    assert.ok(await openTicket());
  });

  it('is refused to a technician', async () => {
    assert.equal(await codeOf(async () => await startSupportSession(store, tech, BATTERY)), 'forbidden');
  });

  /** The role gate fires before the tenancy gate, so a technician never reaches it. */
  it('refuses a technician whichever battery they name', async () => {
    assert.equal(await codeOf(async () => await startSupportSession(store, tech, RIVAL_BATTERY)), 'forbidden');
    assert.equal(await codeOf(async () => await startSupportSession(store, tech, BATTERY)), 'forbidden');
  });

  it('refuses a battery that does not exist', async () => {
    await assert.rejects(async () => await startSupportSession(store, admin, 'bat-nowhere'), TenantScopeError);
  });

  /** Nobody is platform-wide: another company's pack is simply not there. */
  it('refuses even an administrator another company’s battery', async () => {
    await assert.rejects(async () => await startSupportSession(store, admin, RIVAL_BATTERY), TenantScopeError);
  });
});

describe('issuing a command', () => {
  it('is deliverable when a technician is on site', async () => {
    await onSite();
    const result = await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8, { reason: REASON });
    assert.equal(result.disposition, 'deliverable');
  });

  /** Nobody on site is not a failure — it is a queue. */
  it('queues when nobody is on site', async () => {
    const result = await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8, { reason: REASON });
    assert.equal(result.disposition, 'queued');
  });

  it('records the issuing itself in the audit trail', async () => {
    const before = (await queryAudit(store, admin)).length;
    await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8, { reason: REASON });
    assert.equal((await queryAudit(store, admin)).length, before + 1);
  });

  it('tags the audit row with the support session', async () => {
    const sessionId = await openTicket();
    await issueCommand(store, admin, sessionId, 'cell_ovp', 3.8, { reason: REASON });
    assert.equal((await queryAudit(store, admin))[0]?.support_session_id, sessionId);
  });

  it('refuses a command outside any support session', async () => {
    assert.equal(
      await codeOf(async () => await issueCommand(store, admin, 'no-such-session', 'cell_ovp', 3.8, { reason: REASON })),
      'not_found'
    );
  });

  it('refuses a command on a session that has ended', async () => {
    const sessionId = await openTicket();
    await endSupportSession(store, admin, sessionId, 'resolved');
    assert.equal(
      await codeOf(async () => await issueCommand(store, admin, sessionId, 'cell_ovp', 3.8, { reason: REASON })),
      'session_closed'
    );
  });

  it('hides another administrator’s session', async () => {
    const sessionId = await openTicket();
    assert.equal(
      await codeOf(async () => await issueCommand(store, otherAdmin, sessionId, 'cell_ovp', 3.8, { reason: REASON })),
      'not_found'
    );
  });

  /* --- policy still applies, and a refusal is still audited --- */

  it('refuses an out-of-range value', async () => {
    assert.equal(
      await codeOf(async () => await issueCommand(store, admin, await openTicket(), 'cell_ovp', 4.2, { reason: REASON })),
      'policy_denied'
    );
  });

  it('refuses a critical change with no reason', async () => {
    assert.equal(
      await codeOf(async () => await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8)),
      'policy_denied'
    );
  });

  it('refuses a SKU-fixed parameter', async () => {
    assert.equal(
      await codeOf(async () => await issueCommand(store, admin, await openTicket(), 'charge_ocp', 220, { reason: REASON })),
      'policy_denied'
    );
  });

  it('audits a refused command rather than silently dropping it', async () => {
    const sessionId = await openTicket();
    try {
      await issueCommand(store, admin, sessionId, 'cell_ovp', 4.2, { reason: REASON });
    } catch {
      /* expected */
    }
    assert.equal((await queryAudit(store, admin))[0]?.result, 'rejected');
  });
});

/**
 * The heart of Mode 1: a queued command sits in the cloud until a technician
 * with a live link collects it. There is no other exit.
 */
describe('claiming commands', () => {
  it('returns nothing when nobody is on site', async () => {
    await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8, { reason: REASON });
    assert.deepEqual(await claimCommands(store, tech, BATTERY), []);
  });

  it('delivers to the technician who holds the live link', async () => {
    await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8, { reason: REASON });
    await onSite();
    const claimed = await claimCommands(store, tech, BATTERY);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.parameter_key, 'cell_ovp');
  });

  /** Someone else's session is not this caller's session. */
  it('refuses a caller who is not the one on site', async () => {
    await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8, { reason: REASON });
    await onSite(otherTech);
    assert.deepEqual(await claimCommands(store, tech, BATTERY), []);
  });

  it('stops delivering once the link drops', async () => {
    await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8, { reason: REASON });
    await onSite();
    await closeSession(store, tech, BATTERY);
    assert.deepEqual(await claimCommands(store, tech, BATTERY), []);
  });

  it('does not hand the same command out twice', async () => {
    await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8, { reason: REASON });
    await onSite();
    assert.equal((await claimCommands(store, tech, BATTERY)).length, 1);
    assert.equal((await claimCommands(store, tech, BATTERY)).length, 0);
  });

  it('refuses to hand over another tenant’s commands', async () => {
    await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8, { reason: REASON });
    await assert.rejects(async () => await claimCommands(store, rivalTech, BATTERY), TenantScopeError);
  });
});

/** Force Push overrides queue order and soft-holds — nothing else. */
describe('force push', () => {
  it('jumps ahead of commands queued earlier', async () => {
    const sessionId = await openTicket();
    await issueCommand(store, admin, sessionId, 'balance_start_v', 3.4, { reason: REASON });
    await issueCommand(store, admin, sessionId, 'cell_ovp', 3.8, { reason: REASON, forcePush: true });
    await onSite();
    const claimed = await claimCommands(store, tech, BATTERY);
    assert.equal(claimed[0]?.parameter_key, 'cell_ovp');
    assert.equal(claimed[0]?.force_push, 1);
  });

  /** The test that matters most in this file. */
  it('still cannot reach a battery with nobody on site', async () => {
    await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8, { reason: REASON, forcePush: true });
    assert.deepEqual(await claimCommands(store, tech, BATTERY), []);
  });

  it('queues rather than delivering when nobody is on site', async () => {
    const result = await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8, {
      reason: REASON,
      forcePush: true,
    });
    assert.equal(result.disposition, 'queued');
  });

  it('is attributed distinctly in the audit trail', async () => {
    await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8, { reason: REASON, forcePush: true });
    assert.equal((await queryAudit(store, admin))[0]?.source, 'admin_force_push');
  });
});

/**
 * A command issued during a call must not fire hours later, after the
 * conversation that justified it has ended.
 */
describe('ending a support session', () => {
  it('cancels everything it queued', async () => {
    const sessionId = await openTicket();
    await issueCommand(store, admin, sessionId, 'cell_ovp', 3.8, { reason: REASON });
    await issueCommand(store, admin, sessionId, 'balance_start_v', 3.4, { reason: REASON });

    const cancelled = await endSupportSession(store, admin, sessionId, 'resolved');
    assert.equal(cancelled, 2);

    await onSite();
    assert.deepEqual(await claimCommands(store, tech, BATTERY), []);
  });

  it('leaves another session’s queue alone', async () => {
    const first = await openTicket();
    const second = await openTicket();
    await issueCommand(store, admin, first, 'cell_ovp', 3.8, { reason: REASON });
    await issueCommand(store, admin, second, 'balance_start_v', 3.4, { reason: REASON });

    await endSupportSession(store, admin, first, 'resolved');
    await onSite();
    const claimed = await claimCommands(store, tech, BATTERY);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.parameter_key, 'balance_start_v');
  });

  it('records the outcome', async () => {
    const sessionId = await openTicket();
    await endSupportSession(store, admin, sessionId, 'no fault found');
    const row = await store.get<{ outcome: string; ended_at: number }>(
      'SELECT outcome, ended_at FROM support_sessions WHERE id = ?',
      sessionId
    );
    assert.equal(row?.outcome, 'no fault found');
    assert.ok(row?.ended_at);
  });

  it('hides another administrator’s session', async () => {
    const sessionId = await openTicket();
    assert.equal(await codeOf(async () => await endSupportSession(store, otherAdmin, sessionId, 'x')), 'not_found');
  });
});

/** A queued command nobody collects is a command nobody is expecting. */
describe('expiry', () => {
  it('expires a command left uncollected', async () => {
    const start = Date.now();
    await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8, { reason: REASON }, {}, start);
    await expireStaleCommands(store, start + COMMAND_TTL_MS + 1);
    assert.equal((await listCommands(store, admin))[0]?.state, 'expired');
  });

  it('leaves a fresh command alone', async () => {
    const start = Date.now();
    await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8, { reason: REASON }, {}, start);
    await expireStaleCommands(store, start + COMMAND_TTL_MS - 1);
    assert.equal((await listCommands(store, admin))[0]?.state, 'queued');
  });

  it('does not deliver an expired command', async () => {
    const start = Date.now();
    await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8, { reason: REASON }, {}, start);
    await onSite();
    assert.deepEqual(await claimCommands(store, tech, BATTERY, start + COMMAND_TTL_MS + 1), []);
  });
});

describe('reporting the outcome', () => {
  const claimOne = async () => {
    await issueCommand(store, admin, await openTicket(), 'cell_ovp', 3.8, { reason: REASON });
    await onSite();
    return (await claimCommands(store, tech, BATTERY))[0]!;
  };

  it('marks the command completed', async () => {
    const command = await claimOne();
    await completeCommand(store, tech, command.id, 'success');
    assert.equal((await listCommands(store, tech))[0]?.state, 'completed');
  });

  it('writes an audit row attributed to the issuing administrator', async () => {
    const command = await claimOne();
    await completeCommand(store, tech, command.id, 'success');
    const entry = (await queryAudit(store, admin))[0];
    assert.equal(entry?.actor_user_id, 'u-admin');
    assert.equal(entry?.actor_role, 'company');
    assert.equal(entry?.result, 'success');
  });

  /** An unknown outcome stays unknown here too. */
  it('records an indeterminate result honestly', async () => {
    const command = await claimOne();
    await completeCommand(store, tech, command.id, 'indeterminate', 'link dropped');
    assert.equal((await queryAudit(store, admin))[0]?.result, 'indeterminate');
  });

  it('refuses a command belonging to another tenant', async () => {
    const command = await claimOne();
    await assert.rejects(async () => await completeCommand(store, rivalTech, command.id, 'success'), TenantScopeError);
  });
});
