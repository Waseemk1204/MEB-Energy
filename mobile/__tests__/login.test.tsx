import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));

/*
 * The sign-in tests below used to pass without any of this, because
 * OFFLINE_AUTH was on by default and `signIn` returned a fabricated session
 * without touching the network. They were testing the dev bypass, not the
 * screen. With the bypass off they exercise the real path, and the server it
 * talks to is stubbed here rather than assumed away.
 */
jest.mock('../src/diagnostics/fieldLog', () => ({ logWarn: jest.fn(), logInfo: jest.fn() }));
jest.mock('../src/store/sessionStorage', () => ({
  saveSession: jest.fn(async () => undefined),
  clearSession: jest.fn(async () => undefined),
  loadSession: jest.fn(async () => null),
}));
jest.mock('../src/api/session', () => ({
  api: {},
  setTokens: jest.fn(),
  onSessionExpired: jest.fn(),
}));
jest.mock('../src/api/auth', () => ({
  ...jest.requireActual('../src/api/auth'),
  login: jest.fn(async (_client: unknown, email: string) => ({
    accessToken: 'a',
    refreshToken: 'r',
    user: { id: 'u', email, displayName: '', role: 'user' as const },
    company: { id: 'c', name: 'Aurora Fleet' },
    signedOut: [],
  })),
}));

import Login from '../app/login';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { useSessionStore } from '../src/store/useSessionStore';
import { profile } from '../src/bms/capabilityProfile';

const wrap = () => render(<ThemeProvider><Login /></ThemeProvider>);
type Queries = Awaited<ReturnType<typeof wrap>>;

const signInButton = (q: Queries) =>
  q.getAllByRole('button').find((b) => b.props.accessibilityLabel === 'Sign in')!;

beforeEach(() => {
  useSessionStore.setState({
    hydrated: true,
    authenticated: false,
    operator: null,
    connectedBatteryId: null,
  });
});

describe('form gating', () => {
  it('opens with sign in disabled', async () => {
    const q = await wrap();
    expect(signInButton(q).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('stays disabled with only an email', async () => {
    const q = await wrap();
    await fireEvent.changeText(q.getByLabelText('Email'), 'w.khan@aurorafleet.example');
    expect(signInButton(q).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('stays disabled with only a password', async () => {
    const q = await wrap();
    await fireEvent.changeText(q.getByLabelText('Password'), 'correct-horse');
    expect(signInButton(q).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('stays disabled for an email too short to be real', async () => {
    const q = await wrap();
    await fireEvent.changeText(q.getByLabelText('Email'), 'ab');
    await fireEvent.changeText(q.getByLabelText('Password'), 'correct-horse');
    expect(signInButton(q).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('enables once both fields are filled', async () => {
    const q = await wrap();
    await fireEvent.changeText(q.getByLabelText('Email'), 'w.khan@aurorafleet.example');
    await fireEvent.changeText(q.getByLabelText('Password'), 'correct-horse');
    expect(signInButton(q).props.accessibilityState).toMatchObject({ disabled: false });
  });
});

describe('signing in', () => {
  it('records the operator on the session', async () => {
    const q = await wrap();
    await fireEvent.changeText(q.getByLabelText('Email'), 'w.khan@aurorafleet.example');
    await fireEvent.changeText(q.getByLabelText('Password'), 'correct-horse');
    await fireEvent.press(signInButton(q));

    await waitFor(() => expect(useSessionStore.getState().authenticated).toBe(true));
    expect(useSessionStore.getState().operator).toBe('w.khan@aurorafleet.example');
  });

  /** The entry-flow guard routes onward; the screen must not also navigate. */
  it('does not establish a battery link by signing in', async () => {
    const q = await wrap();
    await fireEvent.changeText(q.getByLabelText('Email'), 'w.khan@aurorafleet.example');
    await fireEvent.changeText(q.getByLabelText('Password'), 'correct-horse');
    await fireEvent.press(signInButton(q));

    await waitFor(() => expect(useSessionStore.getState().authenticated).toBe(true));
    expect(useSessionStore.getState().connectedBatteryId).toBeNull();
  });
});

describe('the screen itself', () => {
  it('masks the password field', async () => {
    const q = await wrap();
    expect(q.getByLabelText('Password').props.secureTextEntry).toBe(true);
  });

  it('does not mask the email field', async () => {
    const q = await wrap();
    expect(q.getByLabelText('Email').props.secureTextEntry).toBeFalsy();
  });

  it('names the supported BMS rather than claiming to support any', async () => {
    const q = await wrap();
    expect(q.getByText(new RegExp(`${profile.vendor} ${profile.bmsModel}`))).toBeTruthy();
  });

  /** Full-bleed leather, no instrumentation — this is not a telemetry screen. */
  it('shows no gauges', async () => {
    const q = await wrap();
    expect(q.queryByText('SOC')).toBeNull();
    expect(q.queryByText('Pack Current')).toBeNull();
  });
});
