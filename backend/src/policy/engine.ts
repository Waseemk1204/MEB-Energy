import type { Principal } from '../db/tenancy.js';

/**
 * Server-side enforcement of every BMS write (PRD §7.5).
 *
 * PRD §5.2 is unambiguous: "permissions must be enforced server-side. UI hiding
 * of controls is never the security boundary." The mobile app has its own gates
 * — acknowledgement, reason, PIN — and none of them count. A request arriving
 * here is assumed to have come from an attacker who skipped all of them.
 *
 * A pure function on purpose: the decision depends only on its inputs, so every
 * branch is testable without a database, a request, or a session.
 */

export type DangerLevel = 'Normal' | 'Warning' | 'Critical';

export interface ParameterDefinition {
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

export interface WriteRequest {
  parameterKey: string;
  value: number;
  /** The BMS actually attached, so a mismatched profile cannot be written. */
  bmsModel: string;
  /** The company owning the battery being written to. */
  targetCompanyId: string;
  /** Mandatory for Critical parameters (PRD §6.2). */
  reason?: string;
  /** Set only for an administrator acting inside a tracked support session (§7.13). */
  supportSessionId?: string;
  /** Whether the user's BLE session is live — Mode 1 (§7.3). */
  bleSessionActive: boolean;
  /** Distinctly-flagged administrator override (§6.3). */
  forcePush?: boolean;
}

export type DenyCode =
  | 'unknown_parameter'
  | 'not_writable'
  | 'bms_mismatch'
  | 'out_of_range'
  | 'wrong_type'
  | 'requires_admin'
  | 'wrong_tenant'
  | 'reason_required'
  | 'no_active_session'
  | 'session_required_for_admin_write'
  | 'company_policy';

export type Decision =
  | { allowed: true; requiresConfirmation: boolean; source: 'local' | 'admin_remote' | 'admin_force_push' }
  | { allowed: false; code: DenyCode; message: string };

/** Company-level overlays may further restrict, never widen (PRD §7.5). */
export interface CompanyPolicy {
  /** Parameter keys this company forbids for the given role. */
  deniedForRole?: Partial<Record<Principal['role'], string[]>>;
}

const deny = (code: DenyCode, message: string): Decision => ({ allowed: false, code, message });

export function evaluateWrite(
  principal: Principal,
  definition: ParameterDefinition | undefined,
  request: WriteRequest,
  policy: CompanyPolicy = {}
): Decision {
  if (!definition) {
    return deny('unknown_parameter', `No definition for '${request.parameterKey}'`);
  }

  if (!definition.writable) {
    return deny(
      'not_writable',
      `${definition.displayName} is fixed by the hardware and cannot be written`
    );
  }

  // A definition for a different BMS says nothing about the one attached.
  if (definition.supportedBms !== request.bmsModel) {
    return deny(
      'bms_mismatch',
      `${definition.displayName} is defined for ${definition.supportedBms}, not ${request.bmsModel}`
    );
  }

  if (!Number.isFinite(request.value)) {
    return deny('wrong_type', `${definition.displayName} requires a numeric value`);
  }

  if (definition.dataType === 'integer' && !Number.isInteger(request.value)) {
    return deny('wrong_type', `${definition.displayName} must be a whole number`);
  }

  if (request.value < definition.minValue || request.value > definition.maxValue) {
    return deny(
      'out_of_range',
      `${definition.displayName} must be between ${definition.minValue} and ${definition.maxValue} ${definition.unit}`
    );
  }

  if (definition.requiresAdmin && principal.role !== 'company') {
    return deny('requires_admin', `${definition.displayName} may only be changed by an administrator`);
  }

  // Tenancy. Everyone writes only to their own company's batteries.
  if (principal.companyId !== request.targetCompanyId) {
    return deny('wrong_tenant', 'Battery not found');
  }

  const forbidden = policy.deniedForRole?.[principal.role] ?? [];
  if (forbidden.includes(definition.parameterKey)) {
    return deny(
      'company_policy',
      `${definition.displayName} is restricted for this role by company policy`
    );
  }

  // A Critical change without a stated reason leaves the audit trail unable to
  // answer "why", which is the question it exists for (PRD §6.2, §7.12).
  if (definition.dangerLevel === 'Critical' && !request.reason?.trim()) {
    return deny('reason_required', `A reason is required to change ${definition.displayName}`);
  }

  /**
   * Mode 1, §7.3. No command reaches a BMS without a live BLE session at the
   * pack — and Force Push does not change that. It overrides queue state and
   * soft-holds, never the architectural requirement.
   *
   * An administrator writing through this path is remote by definition: the
   * on-site path is the app's own BLE write, which reports itself through the
   * audit upload. So their write needs somebody's session, and is recorded as
   * a remote one.
   */
  if (!request.bleSessionActive) {
    return principal.role === 'company'
      ? deny(
          'session_required_for_admin_write',
          'No active user session: an administrator cannot reach this battery, and Force Push does not bypass that'
        )
      : deny('no_active_session', 'No active connection to the battery');
  }

  const source =
    principal.role !== 'company'
      ? ('local' as const)
      : request.forcePush
        ? ('admin_force_push' as const)
        : ('admin_remote' as const);

  return { allowed: true, requiresConfirmation: definition.requiresConfirmation, source };
}

/** Reads are simpler, but still scoped and still server-enforced. */
export function evaluateRead(
  principal: Principal,
  definition: ParameterDefinition | undefined,
  targetCompanyId: string
): Decision {
  if (!definition) return deny('unknown_parameter', 'No such parameter');
  if (!definition.readable) return deny('not_writable', 'Parameter is not readable');
  if (principal.companyId !== targetCompanyId) {
    return deny('wrong_tenant', 'Battery not found');
  }
  return { allowed: true, requiresConfirmation: false, source: 'local' };
}
