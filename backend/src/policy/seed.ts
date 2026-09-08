import { randomUUID } from 'node:crypto';
import type { Store } from '../db/client.js';
import type { ParameterDefinition } from './engine.js';

/**
 * Vendor datasheet values for the JBD SP24S004 (24S, 200 A SKU), from PRD §7.5.
 *
 * These are seeds, not placeholders — the over-current table in particular is
 * fixed by the board's continuous-current rating, which is a hardware SKU
 * choice rather than a runtime setting.
 *
 * NOTE: the mobile app currently ships its own copy of this profile in
 * src/bms/jbd-sp24s004.json. That duplication is deliberate only while the app
 * has no backend to ask. Phase 00's API contract should make this table the
 * single source of truth, with the app fetching a capability profile rather
 * than embedding one — two copies of a safety threshold is one too many.
 */

export const JBD_SP24S004 = 'JBD SP24S004';

type Seed = Omit<ParameterDefinition, 'supportedBms'>;

const p = (
  parameterKey: string,
  displayName: string,
  unit: string,
  minValue: number,
  maxValue: number,
  dangerLevel: ParameterDefinition['dangerLevel'],
  over: Partial<Seed> = {}
): Seed => ({
  parameterKey,
  displayName,
  unit,
  dataType: 'float',
  minValue,
  maxValue,
  dangerLevel,
  readable: true,
  writable: true,
  requiresConfirmation: true,
  requiresAdmin: false,
  ...over,
});

const int = { dataType: 'integer' as const };
/** Fixed by the board's 200 A continuous rating — informational, never writable. */
const skuFixed = { ...int, writable: false, requiresAdmin: true };

export const JBD_SEEDS: Seed[] = [
  // Voltage protection
  p('cell_ovp', 'Cell over-voltage', 'V', 3.7, 3.8, 'Critical'),
  p('cell_ovp_delay', 'Cell over-voltage delay', 'ms', 1000, 3000, 'Warning', int),
  p('cell_ovp_release', 'Cell over-voltage release', 'V', 3.55, 3.65, 'Normal'),
  p('cell_uvp', 'Cell under-voltage', 'V', 2.1, 2.3, 'Critical'),
  p('cell_uvp_delay', 'Cell under-voltage delay', 'ms', 1000, 3000, 'Warning', int),
  p('cell_uvp_release', 'Cell under-voltage release', 'V', 2.5, 2.7, 'Normal'),

  // Current protection — the table fixed by the SKU
  p('charge_ocp', 'Charge over-current', 'A', 215, 225, 'Critical', skuFixed),
  p('charge_ocp_delay', 'Charge over-current delay', 's', 5, 15, 'Warning', int),
  p('discharge_ocp_1', '1st-stage discharge OCP', 'A', 215, 225, 'Critical', skuFixed),
  p('discharge_ocp_1_delay', '1st-stage discharge delay', 's', 5, 15, 'Warning', int),
  p('discharge_ocp_2', '2nd-stage discharge OCP', 'A', 550, 650, 'Critical', skuFixed),
  p('discharge_ocp_2_delay', '2nd-stage discharge delay', 'ms', 32, 500, 'Warning', int),
  p('short_circuit', 'Short-circuit protection', 'A', 2000, 2800, 'Critical', skuFixed),
  p('short_circuit_delay', 'Short-circuit delay', 'µs', 62, 1000, 'Warning', {
    ...int,
    requiresAdmin: true,
  }),

  // Temperature
  p('charge_htp', 'Charge high-temp protection', '°C', 62, 68, 'Warning', int),
  p('charge_htp_release', 'Charge high-temp release', '°C', 52, 58, 'Normal', int),
  p('charge_ltp', 'Charge low-temp protection', '°C', -13, -7, 'Warning', int),
  p('charge_ltp_release', 'Charge low-temp release', '°C', -8, -2, 'Normal', int),
  p('discharge_htp', 'Discharge high-temp protection', '°C', 72, 78, 'Warning', int),
  p('discharge_htp_release', 'Discharge high-temp release', '°C', 62, 68, 'Normal', int),
  p('discharge_ltp', 'Discharge low-temp protection', '°C', -23, -17, 'Warning', int),
  p('discharge_ltp_release', 'Discharge low-temp release', '°C', -13, -7, 'Normal', int),
  p('fet_htp', 'FET high-temp protection', '°C', 85, 95, 'Warning', int),
  p('fet_htp_release', 'FET high-temp release', '°C', 65, 75, 'Normal', int),

  // Balancing
  p('balance_start_v', 'Balance turn-on voltage', 'V', 3.37, 3.43, 'Normal'),
  p('balance_delta_mv', 'Balance opening delta', 'mV', 5, 50, 'Normal', int),
  p('balance_current_ma', 'Balance current', 'mA', 20, 110, 'Normal', {
    ...int,
    writable: false,
  }),

  // System
  p('cell_count', 'Series cell count', 'S', 8, 24, 'Critical', {
    ...int,
    writable: false,
    requiresAdmin: true,
  }),
  p('capacity_ah', 'Nominal capacity', 'Ah', 10, 500, 'Warning', {
    ...int,
    requiresAdmin: true,
  }),
];

export function seedParameterDefinitions(store: Store, bms = JBD_SP24S004): number {
  const insert = (s: Seed) =>
    store.run(
      `INSERT OR IGNORE INTO parameter_definitions
       (id, parameter_key, display_name, unit, data_type, min_value, max_value,
        danger_level, supported_bms, readable, writable, requires_confirmation, requires_admin)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      randomUUID(),
      s.parameterKey,
      s.displayName,
      s.unit,
      s.dataType,
      s.minValue,
      s.maxValue,
      s.dangerLevel,
      bms,
      s.readable ? 1 : 0,
      s.writable ? 1 : 0,
      s.requiresConfirmation ? 1 : 0,
      s.requiresAdmin ? 1 : 0
    );

  store.transaction(() => JBD_SEEDS.forEach(insert));
  return JBD_SEEDS.length;
}

interface DefinitionRow {
  parameter_key: string;
  display_name: string;
  unit: string;
  data_type: ParameterDefinition['dataType'];
  min_value: number;
  max_value: number;
  danger_level: ParameterDefinition['dangerLevel'];
  supported_bms: string;
  readable: number;
  writable: number;
  requires_confirmation: number;
  requires_admin: number;
}

const toDefinition = (r: DefinitionRow): ParameterDefinition => ({
  parameterKey: r.parameter_key,
  displayName: r.display_name,
  unit: r.unit,
  dataType: r.data_type,
  minValue: r.min_value,
  maxValue: r.max_value,
  dangerLevel: r.danger_level,
  supportedBms: r.supported_bms,
  readable: !!r.readable,
  writable: !!r.writable,
  requiresConfirmation: !!r.requires_confirmation,
  requiresAdmin: !!r.requires_admin,
});

export function findDefinition(
  store: Store,
  parameterKey: string,
  bmsModel: string
): ParameterDefinition | undefined {
  const row = store.get<DefinitionRow>(
    'SELECT * FROM parameter_definitions WHERE parameter_key = ? AND supported_bms = ?',
    parameterKey,
    bmsModel
  );
  return row ? toDefinition(row) : undefined;
}

/** The capability profile a client renders its controls from. */
export function capabilityProfile(store: Store, bmsModel: string): ParameterDefinition[] {
  return store
    .all<DefinitionRow>(
      'SELECT * FROM parameter_definitions WHERE supported_bms = ? ORDER BY parameter_key',
      bmsModel
    )
    .map(toDefinition);
}
