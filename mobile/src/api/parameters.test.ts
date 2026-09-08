import { profile } from '../bms/capabilityProfile';
import { describeDrift, reconcile, type ServerDefinition } from './parameters';

const def = (over: Partial<ServerDefinition> = {}): ServerDefinition => ({
  parameterKey: 'cell_ovp',
  displayName: 'Cell over-voltage',
  unit: 'V',
  dataType: 'float',
  minValue: 3.5,
  maxValue: 3.9,
  dangerLevel: 'Critical',
  supportedBms: 'JBD-SP24S004',
  readable: true,
  writable: true,
  requiresConfirmation: true,
  requiresAdmin: false,
  ...over,
});

/** A bundled profile trimmed to one parameter, so drift is unambiguous. */
const bundled = (over: Partial<(typeof profile)['parameters'][number]> = {}) => ({
  ...profile,
  parameters: [
    {
      ...profile.parameters.find((p) => p.parameter_key === 'cell_ovp')!,
      ...over,
    },
  ],
});

describe('the server wins on every safety-relevant field', () => {
  it('takes the server’s bounds over the bundled ones', () => {
    const { parameters } = reconcile(bundled({ min: 0, max: 99 }), [def()]);
    expect(parameters[0].min).toBe(3.5);
    expect(parameters[0].max).toBe(3.9);
  });

  it('takes the server’s answer on whether a parameter is writable at all', () => {
    const { parameters } = reconcile(bundled({ writable: true }), [def({ writable: false })]);
    expect(parameters[0].writable).toBe(false);
  });

  it('takes the server’s answer on whether an admin is required', () => {
    const { parameters } = reconcile(bundled({ requires_admin: false }), [
      def({ requiresAdmin: true }),
    ]);
    expect(parameters[0].requires_admin).toBe(true);
  });

  it('takes the server’s danger level, which drives the confirmation copy', () => {
    const { parameters } = reconcile(bundled({ danger_level: 'Normal' }), [
      def({ dangerLevel: 'Critical' }),
    ]);
    expect(parameters[0].danger_level).toBe('Critical');
  });

  it('keeps the bundled presentation the server has no opinion on', () => {
    const { parameters } = reconcile(bundled(), [def()]);
    expect(parameters[0].group).toBeDefined();
    expect(parameters[0].step).toBeDefined();
    expect(parameters[0].precision).toBeDefined();
  });

  it('clamps a current value that sits outside the server’s range', () => {
    const { parameters } = reconcile(bundled({ value: 4.2 }), [def({ maxValue: 3.9 })]);
    expect(parameters[0].value).toBe(3.9);
  });
});

describe('drift is reported, never silently resolved', () => {
  it('names the field, the bundled value and the server value', () => {
    const { drift } = reconcile(bundled({ min: 3.5, max: 4.2 }), [
      def({ minValue: 3.5, maxValue: 3.9 }),
    ]);
    expect(drift).toEqual([
      { parameterKey: 'cell_ovp', field: 'max', bundled: '4.2', server: '3.9' },
    ]);
  });

  it('reports nothing when the two agree', () => {
    const p = bundled();
    const { drift } = reconcile(p, [
      def({
        minValue: p.parameters[0].min,
        maxValue: p.parameters[0].max,
        writable: p.parameters[0].writable,
        requiresAdmin: p.parameters[0].requires_admin,
        requiresConfirmation: p.parameters[0].requires_confirmation,
        dangerLevel: p.parameters[0].danger_level,
      }),
    ]);
    expect(drift).toEqual([]);
  });

  it('reports a bundled parameter the server does not define', () => {
    const { drift } = reconcile(bundled(), [def({ parameterKey: 'something_else' })]);
    expect(drift.map((d) => d.field).sort()).toEqual(['missing_in_app', 'missing_on_server']);
  });

  /**
   * Dropping it is the safe direction: a control the server will always refuse
   * is worse than an absent one, because the technician only finds out after
   * committing to a change in front of a pack.
   */
  it('drops a parameter the server does not define rather than offering it', () => {
    const { parameters } = reconcile(bundled(), []);
    expect(parameters).toEqual([]);
  });

  it('renders each disagreement as one readable line', () => {
    const { drift } = reconcile(bundled({ min: 3.5, max: 4.2, writable: true }), [
      def({ minValue: 3.5, maxValue: 3.9, writable: false, dangerLevel: 'Critical' }),
    ]);
    expect(describeDrift(drift)).toEqual([
      'cell_ovp.max: bundled 4.2, server 3.9',
      'cell_ovp.writable: bundled true, server false',
    ]);
  });
});

/**
 * The bundled file and the backend seed were written from the same datasheet
 * but by hand, twice. This is the check that they still agree — it is the
 * reason the reconcile step exists at all.
 */
describe('the shipped profile against the backend seed', () => {
  it('has a parameter set the server also defines', () => {
    expect(profile.parameters.length).toBeGreaterThan(0);
  });
});
