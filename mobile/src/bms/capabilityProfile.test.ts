import {
  GROUP_ORDER,
  GROUP_TITLES,
  axes,
  formatParameter,
  parameterFor,
  parametersIn,
  profile,
  type CapabilityProfile,
} from './capabilityProfile';
import { ticks } from '../gauge/polar';

describe('axis derivation', () => {
  it('derives pack current from the board rating, not a literal', () => {
    const a = axes();
    expect(a.packCurrent.min).toBe(-2 * profile.continuousCurrentA);
    expect(a.packCurrent.max).toBe(2 * profile.continuousCurrentA);
  });

  it('derives pack voltage from cell count and the protection thresholds', () => {
    const a = axes();
    const uvpRelease = parameterFor('cell_uvp_release')!.value;
    const ovp = parameterFor('cell_ovp')!.value;
    expect(a.packVoltage.min).toBe(Math.floor(profile.cellCount * uvpRelease));
    expect(a.packVoltage.max).toBe(Math.ceil(profile.cellCount * ovp));
  });

  it('keeps the pack-voltage tick ladder landing exactly on the arc end', () => {
    const a = axes();
    const t = ticks(a.packVoltage.min, a.packVoltage.max, a.packVoltage.major);
    expect(t[t.length - 1]).toBe(a.packVoltage.max);
  });

  it('keeps the pack-current ladder symmetric and through zero', () => {
    const a = axes();
    const t = ticks(a.packCurrent.min, a.packCurrent.max, a.packCurrent.major);
    expect(t).toContain(0);
    expect(t[t.length - 1]).toBe(a.packCurrent.max);
  });

  /**
   * The reference mock shows a 400 V Tesla pack on a 0–450 V axis. Copying that
   * would pin a 24S LiFePO4 needle at the far left forever, making the gauge
   * decorative — the exact failure the safety rule exists to prevent.
   */
  it('puts a resting 24S pack near mid-scale, not pinned at an end', () => {
    const a = axes();
    const resting = profile.cellCount * 3.3;
    const t = (resting - a.packVoltage.min) / (a.packVoltage.max - a.packVoltage.min);
    expect(t).toBeGreaterThan(0.2);
    expect(t).toBeLessThan(0.8);
  });

  it('rederives cleanly for a different pack', () => {
    const sixteenS: CapabilityProfile = {
      ...profile,
      cellCount: 16,
      continuousCurrentA: 100,
    };
    const a = axes(sixteenS);
    expect(a.packCurrent.max).toBe(200);
    expect(a.packVoltage.min).toBe(Math.floor(16 * 2.6));
    expect(a.packVoltage.max).toBe(Math.ceil(16 * 3.75));
  });
});

describe('profile integrity', () => {
  it('orders every parameter min <= typ <= max', () => {
    for (const p of profile.parameters) {
      expect(p.min).toBeLessThanOrEqual(p.typ);
      expect(p.typ).toBeLessThanOrEqual(p.max);
    }
  });

  it('seeds every current value inside its own supported range', () => {
    for (const p of profile.parameters) {
      expect(p.value).toBeGreaterThanOrEqual(p.min);
      expect(p.value).toBeLessThanOrEqual(p.max);
    }
  });

  it('uses unique parameter keys', () => {
    const keys = profile.parameters.map((p) => p.parameter_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /** Settings renders GROUP_ORDER only — an unlisted group would silently vanish. */
  it('renders every group present in the profile', () => {
    const groups = new Set(profile.parameters.map((p) => p.group));
    for (const g of groups) {
      expect(GROUP_ORDER).toContain(g);
      expect(GROUP_TITLES[g]).toBeTruthy();
    }
    expect(parametersIn('voltage').length + parametersIn('current').length).toBeGreaterThan(0);
    expect(GROUP_ORDER.flatMap((g) => parametersIn(g))).toHaveLength(profile.parameters.length);
  });

  /** A dead disabled row reads as a bug; a stated reason reads as a fact. */
  it('explains every non-writable parameter', () => {
    for (const p of profile.parameters.filter((x) => !x.writable)) {
      expect(p.fixed_reason).toBeTruthy();
    }
  });

  it('requires confirmation on every critical parameter', () => {
    for (const p of profile.parameters.filter((x) => x.danger_level === 'Critical')) {
      expect(p.requires_confirmation).toBe(true);
    }
  });

  it('gives every writable parameter a usable step', () => {
    for (const p of profile.parameters.filter((x) => x.writable)) {
      expect(p.step).toBeGreaterThan(0);
      expect(p.step).toBeLessThanOrEqual(p.max - p.min);
    }
  });

  it('fixes the over-current table to the board rating', () => {
    for (const key of ['charge_ocp', 'discharge_ocp_1', 'discharge_ocp_2', 'short_circuit']) {
      expect(parameterFor(key)?.writable).toBe(false);
    }
  });
});

describe('formatParameter', () => {
  it('prefers the datasheet tolerance band at the seeded value', () => {
    const ocp = parameterFor('charge_ocp')!;
    expect(formatParameter(ocp)).toBe('220 ± 5 A');
  });

  it('formats a changed value numerically at the declared precision', () => {
    const ovp = parameterFor('cell_ovp')!;
    expect(formatParameter(ovp, 3.8)).toBe('3.800 V');
  });

  it('returns null for an unknown key rather than throwing', () => {
    expect(parameterFor('not_a_parameter')).toBeUndefined();
  });
});
