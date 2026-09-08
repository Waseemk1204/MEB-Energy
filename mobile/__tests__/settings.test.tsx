import React from 'react';
import { render } from '@testing-library/react-native';

const mockPush = jest.fn();
const mockReplace = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn(), canGoBack: () => true }),
}));

import Settings from '../app/(tabs)/settings';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { useSettingsStore } from '../src/store/useSettingsStore';
import { useSessionStore } from '../src/store/useSessionStore';
import { useSecurityStore } from '../src/store/useSecurityStore';
import { GROUP_TITLES, profile } from '../src/bms/capabilityProfile';

const wrap = () => render(<ThemeProvider><Settings /></ThemeProvider>);
type Queries = Awaited<ReturnType<typeof wrap>>;

beforeEach(() => {
  mockPush.mockClear();
  mockReplace.mockClear();
  useSettingsStore.setState({
    values: Object.fromEntries(profile.parameters.map((p) => [p.parameter_key, p.value])),
  });
  useSessionStore.setState({
    authenticated: true,
    operator: 'w.khan@aurorafleet.example',
    company: 'Aurora Fleet',
    connectedBatteryId: 'BAT-00042',
  });
  useSecurityStore.setState({ hydrated: true, pinSet: false, pinSetAt: null });
});

/**
 * Settings is generated entirely from the capability profile. These assertions
 * are what make "no vendor-specific app code" checkable rather than aspirational.
 */
describe('generated from the capability profile', () => {
  it('renders every parameter in the profile', async () => {
    const q = await wrap();
    for (const param of profile.parameters) {
      expect(q.getAllByText(param.display_name).length).toBeGreaterThan(0);
    }
  });

  it('renders a heading for every group', async () => {
    const q = await wrap();
    for (const title of Object.values(GROUP_TITLES)) {
      expect(q.getByText(title)).toBeTruthy();
    }
  });

  it('shows each parameter at its current value', async () => {
    const q = await wrap();
    expect(q.getByText('3.750 V')).toBeTruthy(); // cell_ovp
    expect(q.getByText('2.200 V')).toBeTruthy(); // cell_uvp
  });

  it('reflects a value changed by a write, not the datasheet default', async () => {
    useSettingsStore.setState({
      values: { ...useSettingsStore.getState().values, cell_ovp: 3.8 },
    });
    const q = await wrap();
    expect(q.getByText('3.800 V')).toBeTruthy();
    expect(q.queryByText('3.750 V')).toBeNull();
  });
});

/**
 * Over-current thresholds are fixed by the board's continuous-current rating.
 * They must read as stated facts, never as controls that appear broken.
 */
describe('read-only parameters', () => {
  const fixed = profile.parameters.filter((p) => !p.writable);

  it('marks every non-writable parameter with a reason tag', async () => {
    const q = await wrap();
    expect(q.getAllByText('SKU-fixed')).toHaveLength(fixed.length);
  });

  it('shows the datasheet tolerance band rather than a bare number', async () => {
    const q = await wrap();
    // Charge OCP and 1st-stage discharge OCP share the same band on this SKU.
    expect(q.getAllByText('220 ± 5 A')).toHaveLength(2);
    expect(q.getByText('2400 ± 400 A')).toBeTruthy();
  });

  const pressableLabels = (q: Queries) =>
    q.getAllByRole('button').map((b) => String(b.props.accessibilityLabel ?? ''));

  /**
   * DataRow announces itself as "<name>, <value>". Matching on a bare prefix
   * would let "Charge over-current" match the writable "Charge over-current
   * delay" row and quietly pass.
   */
  const hasRowFor = (labels: string[], name: string) =>
    labels.some((l) => l === name || l.startsWith(`${name}, `));

  it('makes no non-writable parameter pressable', async () => {
    const q = await wrap();
    const labels = pressableLabels(q);
    for (const param of fixed) {
      expect(hasRowFor(labels, param.display_name)).toBe(false);
    }
  });

  it('makes every writable parameter pressable', async () => {
    const q = await wrap();
    const labels = pressableLabels(q);
    for (const param of profile.parameters.filter((p) => p.writable)) {
      expect(hasRowFor(labels, param.display_name)).toBe(true);
    }
  });
});

describe('security section', () => {
  it('reports when no PIN is set', async () => {
    const q = await wrap();
    expect(q.getByText('PIN for critical writes')).toBeTruthy();
    expect(q.getByText('Off')).toBeTruthy();
  });

  it('reports when a PIN is set', async () => {
    useSecurityStore.setState({ pinSet: true, pinSetAt: Date.UTC(2026, 8, 5) });
    const q = await wrap();
    expect(q.getByText('On')).toBeTruthy();
    expect(q.getByText('PIN set')).toBeTruthy();
  });
});

describe('session section', () => {
  it('shows who is signed in and what is connected', async () => {
    const q = await wrap();
    expect(q.getByText('w.khan@aurorafleet.example')).toBeTruthy();
    expect(q.getByText('Aurora Fleet')).toBeTruthy();
    expect(q.getByText('BAT-00042')).toBeTruthy();
  });

  it('offers sign out and switch battery', async () => {
    const q = await wrap();
    expect(q.getByText('Sign out')).toBeTruthy();
    expect(q.getByText('Switch battery')).toBeTruthy();
  });

  it('says "none" when no battery is linked', async () => {
    useSessionStore.setState({ connectedBatteryId: null });
    const q = await wrap();
    expect(q.getByText('none')).toBeTruthy();
  });
});
