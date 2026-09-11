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
const mockEntitlement = jest.fn();
jest.mock('../src/api/admin', () => ({
  ...jest.requireActual('../src/api/admin'),
  listUsers: (...a: unknown[]) => mockListUsers(...a),
  invitePerson: (...a: unknown[]) => mockInvite(...a),
  listFleet: (...a: unknown[]) => mockListFleet(...a),
  addPack: (...a: unknown[]) => mockAddPack(...a),
  retirePack: (...a: unknown[]) => mockRetire(...a),
  reinstatePack: (...a: unknown[]) => mockReinstate(...a),
  entitlementOf: (...a: unknown[]) => mockEntitlement(...a),
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

beforeEach(() => {
  mockPush.mockClear();
  mockListUsers.mockReset().mockResolvedValue([OWNER, TECH]);
  mockInvite.mockReset().mockResolvedValue({ id: 'u-new', invitation: { token: 'tok-1', expiresAt: 1 } });
  mockListFleet.mockReset().mockResolvedValue([PACK()]);
  mockAddPack.mockReset().mockResolvedValue({ batteryId: 'b2' });
  mockRetire.mockReset().mockResolvedValue(undefined);
  mockReinstate.mockReset().mockResolvedValue(undefined);
  mockEntitlement.mockReset().mockResolvedValue({
    code: 'ok', ok: true, expiresAt: Date.now() + 200 * 24 * 3600 * 1000,
    seats: { used: 2, limit: null }, devices: { used: 1, limit: 2 },
    sessionDevices: { used: 1, limit: 2 }, batteries: { used: 1, limit: null },
  });
  useSessionStore.setState({ operator: 'Owner', company: 'Acme EV', companyId: 'c1', role: 'company' });
});

describe('the company owner’s home', () => {
  it('shows their access state up front', async () => {
    const q = await wrap(<CompanyHome />);
    await waitFor(() => expect(q.getByText('Active')).toBeTruthy());
    expect(q.getByText(/months left/)).toBeTruthy();
  });

  /** The owner is not "their people". */
  it('counts technicians, not the owner', async () => {
    const q = await wrap(<CompanyHome />);
    await waitFor(() => expect(q.getByText('1')).toBeTruthy());
  });

  it('says how many packs are in service and how many retired', async () => {
    mockListFleet.mockResolvedValue([PACK(), PACK({ id: 'b2', status: 'retired' })]);
    const q = await wrap(<CompanyHome />);
    await waitFor(() => expect(q.getByText('1 in service · 1 retired')).toBeTruthy());
  });
});

/**
 * Nobody is created with a password. They are invited, the link goes to the
 * share sheet, and the new person sets their own — so nobody else ever sees it.
 */
describe('adding a person', () => {
  it('lists the technicians, not the owner', async () => {
    const q = await wrap(<People />);
    await waitFor(() => expect(q.getByText('W Khan')).toBeTruthy());
    expect(q.queryByText('Owner')).toBeNull();
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
    const [, input] = mockInvite.mock.calls[0] as [unknown, { permissions: Record<string, boolean> }];
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
    expect((share.mock.calls[0]![0] as { message: string }).message).toMatch(/tok-1/);
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
    const [, input] = mockAddPack.mock.calls[0] as [unknown, { serial: string; cellCount: number; companyId: string }];
    expect(input.serial).toBe('MEB-24S-0200');
    expect(input.companyId).toBe('c1');
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
