import type { ApiClient } from './client';

/**
 * The platform at a glance, for an administrator.
 *
 * Every figure is counted by the server in SQL. Asking the app to count would
 * mean fetching every company, user and pack to measure them — which works
 * until the lists are paged, and then quietly reports the size of a page.
 */

export interface PlatformOverview {
  companies: { total: number; withAccess: number; lapsingWithin30Days: number };
  users: { total: number; active: number };
  batteries: { total: number; reportingWithin24Hours: number };
  gateways: { total: number; inService: number };
}

export async function platformOverview(api: ApiClient): Promise<PlatformOverview> {
  return api.get<PlatformOverview>('/platform/overview');
}
