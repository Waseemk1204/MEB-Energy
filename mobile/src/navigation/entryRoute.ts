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
export type EntryRole = 'admin' | 'company' | 'user';

export interface EntryState {
  authenticated: boolean;
  /**
   * Who this is. The technician flow below applies to field users; an
   * administrator and a company owner land on their own surfaces instead,
   * because the pack-connection sequence is not what either of them opens the
   * app to do.
   */
  role: EntryRole;
  /** Null when no BLE link is established. Never restored from storage. */
  connectedBatteryId: string | null;
  /** First route segment, e.g. 'login', 'batteries', '(tabs)', 'settings'. */
  segment: EntrySegment;
}

export const LOGIN = '/login';
export const BATTERIES = '/batteries';
export const APP = '/(tabs)';
export const ADMIN = '/admin';
export const COMPANY = '/company';

/** Where each role belongs when it has nowhere better to be. */
export const HOME: Record<EntryRole, string> = {
  admin: ADMIN,
  company: COMPANY,
  user: BATTERIES,
};

/**
 * The only segments that belong to a role. Everything else — the pack flow and
 * its screens — is open to whoever is signed in.
 *
 * Written as the short list of restrictions rather than the long list of what
 * each role may reach. An allowlist would have to be edited every time a screen
 * is added, and the day somebody forgets is the day a technician is bounced off
 * the help page.
 *
 * This is navigation, not authorisation. Every route is checked again on the
 * server against the token; this only decides where the app sends somebody.
 */
const RESTRICTED: Record<string, ReadonlySet<EntryRole>> = {
  // A company owner has no business on the platform-admin surface.
  admin: new Set<EntryRole>(['admin']),
  // Administrators reach a company's surface too — support work needs it.
  company: new Set<EntryRole>(['admin', 'company']),
};

/**
 * Returns where the user must be sent, or null if they are already somewhere
 * legitimate. Returning null for a valid location is what stops redirect loops.
 */
export function entryRoute({
  authenticated,
  role,
  connectedBatteryId,
  segment,
}: EntryState): string | null {
  const onLogin = segment === 'login';

  // Signed out: Login is the only reachable screen.
  if (!authenticated) return onLogin ? null : LOGIN;

  // Signed in: Login is closed off, and each role goes to its own home.
  if (onLogin) return connectedBatteryId ? APP : HOME[role];

  // A surface that belongs to another role. The server would refuse the data
  // anyway; this stops the app rendering a frame of it first.
  const owners = segment === undefined ? undefined : RESTRICTED[segment];
  if (owners && !owners.has(role)) return HOME[role];

  // A role surface is not part of the pack flow, so the link rule below does
  // not apply to it. An administrator on their own screen has no pack and
  // should not be dragged towards one.
  if (segment !== undefined && segment in RESTRICTED) return null;

  /*
   * The pack flow. Without a live BLE link every telemetry screen would render
   * gauges for a pack the phone is not talking to, so the Battery List is the
   * only one reachable — for whoever is in the flow, technician or not.
   */
  if (!connectedBatteryId) return segment === 'batteries' ? null : BATTERIES;

  // Linked: everything in the flow is open, the Battery List included, so a
  // pack can be switched without signing out.
  return null;
}
