import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => ({ id: 'u-tech' }),
}));

const mockListUsers = jest.fn();
const mockSetPermissions = jest.fn();
const mockSetStatus = jest.fn();
jest.mock('../src/api/admin', () => ({
  ...jest.requireActual('../src/api/admin'),
  listUsers: (...a: unknown[]) => mockListUsers(...a),
  setPermissions: (...a: unknown[]) => mockSetPermissions(...a),
  setUserStatus: (...a: unknown[]) => mockSetStatus(...a),
}));
jest.mock('../src/api/session', () => ({ api: {}, setTokens: jest.fn(), onSessionExpired: jest.fn() }));

import UserDetail from '../app/users/[id]';
import { SideMenu } from '../src/ui/SideMenu';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { useSessionStore } from '../src/store/useSessionStore';

const wrap = (node: React.ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

const TECH = {
  id: 'u-tech',
  company_id: 'c1',
  email: 'tech@acme.example',
  display_name: 'W Khan',
  role: 'user' as const,
  status: 'active',
  can_read: 1,
  can_write: 0,
  can_location: 1,
  can_health: 1,
};

beforeEach(() => {
  mockPush.mockClear();
  mockListUsers.mockReset().mockResolvedValue([TECH]);
  mockSetPermissions.mockReset();
  mockSetStatus.mockReset().mockResolvedValue(undefined);
  useSessionStore.setState({ operator: 'Ops', company: 'Acme', role: 'admin' });
});

/**
 * The permissions screen writes each switch straight through. A Save button
 * would create a state where the switch says one thing and the server believes
 * another — on a screen whose whole job is saying what somebody may do, that
 * is the wrong failure to allow.
 */
describe('editing what a user may do', () => {
  it('shows the four permissions as they stand', async () => {
    const q = await wrap(<UserDetail />);
    await waitFor(() => expect(q.getByLabelText('Read packs')).toBeTruthy());
    expect(q.getByLabelText('Read packs').props.value).toBe(true);
    expect(q.getByLabelText('Change parameters').props.value).toBe(false);
    expect(q.getByLabelText('See location').props.value).toBe(true);
    expect(q.getByLabelText('See health history').props.value).toBe(true);
  });

  it('writes a change immediately, without a save step', async () => {
    mockSetPermissions.mockResolvedValue({ read: true, write: true, location: true, health: true });
    const q = await wrap(<UserDetail />);
    await waitFor(() => expect(q.getByLabelText('Change parameters')).toBeTruthy());

    await fireEvent(q.getByLabelText('Change parameters'), 'valueChange', true);

    await waitFor(() => expect(mockSetPermissions).toHaveBeenCalledWith({}, 'u-tech', { write: true }));
    expect(q.queryByText('Save')).toBeNull();
  });

  /**
   * The switch moves at once so it follows the finger, then goes back if the
   * server disagrees. A control that silently kept a value the server rejected
   * would be lying about who can do what.
   */
  it('puts the switch back when the server refuses', async () => {
    mockSetPermissions.mockRejectedValue(new Error('You cannot change your own permissions'));
    const q = await wrap(<UserDetail />);
    await waitFor(() => expect(q.getByLabelText('Change parameters')).toBeTruthy());

    await fireEvent(q.getByLabelText('Change parameters'), 'valueChange', true);

    await waitFor(() =>
      expect(q.getByText('You cannot change your own permissions')).toBeTruthy()
    );
    expect(q.getByLabelText('Change parameters').props.value).toBe(false);
  });

  it('says when a change lands', async () => {
    const q = await wrap(<UserDetail />);
    await waitFor(() =>
      expect(
        q.getByText(/take effect on this person’s next request, not at their next\s+sign-in/)
      ).toBeTruthy()
    );
  });

  /** Suspension is not a permission, and sits apart from them. */
  it('offers suspension separately from the permissions', async () => {
    const q = await wrap(<UserDetail />);
    await waitFor(() => expect(q.getByLabelText('Account active')).toBeTruthy());
    expect(q.getByLabelText('Account active').props.value).toBe(true);
  });

  it('names a user it cannot find rather than showing empty switches', async () => {
    mockListUsers.mockResolvedValue([]);
    const q = await wrap(<UserDetail />);
    await waitFor(() => expect(q.getByText('That user is not available.')).toBeTruthy());
    expect(q.queryByLabelText('Read packs')).toBeNull();
  });
});

/**
 * Somebody who could grant themselves write would make the whole setting
 * decorative. The server refuses it; this stops the screen offering it.
 */
describe('your own permissions', () => {
  it('are shown but not editable', async () => {
    useSessionStore.setState({ operator: 'W Khan' });
    const q = await wrap(<UserDetail />);
    await waitFor(() => expect(q.getByLabelText('Read packs')).toBeTruthy());
    expect(q.getByLabelText('Read packs').props.disabled).toBe(true);
    expect(q.getByText(/shown but not editable/)).toBeTruthy();
  });
});

describe('the side menu', () => {
  const items = [
    { label: 'Company management', onPress: jest.fn() },
    { label: 'Batteries', onPress: jest.fn() },
  ];

  it('renders nothing at all while closed', async () => {
    const q = await wrap(
      <SideMenu open={false} onClose={jest.fn()} title="Administration" items={items} />
    );
    expect(q.queryByText('Company management')).toBeNull();
  });

  it('lists its items when open', async () => {
    const q = await wrap(
      <SideMenu open onClose={jest.fn()} title="Administration" items={items} />
    );
    expect(q.getByText('Company management')).toBeTruthy();
    expect(q.getByText('Batteries')).toBeTruthy();
  });

  /** A menu left standing over the screen it navigated to feels stuck. */
  it('closes itself before navigating', async () => {
    const onClose = jest.fn();
    const onPress = jest.fn();
    const q = await wrap(
      <SideMenu open onClose={onClose} title="Administration" items={[{ label: 'Go', onPress }]} />
    );

    await fireEvent.press(q.getByText('Go'));

    expect(onClose).toHaveBeenCalled();
    expect(onPress).toHaveBeenCalled();
  });

  it('closes when the scrim is tapped', async () => {
    const onClose = jest.fn();
    const q = await wrap(
      <SideMenu open onClose={onClose} title="Administration" items={items} />
    );
    await fireEvent.press(q.getAllByLabelText('Close menu')[0]!);
    expect(onClose).toHaveBeenCalled();
  });

  /**
   * Without this a screen reader walks past the menu into the page underneath,
   * which for a sighted user is behind a dark scrim.
   */
  it('hides what is behind it from a screen reader', async () => {
    const q = await wrap(
      <SideMenu open onClose={jest.fn()} title="Administration" items={items} />
    );
    expect(q.getByTestId('side-menu').props.accessibilityViewIsModal).toBe(true);
  });
});
