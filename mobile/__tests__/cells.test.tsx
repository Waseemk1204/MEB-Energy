import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));

import Cells from '../app/(tabs)/cells';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { useTelemetryStore } from '../src/store/useTelemetryStore';
import { useSettingsStore } from '../src/store/useSettingsStore';
import { profile } from '../src/bms/capabilityProfile';
import type { BatterySnapshot } from '../src/telemetry/types';

const wrap = () => render(<ThemeProvider><Cells /></ThemeProvider>);

/** Distinct voltages so min and max are unambiguous. */
const cellsAt = (values: number[]): BatterySnapshot => ({
  timestamp: Date.now(),
  soc: 72,
  packVoltage: values.reduce((a, b) => a + b, 0),
  packCurrent: 168,
  temperatures: [24, 22.6],
  cellVoltages: values,
  cellCount: values.length,
  minCellV: Math.min(...values),
  maxCellV: Math.max(...values),
  deltaMv: (Math.max(...values) - Math.min(...values)) * 1000,
  chargeMos: true,
  dischargeMos: true,
  balancing: false,
  balancingCells: [],
  faults: [],
  cycles: 142,
  soh: 96,
  bmsModel: 'JBD SP24S004',
  bmsFirmware: 'FW 1.2.4',
  bleState: 'connected',
  location: null,
});

const twentyFour = Array.from({ length: 24 }, (_, i) => 3.3 + i * 0.001);

beforeEach(() => {
  useTelemetryStore.setState({ snapshot: cellsAt(twentyFour) });
  useSettingsStore.setState({
    values: Object.fromEntries(profile.parameters.map((p) => [p.parameter_key, p.value])),
  });
});

describe('cell grid', () => {
  it('renders one card per cell reported, not a hardcoded count', async () => {
    const q = await wrap();
    expect(q.getByText('CELL 1')).toBeTruthy();
    expect(q.getByText('CELL 24')).toBeTruthy();
    expect(q.queryByText('CELL 25')).toBeNull();
  });

  it('follows a pack with a different cell count', async () => {
    useTelemetryStore.setState({
      snapshot: cellsAt(Array.from({ length: 16 }, (_, i) => 3.3 + i * 0.001)),
    });
    const q = await wrap();
    expect(q.getByText('CELL 16')).toBeTruthy();
    expect(q.queryByText('CELL 17')).toBeNull();
  });

  it('prints each cell to millivolt precision', async () => {
    const q = await wrap();
    expect(q.getByText('3.300')).toBeTruthy();
    expect(q.getByText('3.323')).toBeTruthy();
  });

  it('marks exactly one min and one max', async () => {
    const q = await wrap();
    expect(q.getAllByText('MIN')).toHaveLength(1);
    expect(q.getAllByText('MAX')).toHaveLength(1);
  });
});

/**
 * Delta against the balance threshold is the number a technician acts on, so it
 * carries the warning state rather than being left for them to compare.
 */
describe('balance delta', () => {
  it('reports the delta in millivolts', async () => {
    const q = await wrap();
    expect(q.getByText('23 mV')).toBeTruthy();
  });

  it('shows the configured threshold, not a literal', async () => {
    const q = await wrap();
    expect(q.getByText('15 mV')).toBeTruthy();
  });

  it('follows the threshold when it is changed by a write', async () => {
    useSettingsStore.setState({
      values: { ...useSettingsStore.getState().values, balance_delta_mv: 40 },
    });
    const q = await wrap();
    expect(q.getByText('40 mV')).toBeTruthy();
    expect(q.getByText(/within the 40 mV balance threshold/)).toBeTruthy();
  });

  it('calls out a delta above the threshold', async () => {
    const q = await wrap(); // 23 mV against a 15 mV threshold
    expect(q.getByText(/above the 15 mV balance threshold/)).toBeTruthy();
  });

  it('stays calm when the delta is within the threshold', async () => {
    useTelemetryStore.setState({
      snapshot: cellsAt(Array.from({ length: 24 }, (_, i) => 3.3 + i * 0.0002)),
    });
    const q = await wrap();
    expect(q.getByText(/within the 15 mV balance threshold/)).toBeTruthy();
  });
});

describe('balancing state', () => {
  it('reports idle', async () => {
    const q = await wrap();
    expect(q.getByText('Idle')).toBeTruthy();
  });

  it('reports how many cells are balancing', async () => {
    useTelemetryStore.setState({
      snapshot: { ...cellsAt(twentyFour), balancing: true, balancingCells: [1, 2, 3, 4] },
    });
    const q = await wrap();
    expect(q.getByText('Active · 4 cells')).toBeTruthy();
  });
});

/** PRD §7.17: detail data stays tabular — gauges never appear on a list screen. */
describe('no instrumentation', () => {
  it('renders no gauge labels', async () => {
    const q = await wrap();
    expect(q.queryByText('SOC')).toBeNull();
    expect(q.queryByText('Pack Current')).toBeNull();
    expect(q.queryByText('Pack Voltage')).toBeNull();
  });
});
