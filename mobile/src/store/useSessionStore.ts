import { create } from 'zustand';
import { DEV_BYPASS_AUTH, DEV_BYPASS_BATTERY_ID, OFFLINE_AUTH } from '../config';
import { clearSession, loadSession, saveSession, type SessionRole } from './sessionStorage';
import { logInfo, logWarn } from '../diagnostics/fieldLog';
import { login, LoginError } from '../api/auth';
import { api, onSessionExpired, setTokens } from '../api/session';
import { useProfileStore } from './useProfileStore';
import { useActivityStore } from './useActivityStore';
import { useFleetStore } from './useFleetStore';
import { useRemoteChangeStore } from './useRemoteChangeStore';

/**
 * Session and link state for the PRD §7.4 core flow:
 *
 *   Login → Select Battery → Connect KnowyourEV Device → Authenticate Device
 *         → Detect BMS → Battery Dashboard
 *
 * Sign-in is a real server round trip; what this store holds afterwards is UI
 * state derived from it. The security boundary remains server-side — role and
 * company here decide what to render, never what is permitted.
 */

export type ConnectStage =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'detecting'
  | 'connected'
  | 'failed';

/** The three steps the user is shown while a link is established. */
export const CONNECT_STEPS: { stage: ConnectStage; label: string }[] = [
  { stage: 'connecting', label: 'Connect KnowyourEV device' },
  { stage: 'authenticating', label: 'Authenticate device' },
  { stage: 'detecting', label: 'Detect BMS' },
];

const ORDER: ConnectStage[] = ['idle', 'connecting', 'authenticating', 'detecting', 'connected'];

/** Has `stage` already passed `step`? Drives the tick marks. */
export function stepComplete(current: ConnectStage, step: ConnectStage): boolean {
  if (current === 'failed') return false;
  return ORDER.indexOf(current) > ORDER.indexOf(step);
}

type SessionState = {
  /** False until the persisted session has been read. Nothing routes before this. */
  hydrated: boolean;
  authenticated: boolean;
  operator: string | null;
  company: string;
  /** The tenant, for creating users and packs inside it. Null for an admin. */
  companyId: string | null;
  /**
   * Which surface this person belongs on. Decides navigation only — every
   * route it unlocks is checked again on the server against the token, so
   * changing it here changes what the app shows, never what it can do.
   */
  role: SessionRole;
  /** Deliberately never persisted — see sessionStorage.ts. */
  connectedBatteryId: string | null;
  connectingBatteryId: string | null;
  stage: ConnectStage;
  error: string | null;
  /**
   * Devices this sign-in signed out, because the company account is capped at
   * a number of them. Shown once and dismissible: it reports something that
   * already happened rather than a condition still in force.
   */
  signedOut: string[];

  /** True while a sign-in request is in flight. */
  signingIn: boolean;

  hydrate: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<boolean>;
  signOut: () => void;
  dismissSignedOut: () => void;
  connect: (batteryId: string) => Promise<boolean>;
  disconnect: () => void;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Not a company name — the absence of one.
 *
 * The real name comes from `/auth/login`, which returns the tenant the account
 * belongs to. A literal default here is how every tenant ended up seeing
 * "Aurora Fleet" in their header before that was fixed, so there is
 * deliberately nothing plausible to fall back to.
 */
const NO_COMPANY = '';

export const useSessionStore = create<SessionState>((set, get) => ({
  hydrated: false,
  authenticated: false,
  operator: null,
  company: NO_COMPANY,
  companyId: null,
  // The least privileged role until a sign-in says otherwise.
  role: 'user',
  connectedBatteryId: null,
  connectingBatteryId: null,
  stage: 'idle',
  error: null,
  signingIn: false,
  signedOut: [],

  hydrate: async () => {
    if (get().hydrated) return;

    if (DEV_BYPASS_AUTH) {
      set({
        hydrated: true,
        authenticated: true,
        operator: 'Dev bypass',
        company: NO_COMPANY,
        connectedBatteryId: DEV_BYPASS_BATTERY_ID,
        stage: 'connected',
      });
      return;
    }

    const stored = await loadSession();
    if (stored) {
      setTokens(
        { accessToken: stored.token, refreshToken: stored.refreshToken },
        { operator: stored.operator, company: stored.company, companyId: stored.companyId, role: stored.role }
      );
    }
    set(
      stored
        ? {
            hydrated: true,
            authenticated: true,
            operator: stored.operator,
            company: stored.company,
            companyId: stored.companyId,
            role: stored.role,
            // No link is restored: the BLE session died with the process.
            connectedBatteryId: null,
            stage: 'idle',
          }
        : { hydrated: true, authenticated: false, operator: null, role: 'user' }
    );
  },

  /**
   * Sign-in is a server round trip. Failure leaves the user signed out with a
   * reason — there is no local fallback, because an app that lets you in when
   * the network is unreachable can be entered by unplugging the network.
   */
  signIn: async (email, password) => {
    if (get().signingIn) return false;
    set({ signingIn: true, error: null });

    if (OFFLINE_AUTH) {
      // Development only, and loudly so: no backend is contacted.
      const operator = email.trim() || 'Field user';
      setTokens(
        { accessToken: 'offline', refreshToken: 'offline' },
        { operator, company: get().company, companyId: null, role: 'user' }
      );
      set({ authenticated: true, operator, role: 'user', signingIn: false });
      void saveSession({
        token: 'offline',
        refreshToken: 'offline',
        operator,
        company: get().company,
        companyId: null,
        // The offline path invents a session; it gets the least it can.
        role: 'user',
        issuedAt: Date.now(),
      });
      return true;
    }

    try {
      const result = await login(api, email, password);
      const operator = result.user.displayName || result.user.email;
      const company = result.company?.name ?? get().company;
      const companyId = result.company?.id ?? null;
      const role = result.user.role;

      setTokens(
        { accessToken: result.accessToken, refreshToken: result.refreshToken },
        { operator, company, companyId, role }
      );
      await saveSession({
        token: result.accessToken,
        refreshToken: result.refreshToken,
        operator,
        company,
        companyId,
        role,
        issuedAt: Date.now(),
      });

      logInfo('session', 'Signed in', { role: result.user.role });
      set({
        authenticated: true,
        operator,
        company,
        companyId,
        role,
        signingIn: false,
        error: null,
        // An older backend does not send this; absent means nothing was
        // signed out, which is the safe reading either way.
        signedOut: result.signedOut ?? [],
      });
      return true;
    } catch (error) {
      const message =
        error instanceof LoginError ? error.message : 'Sign-in failed. Try again.';
      logWarn('session', 'Sign-in refused', {
        reason: error instanceof LoginError ? error.failure.kind : 'unknown',
      });
      set({ signingIn: false, error: message, authenticated: false });
      return false;
    }
  },

  signOut: () => {
    setTokens(null);
    useRemoteChangeStore.getState().stop();
    // The next user may belong to a different tenant with different limits,
    // and must never see the previous one's fleet.
    useProfileStore.getState().reset();
    void useFleetStore.getState().clear();
    void clearSession();
    set({
      authenticated: false,
      operator: null,
      connectedBatteryId: null,
      connectingBatteryId: null,
      stage: 'idle',
      error: null,
      signingIn: false,
      // The next person to sign in must not inherit the last one's notice.
      signedOut: [],
    });
  },

  dismissSignedOut: () => set({ signedOut: [] }),

  connect: async (batteryId) => {
    if (get().connectingBatteryId) return false;
    logInfo('ble', 'Connect requested', { battery: batteryId });
    set({ connectingBatteryId: batteryId, stage: 'connecting', error: null });
    await wait(700);

    logInfo('ble', 'Authenticating device', { battery: batteryId });
    set({ stage: 'authenticating' });
    await wait(650);

    // The app refuses to treat an unverified peripheral as a KnowyourEV device.
    // With BleSource wired this is the challenge/response against the gateway's
    // secure element; failing it must stop the flow here, before any read.
    set({ stage: 'detecting' });
    await wait(600);

    logInfo('ble', 'Link established', { battery: batteryId });
    set({ stage: 'connected', connectedBatteryId: batteryId, connectingBatteryId: null });

    // The BMS model is only known once it has been detected, so this is the
    // first moment the right profile can be asked for. It is deliberately not
    // awaited: a technician is not kept waiting on the network for a screen
    // that already renders correctly from the bundled profile.
    void useProfileStore.getState().sync();

    // Anything recorded while offline goes up now. Not awaited: the technician
    // is connected to the pack and must not wait on an upload to use the app.
    void useActivityStore.getState().sync(batteryId);

    // Start collecting anything an administrator has queued for this pack.
    // Without this the cloud half of Mode 1 is decorative: changes are issued,
    // reported as collectable, and nothing ever collects them.
    useRemoteChangeStore.getState().start(batteryId);
    return true;
  },

  disconnect: () => {
    const battery = get().connectedBatteryId;
    logWarn('ble', 'Link closed', { battery });

    // The server hands nothing over without a live session, so polling past
    // the link is pointless traffic.
    useRemoteChangeStore.getState().stop();

    // One last push before the link goes. Whatever fails stays queued — these
    // entries are still the only record that a change reached a real pack.
    if (battery) void useActivityStore.getState().sync(battery);

    set({ connectedBatteryId: null, connectingBatteryId: null, stage: 'idle' });
  },
}));

/**
 * A refresh the client could not complete means the session is over. The store
 * learns that here rather than the client importing the store — see api/session.
 */
onSessionExpired(() => {
  logWarn('session', 'Session expired; signing out');
  useSessionStore.setState({
    authenticated: false,
    operator: null,
    connectedBatteryId: null,
    connectingBatteryId: null,
    stage: 'idle',
    error: 'Your session expired. Please sign in again.',
  });
});
