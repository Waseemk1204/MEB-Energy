import type { ApiClient } from './client';

/**
 * Administration, from the app.
 *
 * Note the verbs: `post` on this client is deliberately unauthenticated — it
 * exists for sign-in itself — so everything here uses the `authed*` variants.
 * Reaching for the short name would send these without a bearer token.
 *
 * Everything here is refused server-side for anyone but an administrator — a
 * company owner calling these gets 404, which is the same answer as a route
 * that does not exist, so the API never confirms what it is hiding.
 */

export interface Company {
  id: string;
  name: string;
  status: 'active' | 'suspended' | 'archived';
  created_at: number;
}

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
  seats: Usage;
  devices: Usage;
  sessionDevices: Usage;
  batteries: Usage;
}

export interface ManagedUser {
  id: string;
  company_id: string | null;
  email: string;
  display_name: string;
  role: 'admin' | 'company' | 'user';
  status: string;
  can_read: number;
  can_write: number;
  can_location: number;
  can_health: number;
}

export interface Permissions {
  read: boolean;
  write: boolean;
  location: boolean;
  health: boolean;
}

/** The four columns as booleans, which is how every screen wants them. */
export function permissionsOf(user: ManagedUser): Permissions {
  return {
    read: user.can_read === 1,
    write: user.can_write === 1,
    location: user.can_location === 1,
    health: user.can_health === 1,
  };
}

export const PERMISSION_LABEL: Record<keyof Permissions, string> = {
  read: 'Read packs',
  write: 'Change parameters',
  location: 'See location',
  health: 'See health history',
};

export const PERMISSION_HINT: Record<keyof Permissions, string> = {
  read: 'Live voltage, current, cells and temperature.',
  write: 'Within the ranges the pack profile allows.',
  location: 'Does nothing until a GPS gateway is fitted.',
  health: 'Capacity retention over the pack’s life.',
};

export async function listCompanies(api: ApiClient): Promise<Company[]> {
  return (await api.get<{ companies: Company[] }>('/companies')).companies;
}

export async function createCompany(
  api: ApiClient,
  input: { name: string }
): Promise<{ companyId: string }> {
  // No seat or battery limit is sent: there are none. What a company pays is
  // settled outside the product, so access on or off is the whole control.
  return api.authedPost('/companies', { name: input.name, seatLimit: 1 });
}

export async function entitlementOf(api: ApiClient, companyId: string): Promise<Entitlement> {
  return api.get(`/companies/${companyId}/entitlement`);
}

/** Switch a company on for a year, from now. */
export async function grantAccess(
  api: ApiClient,
  companyId: string
): Promise<{ expiresAt: number }> {
  return api.authedPost(`/companies/${companyId}/access`, { seatLimit: 1 });
}

/** Switch it off. Distinct from letting the term lapse, and refused as such. */
export async function revokeAccess(api: ApiClient, companyId: string): Promise<void> {
  await api.authedDelete(`/companies/${companyId}/access`);
}

/** Move the renewal date without restarting the term from today. */
export async function extendAccess(
  api: ApiClient,
  companyId: string,
  renewalDate: number
): Promise<Entitlement> {
  return api.authedPatch(`/companies/${companyId}/limits`, { renewalDate });
}

export async function listUsers(
  api: ApiClient,
  filter: { companyId?: string } = {}
): Promise<ManagedUser[]> {
  const query = filter.companyId ? `?companyId=${encodeURIComponent(filter.companyId)}` : '';
  return (await api.get<{ users: ManagedUser[] }>(`/users${query}`)).users;
}

export async function setPermissions(
  api: ApiClient,
  userId: string,
  patch: Partial<Permissions>
): Promise<Permissions> {
  return api.authedPatch(`/users/${userId}/permissions`, patch);
}

export async function setUserStatus(
  api: ApiClient,
  userId: string,
  status: 'active' | 'suspended'
): Promise<void> {
  await api.authedPatch(`/users/${userId}/status`, { status });
}

/**
 * How long is left, in the words somebody would use.
 *
 * A date alone carries no urgency — "14 March" does not read as a problem
 * until you work out what today is.
 */
export function describeRemaining(expiresAt: number | undefined, now = Date.now()): string {
  if (expiresAt === undefined) return 'No access';

  const days = Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000));
  if (days < 0) return `Expired ${Math.abs(days)} days ago`;
  if (days === 0) return 'Expires today';
  if (days === 1) return '1 day left';
  if (days < 60) return `${days} days left`;
  return `${Math.floor(days / 30)} months left`;
}

export const ENTITLEMENT_LABEL: Record<EntitlementCode, string> = {
  ok: 'Active',
  company_suspended: 'Suspended',
  no_subscription: 'No access',
  subscription_expired: 'Expired',
  subscription_cancelled: 'Cancelled',
};

/* ---------------------------------------------------- a company's own fleet */

export interface FleetPack {
  id: string;
  serial: string;
  chemistry: string;
  cell_count: number;
  bms_model: string | null;
  status: 'active' | 'retired';
  lastReading: { soc: number; recorded_at: number } | null;
}

export interface NewPack {
  companyId: string;
  serial: string;
  chemistry: string;
  cellCount: number;
  bmsManufacturer?: string;
  bmsModel?: string;
}

export interface PackPatch {
  serial?: string;
  chemistry?: string;
  cellCount?: number;
  bmsModel?: string | null;
  bmsFirmware?: string | null;
}

/** Every pack including retired ones — this is the management view. */
export async function listFleet(api: ApiClient): Promise<FleetPack[]> {
  return (await api.get<{ batteries: FleetPack[] }>('/batteries?includeRetired=1')).batteries;
}

export async function addPack(api: ApiClient, input: NewPack): Promise<{ batteryId: string }> {
  return api.authedPost('/batteries', input);
}

export async function editPack(api: ApiClient, id: string, patch: PackPatch): Promise<void> {
  await api.authedPatch(`/batteries/${id}`, patch);
}

/** Out of service, not deleted: the audit ledger still references it. */
export async function retirePack(api: ApiClient, id: string): Promise<void> {
  await api.authedDelete(`/batteries/${id}`);
}

export async function reinstatePack(api: ApiClient, id: string): Promise<void> {
  await api.authedPost(`/batteries/${id}/reinstate`, {});
}

/* ----------------------------------------------------- a company's people */

export interface NewPerson {
  companyId: string;
  email: string;
  displayName: string;
  permissions?: Partial<Permissions>;
}

/**
 * Create somebody by invitation: they set their own first password and nobody
 * else ever sees it. The link comes back for the owner to hand over.
 */
export async function invitePerson(
  api: ApiClient,
  input: NewPerson
): Promise<{ id: string; invitation?: { token: string; expiresAt: number } }> {
  return api.authedPost('/users', { ...input, role: 'user' });
}

/** Gone for good, or suspended if they have history the ledger still names. */
export async function removePerson(
  api: ApiClient,
  userId: string
): Promise<{ removed: boolean; reason?: string }> {
  return api.authedDelete(`/users/${userId}`);
}
