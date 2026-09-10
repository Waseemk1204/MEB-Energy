/**
 * The PRD §7.4 entry flow, as a pure decision.
 *
 *   Login → Select Battery → Connect KnowyourEV Device → Authenticate Device
 *         → Detect BMS → Battery Dashboard
 *
 * Kept separate from the navigation plumbing so the policy can be tested
 * exhaustively rather than by driving a browser. The hook that uses it only
 * translates the answer into a router.replace().
 */

export type EntrySegment = string | undefined;

export interface EntryState {
  authenticated: boolean;
  /** Null when no BLE link is established. Never restored from storage. */
  connectedBatteryId: string | null;
  /** First route segment, e.g. 'login', 'batteries', '(tabs)', 'settings'. */
  segment: EntrySegment;
}

export const LOGIN = '/login';
export const BATTERIES = '/batteries';
export const APP = '/(tabs)';

/**
 * Returns where the user must be sent, or null if they are already somewhere
 * legitimate. Returning null for a valid location is what stops redirect loops.
 */
export function entryRoute({
  authenticated,
  connectedBatteryId,
  segment,
}: EntryState): string | null {
  const onLogin = segment === 'login';
  const onBatteries = segment === 'batteries';

  // Signed out: Login is the only reachable screen.
  if (!authenticated) return onLogin ? null : LOGIN;

  // Signed in: Login is closed off, and where you land depends on the link.
  if (onLogin) return connectedBatteryId ? APP : BATTERIES;

  // Signed in but unlinked: the Battery List is the only reachable screen.
  // Telemetry screens would otherwise render gauges for a pack we cannot read.
  if (!connectedBatteryId) return onBatteries ? null : BATTERIES;

  // Signed in and linked: everything is reachable, the Battery List included,
  // so a user can switch packs without signing out.
  return null;
}
