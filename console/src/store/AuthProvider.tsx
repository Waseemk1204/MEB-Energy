import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiClient, ApiError, type Tokens } from '../api/client';
import {
  clearSession,
  loadSession,
  mayUseConsole,
  saveSession,
  type SessionUser,
  type StoredSession,
} from './session';

/**
 * The console's session, and the one API client every page shares.
 *
 * One client, not one per page, because refresh has to be serialised across
 * the whole console — several panels loading at once will hit their 401s
 * together, and each spending the refresh token would revoke the chain.
 */

export interface AuthState {
  user: SessionUser | null;
  company: { id: string; name: string } | null;
  api: ApiClient;
  signingIn: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<boolean>;
  /** Returns null on success, or a message to show. */
  acceptInvite: (token: string, password: string) => Promise<string | null>;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth used outside AuthProvider');
  return value;
}

interface LoginResponse extends Tokens {
  user: SessionUser;
  company: { id: string; name: string } | null;
}

/**
 * Sign-in failures the console can say something useful about. Everything else
 * — including a wrong password and an unknown address — reads identically, so
 * the form cannot be used to discover which addresses hold accounts.
 */
function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
    if (error.status === 401 || error.status === 400) return 'Email or password is incorrect.';
  }
  return 'Cannot reach KnowyourEV. Check your connection and try again.';
}

export const API_BASE_URL =
  (import.meta.env?.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';

export function AuthProvider({
  children,
  baseUrl = API_BASE_URL,
  fetchImpl,
}: {
  children: ReactNode;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}) {
  const restored = useRef<StoredSession | null>(loadSession()).current;

  const [user, setUser] = useState<SessionUser | null>(restored?.user ?? null);
  const [company, setCompany] = useState(restored?.company ?? null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tokens live in a ref, not in state: the client reads them on every request
  // and a re-render must not be able to hand it a stale pair.
  const tokens = useRef<Tokens | null>(
    restored ? { accessToken: restored.accessToken, refreshToken: restored.refreshToken } : null
  );
  const identity = useRef<{ user: SessionUser; company: StoredSession['company'] } | null>(
    restored ? { user: restored.user, company: restored.company } : null
  );

  const signOut = useCallback(() => {
    tokens.current = null;
    identity.current = null;
    clearSession();
    setUser(null);
    setCompany(null);
  }, []);

  const api = useMemo(
    () =>
      new ApiClient({
        baseUrl,
        fetchImpl,
        getTokens: () => tokens.current,
        onTokens: (next) => {
          tokens.current = next;
          // A refreshed pair must reach storage, or a reload resurrects the
          // spent one and the backend's reuse detection kills the chain.
          if (identity.current) {
            saveSession({
              ...next,
              user: identity.current.user,
              company: identity.current.company,
              issuedAt: Date.now(),
            });
          }
        },
        onSignedOut: () => {
          signOut();
          setError('Your session expired. Please sign in again.');
        },
      }),
    [baseUrl, fetchImpl, signOut]
  );

  const signIn = useCallback(
    async (email: string, password: string): Promise<boolean> => {
      setSigningIn(true);
      setError(null);

      try {
        const result = await api.anon<LoginResponse>('/auth/login', {
          email: email.trim(),
          password,
        });

        if (!mayUseConsole(result.user.role)) {
          // Their credentials are fine; this is not their tool. Said plainly,
          // because a technician staring at an empty console learns nothing.
          setError(
            'This console is for administrators and company owners. Use the KnowyourEV app for field work.'
          );
          setSigningIn(false);
          return false;
        }

        tokens.current = { accessToken: result.accessToken, refreshToken: result.refreshToken };
        identity.current = { user: result.user, company: result.company };
        saveSession({
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          user: result.user,
          company: result.company,
          issuedAt: Date.now(),
        });

        setUser(result.user);
        setCompany(result.company);
        setSigningIn(false);
        return true;
      } catch (caught) {
        setError(messageFor(caught));
        setSigningIn(false);
        return false;
      }
    },
    [api]
  );

  /**
   * Accepting an invitation signs the person straight in — the server returns
   * the same token pair a login would, so there is no reason to make them type
   * the password they just chose.
   */
  const acceptInvite = useCallback(
    async (token: string, password: string): Promise<string | null> => {
      try {
        const result = await api.anon<LoginResponse>('/auth/accept-invite', { token, password });

        // Their password is set either way — the invitation was valid and has
        // been spent. But the console is not their tool, and dropping a
        // technician into it would be worse than telling them so.
        if (!mayUseConsole(result.user.role)) {
          return 'Your password is set. Sign in with the KnowyourEV app — this console is for administrators and company owners.';
        }

        tokens.current = { accessToken: result.accessToken, refreshToken: result.refreshToken };
        identity.current = { user: result.user, company: result.company };
        saveSession({
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          user: result.user,
          company: result.company,
          issuedAt: Date.now(),
        });

        setUser(result.user);
        setCompany(result.company);
        return null;
      } catch (caught) {
        // The server's own wording is the useful part: it distinguishes a
        // password that is too short from a link that no longer works, and
        // says nothing about why the link failed.
        if (caught instanceof ApiError) return caught.message;
        return 'Cannot reach KnowyourEV. Check your connection and try again.';
      }
    },
    [api]
  );

  const value = useMemo(
    () => ({ user, company, api, signingIn, error, signIn, acceptInvite, signOut }),
    [user, company, api, signingIn, error, signIn, acceptInvite, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
