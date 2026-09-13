import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JBD_SP24S004, capabilityProfile, seedParameterDefinitions } from './seed.js';
import { createTestStore } from '../db/testFixtures.js';

/**
 * The mobile app ships its own copy of this profile so Settings renders with no
 * network. Two hand-written copies of one datasheet is exactly the arrangement
 * that drifts, and it did: the first time these were compared they disagreed on
 * twelve fields, including a confirmation requirement.
 *
 * The server remains authoritative at runtime — the app reconciles against it
 * and the server's bounds win. This test exists so a disagreement is found in
 * CI rather than by a technician standing in front of a pack.
 *
 * It skips when the app is not checked out beside the backend, so the backend
 * still tests standalone.
 */

const APP_PROFILE = fileURLToPath(
  new URL('../../../mobile/src/bms/jbd-sp24s004.json', import.meta.url)
);

interface AppParameter {
  parameter_key: string;
  unit: string;
  data_type: string;
  min: number;
  max: number;
  danger_level: string;
  writable: boolean;
  readable: boolean;
  requires_confirmation: boolean;
  requires_admin: boolean;
}

const appParameters = (): AppParameter[] =>
  (JSON.parse(readFileSync(APP_PROFILE, 'utf8')) as { parameters: AppParameter[] }).parameters;

const serverParameters = async () => {
  const store = await createTestStore();
  try {
    await seedParameterDefinitions(store);
    return await capabilityProfile(store, JBD_SP24S004);
  } finally {
    store.close();
  }
};

describe('the app profile and the backend seed describe the same BMS', { skip: !existsSync(APP_PROFILE) }, () => {
  it('defines exactly the same parameter keys', async () => {
    const app = new Set(appParameters().map((p) => p.parameter_key));
    const server = new Set((await serverParameters()).map((d) => d.parameterKey));
    assert.deepEqual(
      [...app].filter((k) => !server.has(k)),
      [],
      'parameters the app offers that the server will always refuse'
    );
    assert.deepEqual(
      [...server].filter((k) => !app.has(k)),
      [],
      'parameters the server defines that the app cannot show'
    );
  });

  it('agrees on every field that decides what a technician may do', async () => {
    const server = new Map((await serverParameters()).map((d) => [d.parameterKey, d]));
    const disagreements: string[] = [];

    for (const p of appParameters()) {
      const s = server.get(p.parameter_key);
      if (!s) continue;

      const compare = (field: string, app: unknown, srv: unknown) => {
        if (app !== srv) {
          disagreements.push(`${p.parameter_key}.${field}: app=${String(app)} server=${String(srv)}`);
        }
      };

      compare('min', p.min, s.minValue);
      compare('max', p.max, s.maxValue);
      compare('unit', p.unit, s.unit);
      compare('dataType', p.data_type, s.dataType);
      compare('dangerLevel', p.danger_level, s.dangerLevel);
      compare('readable', p.readable, s.readable);
      compare('writable', p.writable, s.writable);
      compare('requiresConfirmation', p.requires_confirmation, s.requiresConfirmation);
      compare('requiresAdmin', p.requires_admin, s.requiresAdmin);
    }

    assert.deepEqual(disagreements, []);
  });
});
