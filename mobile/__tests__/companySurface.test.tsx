import React from 'react';
import { Share } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => ({}),
}));

const mockListUsers = jest.fn();
const mockInvite = jest.fn();
const mockListFleet = jest.fn();
const mockAddPack = jest.fn();
const mockRetire = jest.fn();
const mockReinstate = jest.fn();
const mockCompany = jest.fn();
jest.mock('../src/api/company', () => ({
  ...jest.requireActual('../src/api/company'),
  fetchCompany: (...a: unknown[]) => mockCompany(...a),
  listUsers: (...a: unknown[]) => mockListUsers(...a),
  invitePerson: (...a: unknown[]) => mockInvite(...a),
  listFleet: (...a: unknown[]) => mockListFleet(...a),
  addPack: (...a: unknown[]) => mockAddPack(...a),
  retirePack: (...a: unknown[]) => mockRetire(...a),
  reinstatePack: (...a: unknown[]) => mockReinstate(...a),
}));
jest.mock('../src/api/session', () => ({ api: {}, setTokens: jest.fn(), onSessionExpired: jest.fn() }));

import CompanyHome from '../app/company/index';
import People from '../app/company/people';
import Fleet from '../app/company/fleet';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { useSessionStore } from '../src/store/useSessionStore';

const wrap = (node: React.ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

const TECH = {
  id: 'u-tech', company_id: 'c1', email: 'tech@acme.example', display_name: 'W Khan',
  role: 'user' as const, status: 'active', can_read: 1, can_write: 0, can_location: 1, can_health: 1,
};
const OWNER = { ...TECH, id: 'u-owner', email: 'owner@acme.example', display_name: 'Owner', role: 'company' as const };

const PACK = (over = {}) => ({
  id: 'b1', serial: 'MEB-24S-0114', chemistry: 'LiFePO4', cell_count: 24,
  bms_model: 'JBD SP24S004', status: 'active' as const, lastReading: { soc: 82, recorded_at: Date.now() },
  ...over,
});

const COMPANY = {
  id: 'c1',
  name: 'Acme EV',
  createdAt: 1,
  overview: {
    people: { total: 3, active: 2, invited: 1, administrators: 1 },
    batteries: { total: 5, inService: 4, reportingWithin24Hours: 3 },
    gateways: { total: 2, inService: 1 },
  },
};

beforeEach(() => {
  mockPush.mockClear();
  mockCompany.mockReset().mockResolvedValue(COMPANY);
  mockListUsers.mockReset().mockResolvedValue([OWNER, TECH]);
  mockInvite.mockReset().mockResolvedValue({ id: 'u-new', invitation: { token: 'tok-1', expiresAt: 1 } });
  mockListFleet.mockReset().mockResolvedValue([PACK()]);
  mockAddPack.mockReset().mockResolvedValue({ batteryId: 'b2' });
  mockRetire.mockReset().mockResolvedValue(undefined);
  mockReinstate.mockReset().mockResolvedValue(undefined);
  useSessionStore.setState({ operator: 'Owner', company: 'Acme EV', companyId: 'c1', role: 'company' });
});

describe('the administrator’s home', () => {
  it('shows the totals the server counted', async () => {
    const q = await wrap(<CompanyHome />);
    await waitFor(() => expect(q.getByText('4')).toBeTruthy());
    expect(q.getByText('3 reporting today')).toBeTruthy();
    expect(q.getByText('1 in service')).toBeTruthy();
  });

  it('says how many are invited but not yet in', async () => {
    const q = await wrap(<CompanyHome />);
    await waitFor(() => expect(q.getByText('1 invited · 1 admin')).toBeTruthy());
  });

  it('says how many packs are retired', async () => {
    const q = await wrap(<CompanyHome />);
    await waitFor(() => expect(q.getByText('1 retired')).toBeTruthy());
  });

  /** There is no access state any more: the company simply works. */
  it('shows nothing about access or plans', async () => {
    const q = await wrap(<CompanyHome />);
    await waitFor(() => expect(q.getByText('4')).toBeTruthy());
    expect(q.queryByText(/months left/)).toBeNull();
    expect(q.queryByText(/Access/)).toBeNull();
  });

  /**
   * An administrator staring at zeros must be able to tell an empty company
   * from a request that failed. Swallowing this would make those identical.
   */
  it('names a failure rather than showing zeros', async () => {
    mockCompany.mockRejectedValue(new Error('Network request failed'));
    const q = await wrap(<CompanyHome />);
    await waitFor(() => expect(q.getByText('Network request failed')).toBeTruthy());
    expect(q.queryByText('0')).toBeNull();
  });

  it('offers the company surface from its menu', async () => {
    const q = await wrap(<CompanyHome />);
    await waitFor(() => expect(q.getByLabelText('Open menu')).toBeTruthy());
    await fireEvent.press(q.getByLabelText('Open menu'));
    for (const label of ['People', 'Fleet', 'Gateways', 'Remote support', 'Ledger']) {
      expect(q.getAllByText(label).length).toBeGreaterThan(0);
    }
  });
});

/**
 * Nobody is created with a password. They are invited, the link goes to the
 * share sheet, and the new person sets their own — so nobody else ever sees it.
 */
describe('adding a person', () => {
  it('lists administrators and technicians apart', async () => {
    const q = await wrap(<People />);
    await waitFor(() => expect(q.getByText('W Khan')).toBeTruthy());
    expect(q.getByText('Owner')).toBeTruthy();
    expect(q.getByText('Administrators')).toBeTruthy();
    expect(q.getByText('Technicians')).toBeTruthy();
  });

  it('sends the permissions chosen alongside the person', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    const q = await wrap(<People />);
    await waitFor(() => expect(q.getByLabelText('Add a person')).toBeTruthy());

    await fireEvent.press(q.getByLabelText('Add a person'));
    await fireEvent.changeText(q.getByLabelText('Name'), 'Priya Raman');
    await fireEvent.changeText(q.getByLabelText('Email'), 'priya@acme.example');
    await fireEvent(q.getByLabelText('Change parameters'), 'valueChange', true);
    await fireEvent.press(q.getByText('Add and send invitation'));

    await waitFor(() => expect(mockInvite).toHaveBeenCalled());
    const [, input] = mockInvite.mock.calls[0] as [unknown, { role: string; permissions: Record<string, boolean> }];
    expect(input.role).toBe('user');
    expect(input.permissions).toEqual({ read: true, write: true, location: true, health: true });
    share.mockRestore();
  });

  it('starts with write off', async () => {
    const q = await wrap(<People />);
    await waitFor(() => expect(q.getByLabelText('Add a person')).toBeTruthy());
    await fireEvent.press(q.getByLabelText('Add a person'));
    expect(q.getByLabelText('Change parameters').props.value).toBe(false);
    expect(q.getByLabelText('Read packs').props.value).toBe(true);
  });

  /** An administrator holds everything, so there are no switches to set. */
  it('invites an administrator without permissions', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    const q = await wrap(<People />);
    await waitFor(() => expect(q.getByLabelText('Add a person')).toBeTruthy());

    await fireEvent.press(q.getByLabelText('Add a person'));
    await fireEvent.press(q.getByLabelText('Administrator'));
    expect(q.queryByLabelText('Change parameters')).toBeNull();
    await fireEvent.changeText(q.getByLabelText('Name'), 'Second Admin');
    await fireEvent.changeText(q.getByLabelText('Email'), 'second@acme.example');
    await fireEvent.press(q.getByText('Add and send invitation'));

    await waitFor(() => expect(mockInvite).toHaveBeenCalled());
    const [, input] = mockInvite.mock.calls[0] as [unknown, { role: string; permissions?: unknown }];
    expect(input.role).toBe('company');
    expect(input.permissions).toBeUndefined();
    share.mockRestore();
  });

  /** The link is returned once and must reach the person, not sit on screen. */
  it('hands the invitation to the share sheet rather than showing it', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    const q = await wrap(<People />);
    await waitFor(() => expect(q.getByLabelText('Add a person')).toBeTruthy());

    await fireEvent.press(q.getByLabelText('Add a person'));
    await fireEvent.changeText(q.getByLabelText('Name'), 'P');
    await fireEvent.changeText(q.getByLabelText('Email'), 'p@acme.example');
    await fireEvent.press(q.getByText('Add and send invitation'));

    await waitFor(() => expect(share).toHaveBeenCalled());
    const message = (share.mock.calls[0]![0] as { message: string }).message;
    expect(message).toMatch(/tok-1/);
    expect(message).toMatch(/accept-invite/);
    expect(message).toMatch(/Acme EV/);
    expect(q.queryByText(/tok-1/)).toBeNull();
    share.mockRestore();
  });

  it('will not submit without a usable email', async () => {
    const q = await wrap(<People />);
    await waitFor(() => expect(q.getByLabelText('Add a person')).toBeTruthy());
    await fireEvent.press(q.getByLabelText('Add a person'));
    await fireEvent.changeText(q.getByLabelText('Name'), 'P');
    await fireEvent.changeText(q.getByLabelText('Email'), 'not-an-email');
    expect(q.getByText('Add and send invitation').parent?.props.accessibilityState?.disabled ?? true).toBe(true);
  });
});

describe('looking after the fleet', () => {
  it('separates in-service packs from retired ones', async () => {
    mockListFleet.mockResolvedValue([PACK(), PACK({ id: 'b2', serial: 'MEB-24S-0115', status: 'retired', lastReading: null })]);
    const q = await wrap(<Fleet />);
    await waitFor(() => expect(q.getByText('In service')).toBeTruthy());
    expect(q.getByText('Retired')).toBeTruthy();
    expect(q.getByLabelText('Bring back MEB-24S-0115')).toBeTruthy();
  });

  /** Adding a pack takes a serial; chemistry and cells follow from the profile. */
  it('adds a pack from a serial alone', async () => {
    const q = await wrap(<Fleet />);
    await waitFor(() => expect(q.getByLabelText('Add a pack')).toBeTruthy());

    await fireEvent.press(q.getByLabelText('Add a pack'));
    await fireEvent.changeText(q.getByLabelText('Serial number'), 'MEB-24S-0200');
    await fireEvent.press(q.getByText('Add pack'));

    await waitFor(() => expect(mockAddPack).toHaveBeenCalled());
    const [, input] = mockAddPack.mock.calls[0] as [unknown, { serial: string; cellCount: number; companyId?: string }];
    expect(input.serial).toBe('MEB-24S-0200');
    // The company is the caller's own; the server knows which from the token.
    expect(input.companyId).toBeUndefined();
    expect(input.cellCount).toBeGreaterThan(0);
  });

  it('brings a retired pack back', async () => {
    mockListFleet.mockResolvedValue([PACK({ status: 'retired', lastReading: null })]);
    const q = await wrap(<Fleet />);
    await waitFor(() => expect(q.getByLabelText('Bring back MEB-24S-0114')).toBeTruthy());
    await fireEvent.press(q.getByLabelText('Bring back MEB-24S-0114'));
    await waitFor(() => expect(mockReinstate).toHaveBeenCalledWith({}, 'b1'));
  });

  /** A retired pack's last reading is history, not a state. */
  it('does not show a retired pack’s stale charge', async () => {
    mockListFleet.mockResolvedValue([PACK({ status: 'retired', lastReading: { soc: 82, recorded_at: 1 } })]);
    const q = await wrap(<Fleet />);
    await waitFor(() => expect(q.getByLabelText('Bring back MEB-24S-0114')).toBeTruthy());
    expect(q.queryByText('82%')).toBeNull();
  });

  it('shows a pack with no reading honestly', async () => {
    mockListFleet.mockResolvedValue([PACK({ lastReading: null })]);
    const q = await wrap(<Fleet />);
    await waitFor(() => expect(q.getByText('No reading')).toBeTruthy());
    expect(q.queryByText('0%')).toBeNull();
  });
});
