import type { ApiClient } from './client';

/**
 * The company, its people and its fleet, from the app.
 *
 * Note the verbs: `post` on this client is deliberately unauthenticated — it
 * exists for sign-in itself — so everything here uses the `authed*` variants.
 * Reaching for the short name would send these without a bearer token.
 *
 * Everything that changes something is refused server-side for anyone but an
 * administrator. A technician calling these gets 403 or 404; the screens that
 * call them are not reachable by a technician in the first place, but the
 * screen is never the boundary.
 */

/* ---------------------------------------------------------------- roles */

/** 'company' is the company's administrator, 'user' a technician. */
export type Role = 'company' | 'user';

export const ROLE_LABEL: Record<Role, string> = {
  company: 'Administrator',
  user: 'Technician',
};

export const ROLE_HINT: Record<Role, string> = {
  company: 'Looks after people, packs and gateways. Holds every permission.',
  user: 'Connects to packs on site. What they may do is set below.',
};

/* -------------------------------------------------------------- company */

export interface CompanyOverview {
  people: { total: number; active: number; invited: number; administrators: number };
  batteries: { total: number; inService: number; reportingWithin24Hours: number };
  gateways: { total: number; inService: number };
}

export interface Company {
  id: string;
  name: string;
  createdAt: number;
  overview: CompanyOverview;
}

/** The company and the numbers an administrator opens the app to see. */
export async function fetchCompany(api: ApiClient): Promise<Company> {
  return api.get<Company>('/company');
}

export async function renameCompany(api: ApiClient, name: string): Promise<{ name: string }> {
  return api.authedPatch('/company', { name });
}

/* --------------------------------------------------------------- people */

export interface ManagedUser {
  id: string;
  company_id: string;
  email: string;
  display_name: string;
  role: Role;
  status: 'active' | 'invited' | 'suspended' | string;
  created_at?: number;
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
  // An administrator holds every permission; the columns do not apply.
  if (user.role === 'company') return { read: true, write: true, location: true, health: true };
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

export const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  invited: 'Invited',
  suspended: 'Suspended',
};

/** What a person's row says: their role, or what is wrong with the account. */
export function describePerson(user: ManagedUser): string {
  if (user.status !== 'active') return STATUS_LABEL[user.status] ?? user.status;
  if (user.role === 'company') return ROLE_LABEL.company;
  const pm = permissionsOf(user);
  const granted = [
    pm.read && 'read',
    pm.write && 'write',
    pm.location && 'location',
    pm.health && 'health',
  ].filter(Boolean) as string[];
  return granted.join(' · ') || 'nothing';
}

export async function listUsers(api: ApiClient): Promise<ManagedUser[]> {
  return (await api.get<{ users: ManagedUser[] }>('/users')).users;
}

export interface NewPerson {
  email: string;
  displayName: string;
  role: Role;
  permissions?: Partial<Permissions>;
}

/**
 * Create somebody by invitation: they set their own first password and nobody
 * else ever sees it. The link comes back for the administrator to hand over.
 */
export async function invitePerson(
  api: ApiClient,
  input: NewPerson
): Promise<{ id: string; invitation?: { token: string; expiresAt: number } }> {
  return api.authedPost('/users', input);
}

export async function editPerson(
  api: ApiClient,
  userId: string,
  patch: { displayName?: string; email?: string }
): Promise<void> {
  await api.authedPatch(`/users/${userId}`, patch);
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

/** Gone for good, or suspended if they have history the ledger still names. */
export async function removePerson(
  api: ApiClient,
  userId: string
): Promise<{ removed: boolean; reason?: string }> {
  return api.authedDelete(`/users/${userId}`);
}

/* ---------------------------------------------------------------- fleet */

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
