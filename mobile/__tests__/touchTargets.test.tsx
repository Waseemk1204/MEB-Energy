import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => ({ parameterKey: 'cell_ovp' }),
}));

import Dashboard from '../app/(tabs)/index';
import Cells from '../app/(tabs)/cells';
import HistoryScreen from '../app/(tabs)/history';
import SettingsScreen from '../app/(tabs)/settings';
import Protection from '../app/protection';
import Activity from '../app/activity';
import Batteries from '../app/batteries';
import Login from '../app/login';
import WriteConfirmation from '../app/write/[parameterKey]';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { useTelemetryStore } from '../src/store/useTelemetryStore';
import { useSessionStore } from '../src/store/useSessionStore';
import { useSecurityStore } from '../src/store/useSecurityStore';
import { useSettingsStore } from '../src/store/useSettingsStore';
import { profile } from '../src/bms/capabilityProfile';
import type { BatterySnapshot } from '../src/telemetry/types';

/**
 * PRD §8 / UI plan §1.3: every interactive element gets at least a 44 × 44
 * touch area. That was stated in the design doc and never checked — the History
 * segmented control (40), its range chips (36) and the Back control (~42 with
 * hitSlop) were all under the bar.
 *
 * A button satisfies the rule by declaring a height of 44 or more on itself or
 * on something it wraps. `hitSlop` counts too, but only when it actually closes
 * the gap — a declared size is preferred because it can be read at a glance.
 */
const MIN_TARGET = 44;

const MIN_TARGET_KEYS = ['minHeight', 'height'] as const;

function flatten(style: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (s: unknown): void => {
    if (Array.isArray(s)) return s.forEach(visit);
    if (typeof s === 'function') return visit((s as (a: unknown) => unknown)({ pressed: false }));
    if (s && typeof s === 'object') Object.assign(out, s);
  };
  visit(style);
  return out;
}

function declaredHeight(style: unknown): number {
  const flat = flatten(style);
  return Math.max(
    ...MIN_TARGET_KEYS.map((k) => (typeof flat[k] === 'number' ? (flat[k] as number) : 0))
  );
}

/** Largest height declared on this node or anything beneath it. */
function bestHeight(node: unknown): number {
  if (Array.isArray(node)) return Math.max(0, ...node.map(bestHeight));
  if (!node || typeof node !== 'object') return 0;
  const n = node as { props?: { style?: unknown }; children?: unknown };
  return Math.max(declaredHeight(n.props?.style), bestHeight(n.children));
}

function slopHeight(hitSlop: unknown): number {
  if (typeof hitSlop === 'number') return hitSlop * 2;
  if (hitSlop && typeof hitSlop === 'object') {
    const h = hitSlop as { top?: number; bottom?: number };
    return (h.top ?? 0) + (h.bottom ?? 0);
  }
  return 0;
}

interface Offender {
  label: string;
  height: number;
}

function audit(tree: unknown): Offender[] {
  const bad: Offender[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    const n = node as {
      props?: { accessibilityRole?: string; accessibilityLabel?: string; style?: unknown; hitSlop?: unknown };
      children?: unknown;
    };
    const role = n.props?.accessibilityRole;
    if (role === 'button' || role === 'tab') {
      const height = bestHeight(n) + slopHeight(n.props?.hitSlop);
      if (height < MIN_TARGET) {
        bad.push({ label: n.props?.accessibilityLabel ?? `<${role} with no label>`, height });
      }
    }
    visit(n.children);
  };
  visit(tree);
  return bad;
}

const snapshot = (): BatterySnapshot => ({
  timestamp: Date.now(),
  soc: 72,
  packVoltage: 79.2,
  packCurrent: 168,
  temperatures: [24, 22.6],
  cellVoltages: Array.from({ length: 24 }, (_, i) => 3.3 + i * 0.001),
  cellCount: 24,
  minCellV: 3.3,
  maxCellV: 3.323,
  deltaMv: 23,
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

beforeEach(() => {
  useTelemetryStore.setState({
    snapshot: snapshot(),
    history: Array.from({ length: 20 }, (_, i) => ({
      t: Date.now() + i,
      soc: 60 + i,
      packVoltage: 79,
      packCurrent: 120,
      temp: 24,
    })),
  });
  useSessionStore.setState({
    hydrated: true,
    authenticated: true,
    operator: 'w.khan@aurorafleet.example',
    company: 'Aurora Fleet',
    connectedBatteryId: 'BAT-00042',
    connectingBatteryId: null,
    stage: 'connected',
  });
  useSecurityStore.setState({ hydrated: true, pinSet: false, pinSetAt: null });
  useSettingsStore.setState({
    values: Object.fromEntries(profile.parameters.map((p) => [p.parameter_key, p.value])),
  });
});

const screens: [string, React.ComponentType][] = [
  ['Dashboard', Dashboard],
  ['Cells', Cells],
  ['History', HistoryScreen],
  ['Settings', SettingsScreen],
  ['Protection', Protection],
  ['Activity', Activity],
  ['Batteries', Batteries],
  ['Login', Login],
  ['Write confirmation', WriteConfirmation],
];

describe.each(screens)('%s', (_name, Screen) => {
  it('gives every control at least a 44pt touch target', async () => {
    const r = await render(
      <ThemeProvider>
        <Screen />
      </ThemeProvider>
    );
    expect(audit(r.toJSON())).toEqual([]);
  });
});
