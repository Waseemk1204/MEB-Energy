import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateRead,
  evaluateWrite,
  type CompanyPolicy,
  type Decision,
  type ParameterDefinition,
  type WriteRequest,
} from './engine.js';
import type { Principal } from '../db/tenancy.js';

const ACME = 'company-acme';
const RIVAL = 'company-rival';
const BMS = 'JBD SP24S004';

const user: Principal = { userId: 'u1', role: 'user', companyId: ACME };
const company: Principal = { userId: 'c1', role: 'company', companyId: ACME };
const admin: Principal = { userId: 'a1', role: 'admin', companyId: null };

const definition = (over: Partial<ParameterDefinition> = {}): ParameterDefinition => ({
  parameterKey: 'cell_ovp',
  displayName: 'Cell over-voltage',
  unit: 'V',
  dataType: 'float',
  minValue: 3.7,
  maxValue: 3.8,
  dangerLevel: 'Critical',
  supportedBms: BMS,
  readable: true,
  writable: true,
  requiresConfirmation: true,
  requiresAdmin: false,
  ...over,
});

const request = (over: Partial<WriteRequest> = {}): WriteRequest => ({
  parameterKey: 'cell_ovp',
  value: 3.75,
  bmsModel: BMS,
  targetCompanyId: ACME,
  reason: 'Vendor bulletin 2026-114',
  bleSessionActive: true,
  ...over,
});

const denied = (d: Decision) => (d.allowed ? null : d.code);

describe('validation', () => {
  it('allows a well-formed write', () => {
    assert.equal(evaluateWrite(user, definition(), request()).allowed, true);
  });

  it('rejects an unknown parameter', () => {
    assert.equal(denied(evaluateWrite(user, undefined, request())), 'unknown_parameter');
  });

  it('rejects a parameter the hardware fixes', () => {
    assert.equal(
      denied(evaluateWrite(user, definition({ writable: false }), request())),
      'not_writable'
    );
  });

  /** A definition for another BMS says nothing about the one attached. */
  it('rejects a definition that belongs to a different BMS', () => {
    assert.equal(
      denied(evaluateWrite(user, definition(), request({ bmsModel: 'JK BD6A20S' }))),
      'bms_mismatch'
    );
  });

  it('rejects a value above the range', () => {
    assert.equal(denied(evaluateWrite(user, definition(), request({ value: 4.2 }))), 'out_of_range');
  });

  it('rejects a value below the range', () => {
    assert.equal(denied(evaluateWrite(user, definition(), request({ value: 3.0 }))), 'out_of_range');
  });

  it('accepts the exact bounds', () => {
    assert.equal(evaluateWrite(user, definition(), request({ value: 3.7 })).allowed, true);
    assert.equal(evaluateWrite(user, definition(), request({ value: 3.8 })).allowed, true);
  });

  it('rejects a fractional value for an integer parameter', () => {
    const d = definition({ dataType: 'integer', minValue: 0, maxValue: 100, dangerLevel: 'Normal' });
    assert.equal(denied(evaluateWrite(user, d, request({ value: 10.5 }))), 'wrong_type');
  });

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    it(`rejects ${bad} as a value`, () => {
      assert.equal(denied(evaluateWrite(user, definition(), request({ value: bad }))), 'wrong_type');
    });
  }
});

describe('roles', () => {
  it('refuses an admin-only parameter to a field user', () => {
    assert.equal(
      denied(evaluateWrite(user, definition({ requiresAdmin: true }), request())),
      'requires_admin'
    );
  });

  it('refuses it to a company principal too', () => {
    assert.equal(
      denied(evaluateWrite(company, definition({ requiresAdmin: true }), request())),
      'requires_admin'
    );
  });

  it('allows it to an admin', () => {
    assert.equal(
      evaluateWrite(admin, definition({ requiresAdmin: true }), request()).allowed,
      true
    );
  });
});

describe('tenancy', () => {
  it('refuses a write to another company’s battery', () => {
    assert.equal(
      denied(evaluateWrite(user, definition(), request({ targetCompanyId: RIVAL }))),
      'wrong_tenant'
    );
  });

  /** Existence is not confirmed to a caller who does not own the resource. */
  it('says "not found" rather than "not yours"', () => {
    const d = evaluateWrite(user, definition(), request({ targetCompanyId: RIVAL }));
    assert.equal(d.allowed, false);
    assert.match((d as { message: string }).message, /not found/);
  });

  it('lets an admin write across tenants', () => {
    assert.equal(
      evaluateWrite(admin, definition(), request({ targetCompanyId: RIVAL })).allowed,
      true
    );
  });
});

/**
 * The app asks for a reason on Critical changes. That gate is UI, and UI is
 * never the boundary — so the server asks again.
 */
describe('reason for critical changes', () => {
  it('refuses a critical write with no reason', () => {
    assert.equal(
      denied(evaluateWrite(user, definition(), request({ reason: undefined }))),
      'reason_required'
    );
  });

  it('refuses a reason that is only whitespace', () => {
    assert.equal(
      denied(evaluateWrite(user, definition(), request({ reason: '   ' }))),
      'reason_required'
    );
  });

  it('does not require one for a Warning parameter', () => {
    const d = definition({ dangerLevel: 'Warning' });
    assert.equal(evaluateWrite(user, d, request({ reason: undefined })).allowed, true);
  });

  it('does not require one for a Normal parameter', () => {
    const d = definition({ dangerLevel: 'Normal' });
    assert.equal(evaluateWrite(user, d, request({ reason: undefined })).allowed, true);
  });
});

/**
 * Mode 1 (PRD §7.3): no command reaches a BMS without the user's BLE session
 * being live. This constraint is architectural and must not be weakened.
 */
describe('the active-session requirement', () => {
  it('refuses a local write with no live session', () => {
    assert.equal(
      denied(evaluateWrite(user, definition(), request({ bleSessionActive: false }))),
      'no_active_session'
    );
  });

  it('refuses an admin remote write with no live session', () => {
    assert.equal(
      denied(evaluateWrite(admin, definition(), request({ bleSessionActive: false }))),
      'session_required_for_admin_write'
    );
  });

  /** The single most important test in this file. */
  it('refuses a Force Push with no live session', () => {
    const d = evaluateWrite(
      admin,
      definition(),
      request({ bleSessionActive: false, forcePush: true })
    );
    assert.equal(d.allowed, false);
    assert.equal(denied(d), 'session_required_for_admin_write');
    assert.match((d as { message: string }).message, /Force Push does not bypass/);
  });

  it('allows a Force Push while a session is live', () => {
    const d = evaluateWrite(admin, definition(), request({ forcePush: true }));
    assert.equal(d.allowed, true);
  });
});

describe('write source attribution', () => {
  it('tags a field user’s write as local', () => {
    const d = evaluateWrite(user, definition(), request());
    assert.equal(d.allowed && d.source, 'local');
  });

  it('tags a company principal’s write as local', () => {
    const d = evaluateWrite(company, definition(), request());
    assert.equal(d.allowed && d.source, 'local');
  });

  it('tags an admin write as admin_remote', () => {
    const d = evaluateWrite(admin, definition(), request());
    assert.equal(d.allowed && d.source, 'admin_remote');
  });

  it('tags a forced admin write distinctly', () => {
    const d = evaluateWrite(admin, definition(), request({ forcePush: true }));
    assert.equal(d.allowed && d.source, 'admin_force_push');
  });

  /** A field user cannot promote their own write by asking for it. */
  it('ignores forcePush from a non-admin', () => {
    const d = evaluateWrite(user, definition(), request({ forcePush: true }));
    assert.equal(d.allowed && d.source, 'local');
  });
});

describe('company policy overlays', () => {
  const policy: CompanyPolicy = { deniedForRole: { user: ['cell_ovp'] } };

  it('can restrict a parameter for a role', () => {
    assert.equal(denied(evaluateWrite(user, definition(), request(), policy)), 'company_policy');
  });

  it('leaves other roles unaffected', () => {
    assert.equal(evaluateWrite(company, definition(), request(), policy).allowed, true);
  });

  /** Overlays may narrow permissions, never widen them. */
  it('cannot re-enable a parameter the hardware fixes', () => {
    const d = evaluateWrite(user, definition({ writable: false }), request(), {
      deniedForRole: {},
    });
    assert.equal(denied(d), 'not_writable');
  });

  it('cannot grant an admin-only parameter to a user', () => {
    const d = evaluateWrite(user, definition({ requiresAdmin: true }), request(), {
      deniedForRole: {},
    });
    assert.equal(denied(d), 'requires_admin');
  });
});

describe('reads', () => {
  it('allows a read of a readable parameter', () => {
    assert.equal(evaluateRead(user, definition(), ACME).allowed, true);
  });

  it('refuses a read across tenants', () => {
    assert.equal(denied(evaluateRead(user, definition(), RIVAL)), 'wrong_tenant');
  });

  it('allows an admin to read across tenants', () => {
    assert.equal(evaluateRead(admin, definition(), RIVAL).allowed, true);
  });

  it('refuses an unknown parameter', () => {
    assert.equal(denied(evaluateRead(user, undefined, ACME)), 'unknown_parameter');
  });
});
