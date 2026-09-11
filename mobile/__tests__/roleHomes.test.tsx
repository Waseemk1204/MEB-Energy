import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));

const mockOverview = jest.fn();
jest.mock('../src/api/platform', () => ({
  platformOverview: (...args: unknown[]) => mockOverview(...args),
}));
jest.mock('../src/api/session', () => ({ api: {}, setTokens: jest.fn(), onSessionExpired: jest.fn() }));

import AdminHome from '../app/admin';
import CompanyHome from '../app/company';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { useSessionStore } from '../src/store/useSessionStore';

/**
 * The two screens a sign-in can now land on, besides the technician's.
 *
 * These assert what the screens *say*, not what they permit: every figure here
 * comes from the server, and every route they offer is checked there again.
 */

const wrap = (node: React.ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

const OVERVIEW = {
  companies: { total: 12, withAccess: 9, lapsingWithin30Days: 2 },
  users: { total: 48, active: 44 },
  batteries: { total: 210, reportingWithin24Hours: 173 },
  gateways: { total: 16, inService: 15 },
};

beforeEach(() => {
  mockPush.mockClear();
  mockOverview.mockReset().mockResolvedValue(OVERVIEW);
  useSessionStore.setState({ operator: 'Ops', company: 'Aurora Fleet', role: 'admin' });
});

describe('the administrator’s overview', () => {
  it('shows the totals the server counted', async () => {
    const q = await wrap(<AdminHome />);
    await waitFor(() => expect(q.getByText('12')).toBeTruthy());
    expect(q.getByText('48')).toBeTruthy();
    expect(q.getByText('210')).toBeTruthy();
    expect(q.getByText('16')).toBeTruthy();
  });

  it('says what each total is measuring', async () => {
    const q = await wrap(<AdminHome />);
    await waitFor(() => expect(q.getByText('9 with access')).toBeTruthy());
    expect(q.getByText('173 reporting today')).toBeTruthy();
    expect(q.getByText('15 in service')).toBeTruthy();
  });

  /**
   * The only figure that asks somebody to act, so it is lifted out of the row
   * of numbers rather than sitting among them.
   */
  it('raises lapsing access above the rest', async () => {
    const q = await wrap(<AdminHome />);
    await waitFor(() => expect(q.getByText('2 companies lose access within 30 days')).toBeTruthy());
  });

  it('says it in the singular when only one is lapsing', async () => {
    mockOverview.mockResolvedValue({
      ...OVERVIEW,
      companies: { ...OVERVIEW.companies, lapsingWithin30Days: 1 },
    });
    const q = await wrap(<AdminHome />);
    await waitFor(() => expect(q.getByText('1 company loses access within 30 days')).toBeTruthy());
  });

  it('shows nothing about lapsing when nothing is', async () => {
    mockOverview.mockResolvedValue({
      ...OVERVIEW,
      companies: { ...OVERVIEW.companies, lapsingWithin30Days: 0 },
    });
    const q = await wrap(<AdminHome />);
    await waitFor(() => expect(q.getByText('12')).toBeTruthy());
    expect(q.queryByText(/lose access within 30 days/)).toBeNull();
  });

  /**
   * An administrator staring at zeros must be able to tell an empty platform
   * from a request that failed. Swallowing this would make those identical.
   */
  it('names a failure rather than showing zeros', async () => {
    mockOverview.mockRejectedValue(new Error('Network request failed'));
    const q = await wrap(<AdminHome />);
    await waitFor(() => expect(q.getByText('Network request failed')).toBeTruthy());
    expect(q.queryByText('0')).toBeNull();
  });
});

describe('the company owner’s home', () => {
  beforeEach(() => {
    useSessionStore.setState({ operator: 'Priya Raman', company: 'Aurora Fleet', role: 'company' });
  });

  it('is headed with their own company', async () => {
    const q = await wrap(<CompanyHome />);
    expect(q.getByText('Aurora Fleet')).toBeTruthy();
  });

  it('offers the fleet rather than dropping them into a pack', async () => {
    const q = await wrap(<CompanyHome />);
    expect(q.getByText('Batteries')).toBeTruthy();
    expect(q.getByText('Gateways')).toBeTruthy();
  });

  /**
   * Saying what is not here yet beats showing a control that does nothing.
   */
  it('is honest about what has not been built', async () => {
    const q = await wrap(<CompanyHome />);
    expect(q.getByText('Coming next')).toBeTruthy();
  });
});
