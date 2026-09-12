import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockBack = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: mockBack, canGoBack: () => true }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../src/api/session', () => ({ api: {}, setTokens: jest.fn(), onSessionExpired: jest.fn() }));

const mockListUsers = jest.fn();
const mockListFleet = jest.fn();
const mockEditPerson = jest.fn();
const mockSetPermissions = jest.fn();
const mockRemove = jest.fn();
jest.mock('../src/api/company', () => ({
  ...jest.requireActual('../src/api/company'),
  listUsers: (...a: unknown[]) => mockListUsers(...a),
  listFleet: (...a: unknown[]) => mockListFleet(...a),
  editPerson: (...a: unknown[]) => mockEditPerson(...a),
  setPermissions: (...a: unknown[]) => mockSetPermissions(...a),
  removePerson: (...a: unknown[]) => mockRemove(...a),
}));

const mockListGateways = jest.fn();
const mockRegisterGateway = jest.fn();
const mockSetSecurity = jest.fn();
jest.mock('../src/api/gateways', () => ({
  ...jest.requireActual('../src/api/gateways'),
  listGateways: (...a: unknown[]) => mockListGateways(...a),
  registerGateway: (...a: unknown[]) => mockRegisterGateway(...a),
  setGatewaySecurity: (...a: unknown[]) => mockSetSecurity(...a),
}));

const mockListLedger = jest.fn();
jest.mock('../src/api/ledger', () => ({
  ...jest.requireActual('../src/api/ledger'),
  listLedger: (...a: unknown[]) => mockListLedger(...a),
}));

const mockOpenSession = jest.fn();
const mockIssue = jest.fn();
const mockOnSite = jest.fn();
const mockParams4 = jest.fn();
const mockClose = jest.fn();
jest.mock('../src/api/support', () => ({
  ...jest.requireActual('../src/api/support'),
  openSession: (...a: unknown[]) => mockOpenSession(...a),
  issueCommand: (...a: unknown[]) => mockIssue(...a),
  isSomeoneOnSite: (...a: unknown[]) => mockOnSite(...a),
  parametersFor: (...a: unknown[]) => mockParams4(...a),
  closeSession: (...a: unknown[]) => mockClose(...a),
}));

const mockAccept = jest.fn();
jest.mock('../src/api/invitations', () => ({
  ...jest.requireActual('../src/api/invitations'),
  acceptInvitation: (...a: unknown[]) => mockAccept(...a),
}));

import Gateways from '../app/company/gateways';
import Ledger from '../app/company/ledger';
import RemoteSupport from '../app/company/support';
import AcceptInvite from '../app/accept-invite';
import UserDetail from '../app/users/[id]';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { useSessionStore } from '../src/store/useSessionStore';

const wrap = (node: React.ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

const PACK = {
  id: 'b1', serial: 'MEB-24S-0114', chemistry: 'LiFePO4', cell_count: 24,
  bms_model: 'JBD SP24S004', status: 'active' as const, lastReading: null,
};
const GATEWAY = (over = {}) => ({
  id: 'g1', serial: 'GW-0001', hardware_revision: 'HW 1.0', firmware_version: 'FW 1.2.4',
  assigned_battery_id: 'b1', security_status: 'valid' as const, last_seen_at: null, created_at: 1,
  ...over,
});
const TECH = {
  id: 'u-tech', company_id: 'c1', email: 'tech@acme.example', display_name: 'W Khan',
  role: 'user' as const, status: 'active', can_read: 1, can_write: 0, can_location: 1, can_health: 1,
};
const ADMIN = { ...TECH, id: 'u-admin', email: 'admin@acme.example', display_name: 'Admin', role: 'company' as const };

beforeEach(() => {
  mockPush.mockClear();
  mockReplace.mockClear();
  mockBack.mockClear();
  mockParams = {};
  mockListUsers.mockReset().mockResolvedValue([ADMIN, TECH]);
  mockListFleet.mockReset().mockResolvedValue([PACK]);
  mockEditPerson.mockReset().mockResolvedValue(undefined);
  mockSetPermissions.mockReset().mockImplementation(async (_api, _id, patch: Record<string, boolean>) => ({
    read: true, write: false, location: true, health: true, ...patch,
  }));
  mockRemove.mockReset().mockResolvedValue({ removed: true });
  mockListGateways.mockReset().mockResolvedValue([GATEWAY()]);
  mockRegisterGateway.mockReset().mockResolvedValue({ id: 'g2' });
  mockSetSecurity.mockReset().mockResolvedValue(undefined);
  mockListLedger.mockReset().mockResolvedValue([]);
  mockOpenSession.mockReset().mockResolvedValue('ss-1');
  mockIssue.mockReset().mockResolvedValue({ commandId: 'c1', disposition: 'queued', auditId: 'a1' });
  mockOnSite.mockReset().mockResolvedValue(false);
  mockParams4.mockReset().mockResolvedValue([
    { parameterKey: 'cell_ovp', displayName: 'Cell over-voltage', unit: 'V', minValue: 3.5, maxValue: 3.8,
      dangerLevel: 'Critical', writable: true, requiresAdmin: false, requiresConfirmation: true },
  ]);
  mockClose.mockReset().mockResolvedValue(0);
  mockAccept.mockReset();
  useSessionStore.setState({ operator: 'Admin', company: 'Acme EV', companyId: 'c1', role: 'company', authenticated: true });
});

describe('gateways', () => {
  it('lists each gateway with its security state and pack', async () => {
    const q = await wrap(<Gateways />);
    await waitFor(() => expect(q.getByText('GW-0001')).toBeTruthy());
    expect(q.getByText('In service')).toBeTruthy();
    expect(q.getByText(/MEB-24S-0114/)).toBeTruthy();
  });

  it('registers one from its serial, hardware and firmware', async () => {
    const q = await wrap(<Gateways />);
    await waitFor(() => expect(q.getByLabelText('Register a gateway')).toBeTruthy());
    await fireEvent.press(q.getByLabelText('Register a gateway'));
    await fireEvent.changeText(q.getByLabelText('Gateway serial'), 'GW-0002');
    await fireEvent.changeText(q.getByLabelText('Hardware revision'), 'HW 1.1');
    await fireEvent.changeText(q.getByLabelText('Firmware version'), 'FW 2.0');
    await fireEvent.press(q.getByText('Register gateway'));
    await waitFor(() => expect(mockRegisterGateway).toHaveBeenCalled());
    const [, input] = mockRegisterGateway.mock.calls[0] as [unknown, Record<string, string>];
    expect(input).toEqual({ serial: 'GW-0002', hardwareRevision: 'HW 1.1', firmwareVersion: 'FW 2.0' });
  });

  /** Quarantine is the reversible one, so it needs no confirmation. */
  it('quarantines a gateway and says what that means', async () => {
    const q = await wrap(<Gateways />);
    await waitFor(() => expect(q.getByText('Quarantine')).toBeTruthy());
    await fireEvent.press(q.getByText('Quarantine'));
    await waitFor(() => expect(mockSetSecurity).toHaveBeenCalledWith({}, 'g1', 'quarantined'));
    await waitFor(() => expect(q.getByText(/GW-0001: The app will refuse this gateway/)).toBeTruthy());
  });

  it('offers a revoked gateway nothing to undo', async () => {
    mockListGateways.mockResolvedValue([GATEWAY({ security_status: 'revoked' })]);
    const q = await wrap(<Gateways />);
    await waitFor(() => expect(q.getByText('Permanently out of service')).toBeTruthy());
    expect(q.queryByText('Return to service')).toBeNull();
  });
});

describe('the ledger', () => {
  const EVENT = (over = {}) => ({
    id: 'e1', actor_user_id: 'u-tech', actor_role: 'user', battery_id: 'b1', parameter_key: 'cell_ovp',
    old_value: '3.750 V', new_value: '3.800 V', reason: 'Vendor bulletin', source: 'local', result: 'success',
    support_session_id: null, occurred_at: Date.now() - 60_000, recorded_at: Date.now() - 60_000, seq: 1,
    ...over,
  });
  const fromRow = jest.requireActual('../src/api/ledger').fromRow as (r: unknown) => unknown;

  it('shows refusals rather than filtering them out', async () => {
    mockListLedger.mockResolvedValue([fromRow(EVENT()), fromRow(EVENT({ id: 'e2', result: 'rejected' }))]);
    const q = await wrap(<Ledger />);
    // Each label also appears once as a filter chip, hence "all".
    await waitFor(() => expect(q.getAllByText('Applied').length).toBe(2));
    expect(q.getAllByText('Refused').length).toBe(2);
  });

  it('names the pack and the person, not their ids', async () => {
    mockListLedger.mockResolvedValue([fromRow(EVENT())]);
    const q = await wrap(<Ledger />);
    await waitFor(() => expect(q.getByText(/MEB-24S-0114 · W Khan · On site/)).toBeTruthy());
  });

  /** Filtering on the newest page locally would misreport older packs as unchanged. */
  it('sends the pack filter to the server', async () => {
    const q = await wrap(<Ledger />);
    await waitFor(() => expect(q.getByText('MEB-24S-0114')).toBeTruthy());
    await fireEvent.press(q.getByText('MEB-24S-0114'));
    await waitFor(() =>
      expect(mockListLedger).toHaveBeenLastCalledWith({}, expect.objectContaining({ batteryId: 'b1' }))
    );
  });

  it('says when an event was uploaded long after it happened', async () => {
    mockListLedger.mockResolvedValue([
      fromRow(EVENT({ occurred_at: Date.now() - 3 * 3_600_000, recorded_at: Date.now() - 60_000 })),
    ]);
    const q = await wrap(<Ledger />);
    await waitFor(() => expect(q.getByText(/uploaded/)).toBeTruthy());
  });
});

/**
 * Issuing a change is not making a change. The screen never shows a tick; it
 * says whether somebody can collect the change now or it is waiting.
 */
describe('remote support', () => {
  const openOn = async () => {
    const q = await wrap(<RemoteSupport />);
    await waitFor(() => expect(q.getByText('MEB-24S-0114')).toBeTruthy());
    await fireEvent.press(q.getByText('MEB-24S-0114'));
    await waitFor(() => expect(q.getByText('Open support session')).toBeTruthy());
    await fireEvent.press(q.getByText('Open support session'));
    await waitFor(() => expect(q.getByText('Cell over-voltage')).toBeTruthy());
    return q;
  };

  it('states presence before anything can be issued', async () => {
    const q = await wrap(<RemoteSupport />);
    await waitFor(() => expect(q.getByText('MEB-24S-0114')).toBeTruthy());
    await fireEvent.press(q.getByText('MEB-24S-0114'));
    await waitFor(() => expect(q.getByText('Nobody is linked to this pack')).toBeTruthy());
  });

  it('will not issue without a reason', async () => {
    const q = await openOn();
    await fireEvent.press(q.getByText('Cell over-voltage'));
    await fireEvent.changeText(q.getByLabelText('New value for Cell over-voltage'), '3.7');
    await fireEvent.changeText(q.getByLabelText('Reason'), 'short');
    await fireEvent.press(q.getByText('Issue change'));
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it('says queued, not done, when nobody is on site', async () => {
    const q = await openOn();
    await fireEvent.press(q.getByText('Cell over-voltage'));
    await fireEvent.changeText(q.getByLabelText('New value for Cell over-voltage'), '3.7');
    await fireEvent.changeText(q.getByLabelText('Reason'), 'Vendor bulletin 2026-114');
    await fireEvent.press(q.getByText('Issue change'));
    await waitFor(() => expect(mockIssue).toHaveBeenCalledWith({}, 'ss-1', expect.objectContaining({ value: 3.7 })));
    await waitFor(() => expect(q.getByText(/^Queued\./)).toBeTruthy());
    expect(q.queryByText(/applied|done|✓/i)).toBeNull();
  });

  it('warns about an out-of-range value without enforcing it', async () => {
    const q = await openOn();
    await fireEvent.press(q.getByText('Cell over-voltage'));
    await fireEvent.changeText(q.getByLabelText('New value for Cell over-voltage'), '9');
    expect(q.getByText(/Outside the permitted range/)).toBeTruthy();
  });

  it('says what Force Push does and does not do', async () => {
    const q = await openOn();
    await fireEvent.press(q.getByText('Cell over-voltage'));
    await fireEvent(q.getByLabelText('Force Push'), 'valueChange', true);
    expect(q.getByText(/does not deliver it any sooner/)).toBeTruthy();
  });
});

describe('accepting an invitation', () => {
  it('says so when the link has no token', async () => {
    const q = await wrap(<AcceptInvite />);
    expect(q.getByText(/missing its invitation code/)).toBeTruthy();
  });

  it('will not submit mismatched passwords', async () => {
    mockParams = { token: 'tok-1' };
    const q = await wrap(<AcceptInvite />);
    await fireEvent.changeText(q.getByLabelText(/^Password/), 'a-long-enough-password');
    await fireEvent.changeText(q.getByLabelText('Type it again'), 'a-different-password');
    expect(q.getByText('The two passwords do not match.')).toBeTruthy();
    await fireEvent.press(q.getByText('Set password and sign in'));
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it('sets the password and adopts the session it gets back', async () => {
    mockParams = { token: 'tok-1' };
    mockAccept.mockResolvedValue({
      accessToken: 'a', refreshToken: 'r', expiresAt: 1,
      user: { id: 'u', email: 'new@acme.example', displayName: 'New', role: 'user' },
      company: { id: 'c1', name: 'Acme EV' },
    });
    useSessionStore.setState({ authenticated: false });
    const q = await wrap(<AcceptInvite />);
    await fireEvent.changeText(q.getByLabelText(/^Password/), 'a-long-enough-password');
    await fireEvent.changeText(q.getByLabelText('Type it again'), 'a-long-enough-password');
    await fireEvent.press(q.getByText('Set password and sign in'));
    await waitFor(() => expect(mockAccept).toHaveBeenCalledWith({}, 'tok-1', 'a-long-enough-password'));
    await waitFor(() => expect(useSessionStore.getState().authenticated).toBe(true));
    expect(useSessionStore.getState().operator).toBe('New');
    expect(useSessionStore.getState().role).toBe('user');
  });

  it('shows the server’s refusal', async () => {
    mockParams = { token: 'tok-1' };
    mockAccept.mockRejectedValue(new Error('That invitation is not valid or has already been used.'));
    const q = await wrap(<AcceptInvite />);
    await fireEvent.changeText(q.getByLabelText(/^Password/), 'a-long-enough-password');
    await fireEvent.changeText(q.getByLabelText('Type it again'), 'a-long-enough-password');
    await fireEvent.press(q.getByText('Set password and sign in'));
    await waitFor(() => expect(q.getByText(/already been used/)).toBeTruthy());
  });
});

describe('one person', () => {
  it('shows an administrator holds everything, with no switches', async () => {
    mockParams = { id: 'u-admin' };
    const q = await wrap(<UserDetail />);
    await waitFor(() => expect(q.getByText('Everything.')).toBeTruthy());
    expect(q.queryByLabelText('Change parameters')).toBeNull();
  });

  it('writes a permission through on the switch', async () => {
    mockParams = { id: 'u-tech' };
    const q = await wrap(<UserDetail />);
    await waitFor(() => expect(q.getByLabelText('Change parameters')).toBeTruthy());
    await fireEvent(q.getByLabelText('Change parameters'), 'valueChange', true);
    await waitFor(() => expect(mockSetPermissions).toHaveBeenCalledWith({}, 'u-tech', { write: true }));
  });

  it('saves an edited name and email', async () => {
    mockParams = { id: 'u-tech' };
    const q = await wrap(<UserDetail />);
    await waitFor(() => expect(q.getByLabelText('Edit name and email')).toBeTruthy());
    await fireEvent.press(q.getByLabelText('Edit name and email'));
    await fireEvent.changeText(q.getByLabelText('Name'), 'Wasim Khan');
    await fireEvent.press(q.getByText('Save details'));
    await waitFor(() => expect(mockEditPerson).toHaveBeenCalledWith({}, 'u-tech', { displayName: 'Wasim Khan' }));
    // In the header and in the details row.
    await waitFor(() => expect(q.getAllByText('Wasim Khan').length).toBeGreaterThan(0));
  });

  it('says when a person is not available', async () => {
    mockParams = { id: 'u-nobody' };
    const q = await wrap(<UserDetail />);
    await waitFor(() => expect(q.getByText('That user is not available.')).toBeTruthy());
  });
});
