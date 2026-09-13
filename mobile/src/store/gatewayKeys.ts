import { secureBackend } from './sessionStorage';
import { listGateways, type Gateway } from '../api/gateways';
import type { ApiClient } from '../api/client';

/**
 * The company's gateways and their keys, kept where a technician with no
 * signal can still reach them.
 *
 * Fetched from the server whenever a pack is opened and there is a
 * connection; served from secure storage when there is not. A gateway the
 * server has revoked is dropped from the cache on the next fetch, so a
 * phone that was offline for a week still stops trusting it the moment it
 * has signal again — and never trusted it more than the list allowed.
 */

const KEY = 'meb.gateways.v1';

export interface KnownGateway {
  id: string;
  serial: string;
  /** Hex, 64 characters; null for one registered before keys existed. */
  authKey: string | null;
  assignedBatteryId: string | null;
  securityStatus: Gateway['security_status'];
}

const fromRow = (g: Gateway & { auth_key?: string | null }): KnownGateway => ({
  id: g.id,
  serial: g.serial,
  authKey: g.auth_key ?? null,
  assignedBatteryId: g.assigned_battery_id,
  securityStatus: g.security_status,
});

export async function loadKnownGateways(api: ApiClient): Promise<KnownGateway[]> {
  try {
    const fresh = (await listGateways(api)).map(fromRow);
    await secureBackend.set(KEY, JSON.stringify(fresh)).catch(() => undefined);
    return fresh;
  } catch {
    // Offline, or the server refused: the last list we were given is the
    // best truth there is, and it is never wider than the server allowed.
    try {
      const raw = await secureBackend.get(KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as KnownGateway[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

export async function forgetKnownGateways(): Promise<void> {
  await secureBackend.remove(KEY).catch(() => undefined);
}

/** Only a valid gateway with a key is a gateway the app will talk to. */
export const usable = (g: KnownGateway): boolean => g.securityStatus === 'valid' && !!g.authKey;
