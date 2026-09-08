/**
 * BMS capability profile.
 *
 * Settings, BMS Information and the write flow are all generated from this.
 * There is no vendor branching anywhere in component code — supporting a second
 * BMS means shipping another profile JSON, not editing a screen.
 */
import raw from './jbd-sp24s004.json';
import type { DangerLevel } from '../theme/tokens';

export type ParameterGroup = 'voltage' | 'current' | 'temperature' | 'balancing' | 'system';

export interface BmsParameter {
  parameter_key: string;
  display_name: string;
  unit: string;
  data_type: 'integer' | 'float' | 'boolean' | 'enum';
  min: number;
  typ: number;
  max: number;
  value: number;
  /** Overrides the formatted value where the datasheet quotes a tolerance band. */
  display_value?: string;
  step: number;
  precision: number;
  danger_level: DangerLevel;
  group: ParameterGroup;
  readable: boolean;
  writable: boolean;
  /** Why a non-writable parameter is fixed — shown instead of a dead control. */
  fixed_reason?: string;
  requires_confirmation: boolean;
  requires_admin: boolean;
}

export interface CapabilityProfile {
  bmsModel: string;
  vendor: string;
  firmware: string;
  protocol: string;
  chemistry: string;
  cellCount: number;
  capacityAh: number;
  continuousCurrentA: number;
  parameters: BmsParameter[];
}

export const profile = raw as CapabilityProfile;

export const GROUP_TITLES: Record<ParameterGroup, string> = {
  voltage: 'Voltage Protection',
  current: 'Current Protection',
  temperature: 'Temperature',
  balancing: 'Balancing',
  system: 'System / BMS',
};

/** Render order for the Settings screen. */
export const GROUP_ORDER: ParameterGroup[] = [
  'voltage',
  'current',
  'temperature',
  'balancing',
  'system',
];

export function parametersIn(group: ParameterGroup, p: CapabilityProfile = profile) {
  return p.parameters.filter((x) => x.group === group);
}

export function parameterFor(key: string, p: CapabilityProfile = profile) {
  return p.parameters.find((x) => x.parameter_key === key);
}

export function formatParameter(param: BmsParameter, value = param.value): string {
  if (param.display_value && value === param.value) return param.display_value;
  return `${value.toFixed(param.precision)} ${param.unit}`;
}

/**
 * Gauge axes derive from the profile — never from literals.
 *
 * The reference mock shows a 400 V Tesla pack on a 0–450 V axis. A 24S LiFePO4
 * pack on that scale would pin the needle at the far left permanently, which
 * makes the instrument decorative. Composition is copied from the mock; scale
 * is copied from the hardware.
 */
export function axes(p: CapabilityProfile = profile) {
  const uvpRelease = parameterFor('cell_uvp_release', p)?.value ?? 2.6;
  const ovp = parameterFor('cell_ovp', p)?.value ?? 3.75;

  return {
    soc: { min: 0, max: 100, major: 10, minor: 2, dangerZone: [0, 15] as [number, number] },
    packCurrent: {
      min: -2 * p.continuousCurrentA,
      max: 2 * p.continuousCurrentA,
      major: p.continuousCurrentA / 2,
    },
    // Rounded to whole volts so the tick ladder divides evenly and the last
    // tick lands exactly on the arc end. 24S → 62…90 V in steps of 4.
    packVoltage: {
      min: Math.floor(p.cellCount * uvpRelease),
      max: Math.ceil(p.cellCount * ovp),
      major: 4,
    },
    temperature: { min: -20, max: 90, major: 10, warnAt: 75, criticalAt: 90 },
  };
}
