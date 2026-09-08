import type { ApiClient } from './client';
import type { BmsParameter, CapabilityProfile } from '../bms/capabilityProfile';
import type { DangerLevel } from '../theme/tokens';

/**
 * Reconciling the bundled capability profile with the server's.
 *
 * The app ships a profile JSON so it can render Settings with no network — a
 * technician in a basement still needs the screen. But that means two copies of
 * every safety bound exist, and PRD §5.2 is explicit that the server is the
 * boundary. So:
 *
 * · **The server's bounds win** wherever the two disagree.
 * · **The bundled file keeps the presentation** the server has no opinion on —
 *   grouping, step size, precision, why a parameter is fixed.
 * · **Every disagreement is reported**, not silently resolved. A bundled file
 *   that has drifted from the server is a shipping defect: it means the app has
 *   been offering a technician a bound the server will refuse, or worse, one it
 *   would have accepted.
 */

export interface ServerDefinition {
  parameterKey: string;
  displayName: string;
  unit: string;
  dataType: 'integer' | 'float' | 'boolean' | 'enum';
  minValue: number;
  maxValue: number;
  dangerLevel: DangerLevel;
  supportedBms: string;
  readable: boolean;
  writable: boolean;
  requiresConfirmation: boolean;
  requiresAdmin: boolean;
}

/** The fields where a disagreement changes what a technician is allowed to do. */
export type DriftField =
  | 'min'
  | 'max'
  | 'writable'
  | 'requiresAdmin'
  | 'requiresConfirmation'
  | 'dangerLevel';

export interface Drift {
  parameterKey: string;
  field: DriftField | 'missing_on_server' | 'missing_in_app';
  bundled: string;
  server: string;
}

export interface Reconciled {
  parameters: BmsParameter[];
  drift: Drift[];
}

export async function fetchDefinitions(
  client: ApiClient,
  bmsModel: string
): Promise<ServerDefinition[]> {
  const body = await client.get<{ parameters: ServerDefinition[] }>(
    `/bms/${encodeURIComponent(bmsModel)}/parameters`
  );
  return body.parameters;
}

/**
 * Server bounds over bundled presentation.
 *
 * A parameter the server does not define is dropped, not kept: offering a
 * control for something the server will always refuse is worse than not
 * showing it, and it is reported as drift either way.
 */
export function reconcile(local: CapabilityProfile, server: ServerDefinition[]): Reconciled {
  const byKey = new Map(server.map((d) => [d.parameterKey, d]));
  const drift: Drift[] = [];
  const parameters: BmsParameter[] = [];

  for (const p of local.parameters) {
    const s = byKey.get(p.parameter_key);
    if (!s) {
      drift.push({
        parameterKey: p.parameter_key,
        field: 'missing_on_server',
        bundled: 'present',
        server: 'absent',
      });
      continue;
    }
    byKey.delete(p.parameter_key);

    const note = (field: DriftField, bundled: unknown, srv: unknown) => {
      if (bundled !== srv) {
        drift.push({
          parameterKey: p.parameter_key,
          field,
          bundled: String(bundled),
          server: String(srv),
        });
      }
    };

    note('min', p.min, s.minValue);
    note('max', p.max, s.maxValue);
    note('writable', p.writable, s.writable);
    note('requiresAdmin', p.requires_admin, s.requiresAdmin);
    note('requiresConfirmation', p.requires_confirmation, s.requiresConfirmation);
    note('dangerLevel', p.danger_level, s.dangerLevel);

    parameters.push({
      ...p,
      // Safety-relevant fields are taken from the server, without exception.
      min: s.minValue,
      max: s.maxValue,
      writable: s.writable,
      readable: s.readable,
      requires_admin: s.requiresAdmin,
      requires_confirmation: s.requiresConfirmation,
      danger_level: s.dangerLevel,
      // A value outside the server's range would render the control already out
      // of bounds, so it is clamped into it rather than shown as impossible.
      value: Math.min(Math.max(p.value, s.minValue), s.maxValue),
    });
  }

  // Anything left is defined by the server but has no bundled presentation.
  for (const s of byKey.values()) {
    drift.push({
      parameterKey: s.parameterKey,
      field: 'missing_in_app',
      bundled: 'absent',
      server: 'present',
    });
  }

  return { parameters, drift };
}

/** One line per disagreement, for the field log and the diagnostics screen. */
export function describeDrift(drift: Drift[]): string[] {
  return drift.map((d) =>
    d.field === 'missing_on_server'
      ? `${d.parameterKey}: bundled but not defined by the server`
      : d.field === 'missing_in_app'
        ? `${d.parameterKey}: defined by the server but not bundled`
        : `${d.parameterKey}.${d.field}: bundled ${d.bundled}, server ${d.server}`
  );
}
