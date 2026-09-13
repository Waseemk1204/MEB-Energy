import type { ApiClient } from './client';

/**
 * The company's gateways — the hardware that sits between the app and a BMS
 * (PRD §8.1).
 *
 * The app refuses to authenticate a gateway that is not `valid`, so the
 * security status is the lever that takes a suspect one out of service. The
 * two non-valid states mean different things: quarantine is reversible while
 * something is checked, revocation is not.
 */

export type GatewaySecurity = 'valid' | 'quarantined' | 'revoked';

export interface Gateway {
  id: string;
  serial: string;
  hardware_revision: string;
  firmware_version: string;
  assigned_battery_id: string | null;
  security_status: GatewaySecurity;
  /** The handshake key, hex. Null for a gateway registered before keys existed. */
  auth_key: string | null;
  last_seen_at: number | null;
  created_at: number;
}

export interface NewGateway {
  serial: string;
  hardwareRevision: string;
  firmwareVersion: string;
  assignedBatteryId?: string | null;
}

export const SECURITY_LABEL: Record<GatewaySecurity, string> = {
  valid: 'In service',
  quarantined: 'Quarantined',
  revoked: 'Revoked',
};

export const SECURITY_TONE: Record<GatewaySecurity, 'good' | 'warn' | 'critical'> = {
  valid: 'good',
  quarantined: 'warn',
  revoked: 'critical',
};

export const SECURITY_MEANING: Record<GatewaySecurity, string> = {
  valid: 'The app will authenticate and use this gateway.',
  quarantined: 'The app will refuse this gateway. Reversible once it has been checked.',
  revoked: 'The app will refuse this gateway permanently. For one that is lost or compromised.',
};

export async function listGateways(api: ApiClient): Promise<Gateway[]> {
  return (await api.get<{ devices: Gateway[] }>('/devices')).devices;
}

/** The key and the console line come back here, once (docs/BLE_CONTRACT.md §8). */
export interface RegisteredGateway {
  id: string;
  authKey: string;
  provisioning: string;
}

export async function registerGateway(api: ApiClient, input: NewGateway): Promise<RegisteredGateway> {
  return api.authedPost('/devices', input);
}

/** A new key; the gateway must be provisioned again with the line returned. */
export async function rotateGatewayKey(api: ApiClient, id: string): Promise<RegisteredGateway> {
  return api.authedPost(`/devices/${id}/rotate-key`, {});
}

export async function setGatewaySecurity(
  api: ApiClient,
  id: string,
  securityStatus: GatewaySecurity
): Promise<void> {
  await api.authedPatch(`/devices/${id}/security`, { securityStatus });
}
