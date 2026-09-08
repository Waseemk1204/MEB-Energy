import type { ApiClient } from './client';

/**
 * People, gateways and tenants.
 *
 * Users are created **by invitation**: the account has no usable password and
 * cannot be signed into, and a single-use link lets the person set one
 * themselves. Nobody else ever sees it.
 *
 * What that still does not fix: there is no email delivery, so an
 * administrator has to hand the link over, and whoever holds an unused link
 * can claim that account. Single use and a seven-day expiry bound it — once
 * the invited person accepts, the link is spent. When email delivery exists,
 * only the delivery changes; nothing in this module does.
 */

export type Role = 'admin' | 'company' | 'user';
export type UserStatus = 'active' | 'suspended' | 'invited';
export type DeviceSecurity = 'valid' | 'revoked' | 'quarantined';

export interface User {
  id: string;
  companyId: string | null;
  email: string;
  displayName: string;
  role: Role;
  status: UserStatus;
}

interface UserRow {
  id: string;
  company_id: string | null;
  email: string;
  display_name: string;
  role: Role;
  status: UserStatus;
}

export interface Company {
  id: string;
  name: string;
  status: string;
  createdAt: number;
}

export interface Device {
  id: string;
  companyId: string;
  serial: string;
  hardwareRevision: string | null;
  firmwareVersion: string | null;
  assignedBatteryId: string | null;
  securityStatus: DeviceSecurity;
}

interface DeviceRow {
  id: string;
  company_id: string;
  serial: string;
  hardware_revision: string | null;
  firmware_version: string | null;
  assigned_battery_id: string | null;
  security_status: DeviceSecurity;
}

export interface SeatUsage {
  used: number;
  limit: number | null;
}

/* --------------------------------------------------------------------- users */

export function userFromRow(row: UserRow): User {
  return {
    id: row.id,
    companyId: row.company_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
  };
}

export async function listUsers(api: ApiClient): Promise<User[]> {
  const body = await api.get<{ users: UserRow[] }>('/users');
  return body.users.map(userFromRow);
}

export interface CreatedUser {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  /** Returned exactly once. The server stores it hashed and cannot show it again. */
  invitation: { token: string; expiresAt: number } | null;
}

/**
 * Invite somebody. No password is sent, because the console does not choose
 * one — that is the whole point.
 */
export async function inviteUser(
  api: ApiClient,
  input: { companyId: string | null; email: string; displayName: string; role: Role }
): Promise<CreatedUser> {
  return api.post('/users', input);
}

/**
 * The link to hand over.
 *
 * Built from the console's own origin, so it points at wherever this console
 * is actually served rather than a hard-coded host.
 */
export function invitationLink(token: string, origin = globalThis.location?.origin ?? ''): string {
  return `${origin}/accept-invite?token=${encodeURIComponent(token)}`;
}

export async function acceptInvitation(
  api: ApiClient,
  token: string,
  password: string
): Promise<unknown> {
  return api.anon('/auth/accept-invite', { token, password });
}

/** Matches the backend's own minimum. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Suspension is immediate: the backend revokes every refresh token the account
 * holds, so the person is signed out wherever they are rather than continuing
 * to work until a token expires. The console says so before it happens.
 */
export async function setUserStatus(
  api: ApiClient,
  userId: string,
  status: UserStatus
): Promise<void> {
  await api.patch(`/users/${userId}/status`, { status });
}

export async function seatUsage(api: ApiClient, companyId: string): Promise<SeatUsage> {
  return api.get(`/companies/${companyId}/seats`);
}

/* ----------------------------------------------------------------- companies */

export async function listCompanies(api: ApiClient): Promise<Company[]> {
  const body = await api.get<{ companies: { id: string; name: string; status: string; created_at: number }[] }>(
    '/companies'
  );
  return body.companies.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    createdAt: c.created_at,
  }));
}

export async function createCompany(
  api: ApiClient,
  input: { name: string; seatLimit: number; deviceLimit?: number | null; batteryLimit?: number | null }
): Promise<{ companyId: string }> {
  return api.post('/companies', input);
}

/* ------------------------------------------------------------- entitlement */

/**
 * What a company is allowed to do, and how much of it is used.
 *
 * Payment happens outside this system, so an entitlement is an administrator
 * recording a decision rather than something inferred from a billing
 * integration that does not exist.
 */

export type EntitlementCode =
  | 'ok'
  | 'company_suspended'
  | 'no_subscription'
  | 'subscription_expired'
  | 'subscription_cancelled';

export interface Usage {
  used: number;
  limit: number | null;
}

export interface Entitlement {
  code: EntitlementCode;
  ok: boolean;
  expiresAt?: number;
  seatLimit?: number;
  /** knowyourEV gateways the company may register; null means no limit. */
  deviceLimit?: number | null;
  /** Phones and browsers the owner account may be signed in on at once. */
  sessionDeviceLimit?: number;
  batteryLimit?: number | null;
  seats: Usage;
  devices: Usage;
  sessionDevices: Usage;
  batteries: Usage;
}

/** The tiers offered. Any positive number is accepted; these are the shortcuts. */
export const SEAT_TIERS = [5, 20, 50, 100, 250, 500] as const;

/** Two, unless an administrator raises it. */
export const DEFAULT_DEVICE_LIMIT = 2;

/**
 * Signed-in phones and browsers for the company-owner account, which is a
 * different number from DEFAULT_DEVICE_LIMIT above even though both start at
 * two. That one counts knowyourEV gateways.
 */
export const DEFAULT_SESSION_DEVICES = 2;

export async function getEntitlement(api: ApiClient, companyId: string): Promise<Entitlement> {
  return api.get(`/companies/${companyId}/entitlement`);
}

/** Switch a company on for a year, from now. */
export async function grantAccess(
  api: ApiClient,
  companyId: string,
  input: {
    seatLimit: number;
    deviceLimit?: number;
    sessionDeviceLimit?: number;
    batteryLimit?: number | null;
  }
): Promise<{ expiresAt: number; seatLimit: number; deviceLimit: number }> {
  return api.post(`/companies/${companyId}/access`, input);
}

/** Switch it off. Distinct from letting the term lapse. */
export async function revokeAccess(api: ApiClient, companyId: string): Promise<void> {
  await api.delete(`/companies/${companyId}/access`);
}

/** Change what a live plan allows without restarting its term. */
export async function adjustLimits(
  api: ApiClient,
  companyId: string,
  input: {
    seatLimit?: number;
    deviceLimit?: number;
    sessionDeviceLimit?: number;
    batteryLimit?: number | null;
  }
): Promise<Entitlement> {
  return api.patch(`/companies/${companyId}/limits`, input);
}

/**
 * Remove a user — the guest case: brought in for a problem, taken off when it
 * is solved. Somebody who has changed anything is suspended instead, because
 * the audit ledger references its actor. The result says which happened.
 */
export async function removeUser(
  api: ApiClient,
  userId: string
): Promise<{ removed: boolean; reason?: 'has_history' }> {
  return api.delete(`/users/${userId}`);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function describeRemaining(expiresAt: number, now = Date.now()): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'expired';

  const days = Math.ceil(ms / DAY_MS);
  if (days <= 60) return `${days} day${days === 1 ? '' : 's'} left`;
  return `${Math.round(days / 30)} months left`;
}

/** How each refusal reads, and how urgent it looks. */
export const ENTITLEMENT_LABEL: Record<EntitlementCode, string> = {
  ok: 'Active',
  company_suspended: 'Suspended',
  no_subscription: 'No access',
  subscription_expired: 'Expired',
  subscription_cancelled: 'Cancelled',
};

export const ENTITLEMENT_TONE: Record<EntitlementCode, 'good' | 'warn' | 'critical'> = {
  ok: 'good',
  // Not an error — a company that has simply never been switched on.
  no_subscription: 'warn',
  subscription_expired: 'critical',
  subscription_cancelled: 'critical',
  company_suspended: 'critical',
};

/* ------------------------------------------------------------------ devices */

export function deviceFromRow(row: DeviceRow): Device {
  return {
    id: row.id,
    companyId: row.company_id,
    serial: row.serial,
    hardwareRevision: row.hardware_revision,
    firmwareVersion: row.firmware_version,
    assignedBatteryId: row.assigned_battery_id,
    securityStatus: row.security_status,
  };
}

export async function listDevices(api: ApiClient): Promise<Device[]> {
  const body = await api.get<{ devices: DeviceRow[] }>('/devices');
  return body.devices.map(deviceFromRow);
}

export async function registerDevice(
  api: ApiClient,
  input: {
    companyId: string;
    serial: string;
    hardwareRevision: string;
    firmwareVersion: string;
    assignedBatteryId?: string | null;
  }
): Promise<{ id: string }> {
  return api.post('/devices', input);
}

/**
 * Taking a gateway out of service (PRD §8.1). The app refuses to talk to a
 * device that is not `valid`, so this is the lever that stops a suspect one
 * being used — which is why the wording distinguishes the two states rather
 * than calling both "disabled".
 */
export async function setDeviceSecurity(
  api: ApiClient,
  deviceId: string,
  securityStatus: DeviceSecurity
): Promise<void> {
  await api.patch(`/devices/${deviceId}/security`, { securityStatus });
}

export const DEVICE_SECURITY_LABEL: Record<DeviceSecurity, string> = {
  valid: 'In service',
  quarantined: 'Quarantined',
  revoked: 'Revoked',
};

export const DEVICE_SECURITY_TONE: Record<DeviceSecurity, 'good' | 'warn' | 'critical'> = {
  valid: 'good',
  quarantined: 'warn',
  revoked: 'critical',
};

export const USER_STATUS_LABEL: Record<UserStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  invited: 'Invited',
};

export const USER_STATUS_TONE: Record<UserStatus, 'good' | 'warn' | 'critical'> = {
  active: 'good',
  // Not an error, and not working either: something is outstanding.
  invited: 'warn',
  suspended: 'critical',
};

export const DEVICE_SECURITY_MEANING: Record<DeviceSecurity, string> = {
  valid: 'The app will authenticate and use this gateway.',
  quarantined: 'The app will refuse this gateway. Reversible once it has been checked.',
  revoked: 'The app will refuse this gateway permanently. Use this when it is lost or compromised.',
};


