import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

const mockReplace = jest.fn();
const mockBack = jest.fn();
let mockParameterKey = 'cell_ovp';

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, back: mockBack, canGoBack: () => true, push: jest.fn() }),
  useLocalSearchParams: () => ({ parameterKey: mockParameterKey }),
}));

import WriteConfirmation from '../app/write/[parameterKey]';
import { useSessionStore } from '../src/store/useSessionStore';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { useSettingsStore } from '../src/store/useSettingsStore';
import { useActivityStore } from '../src/store/useActivityStore';
import { useSecurityStore } from '../src/store/useSecurityStore';
import { useTelemetryStore } from '../src/store/useTelemetryStore';
import { profile } from '../src/bms/capabilityProfile';

const wrap = () => render(<ThemeProvider><WriteConfirmation /></ThemeProvider>);

type Queries = Awaited<ReturnType<typeof wrap>>;

const writeButton = (q: Queries) =>
  q
    .getAllByRole('button')
    .find((b) => String(b.props.accessibilityLabel ?? '').startsWith('Write'))!;

beforeEach(() => {
  mockParameterKey = 'cell_ovp';
  mockReplace.mockClear();
  mockBack.mockClear();

  useSettingsStore.setState({
    values: Object.fromEntries(profile.parameters.map((p) => [p.parameter_key, p.value])),
  });
  useActivityStore.setState({ entries: [], unseenAdminEntryId: null });
  useSecurityStore.setState({
    hydrated: true,
    pinSet: false,
    pinSetAt: null,
    failedAttempts: 0,
    lockedUntil: null,
  });
  useTelemetryStore.setState({
    source: {
      simulated: false,
    start: jest.fn(),
      stop: jest.fn(),
      readSetting: jest.fn(async () => 0),
      writeSetting: jest.fn(async (_k: string, v: number) => ({ ok: true, readBack: v })),
    },
  });
});

/**
 * PRD §6.2 orders the safe write:
 *   value → validation → warning → acknowledgement → reason → execute.
 * Each gate is asserted on its own so a regression names the gate that broke.
 */
describe('critical write gates', () => {
  it('opens disabled, with nothing changed', async () => {
    const q = await wrap();
    expect(writeButton(q).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('stays disabled after only changing the value', async () => {
    const q = await wrap();
    await fireEvent.press(q.getByLabelText('Increase'));
    expect(writeButton(q).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('stays disabled after value + acknowledgement, with no reason', async () => {
    const q = await wrap();
    await fireEvent.press(q.getByLabelText('Increase'));
    await fireEvent(q.getByLabelText('Acknowledge the effect of this change'), 'valueChange', true);
    expect(writeButton(q).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('stays disabled when the reason is only whitespace', async () => {
    const q = await wrap();
    await fireEvent.press(q.getByLabelText('Increase'));
    await fireEvent(q.getByLabelText('Acknowledge the effect of this change'), 'valueChange', true);
    await fireEvent.changeText(q.getByLabelText('Reason for this change'), '    ');
    expect(writeButton(q).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('enables only once value, acknowledgement and reason are all present', async () => {
    const q = await wrap();
    await fireEvent.press(q.getByLabelText('Increase'));
    await fireEvent(q.getByLabelText('Acknowledge the effect of this change'), 'valueChange', true);
    await fireEvent.changeText(q.getByLabelText('Reason for this change'), 'Vendor bulletin 2026-114');
    expect(writeButton(q).props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('stays disabled if the value is returned to where it started', async () => {
    const q = await wrap();
    await fireEvent(q.getByLabelText('Acknowledge the effect of this change'), 'valueChange', true);
    await fireEvent.changeText(q.getByLabelText('Reason for this change'), 'a reason');
    await fireEvent.press(q.getByLabelText('Increase'));
    await fireEvent.press(q.getByLabelText('Decrease'));
    expect(writeButton(q).props.accessibilityState).toMatchObject({ disabled: true });
  });
});

describe('the button names the change', () => {
  it('labels itself with the value it will write, never just "Confirm"', async () => {
    const q = await wrap();
    await fireEvent.press(q.getByLabelText('Increase'));
    const label = String(writeButton(q).props.accessibilityLabel);
    expect(label).toContain('3.755 V');
    expect(label).not.toMatch(/^Confirm$/);
  });
});

describe('non-critical parameters', () => {
  beforeEach(() => {
    mockParameterKey = 'charge_htp'; // Warning level
  });

  it('does not require a reason', async () => {
    const q = await wrap();
    await fireEvent.press(q.getByLabelText('Increase'));
    await fireEvent(q.getByLabelText('Acknowledge the effect of this change'), 'valueChange', true);
    expect(writeButton(q).props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('still requires the acknowledgement', async () => {
    const q = await wrap();
    await fireEvent.press(q.getByLabelText('Increase'));
    expect(writeButton(q).props.accessibilityState).toMatchObject({ disabled: true });
  });
});

describe('range validation', () => {
  it('refuses a value above the datasheet maximum', async () => {
    const q = await wrap();
    await fireEvent.changeText(q.getByLabelText('Cell over-voltage new value'), '4.2');
    await fireEvent(q.getByLabelText('Acknowledge the effect of this change'), 'valueChange', true);
    await fireEvent.changeText(q.getByLabelText('Reason for this change'), 'a reason');
    expect(writeButton(q).props.accessibilityState).toMatchObject({ disabled: true });
    expect(q.getByText(/Above the supported maximum/)).toBeTruthy();
  });

  it('refuses a value below the datasheet minimum', async () => {
    const q = await wrap();
    await fireEvent.changeText(q.getByLabelText('Cell over-voltage new value'), '3.0');
    await fireEvent(q.getByLabelText('Acknowledge the effect of this change'), 'valueChange', true);
    await fireEvent.changeText(q.getByLabelText('Reason for this change'), 'a reason');
    expect(writeButton(q).props.accessibilityState).toMatchObject({ disabled: true });
    expect(q.getByText(/Below the supported minimum/)).toBeTruthy();
  });
});

/**
 * A write whose outcome the app cannot confirm must not move the displayed
 * value. Showing the requested value would present a guess as fact.
 */
describe('write outcomes', () => {
  const passGatesAnd = async (q: Queries) => {
    await fireEvent.press(q.getByLabelText('Increase'));
    await fireEvent(q.getByLabelText('Acknowledge the effect of this change'), 'valueChange', true);
    await fireEvent.changeText(q.getByLabelText('Reason for this change'), 'Vendor bulletin');
    await fireEvent.press(writeButton(q));
    // execute() walks write -> read back -> audit with real delays; wait for it
    // to settle rather than asserting mid-flight.
    await waitFor(() => expect(useActivityStore.getState().entries).toHaveLength(1));
  };

  const setSource = (writeSetting: jest.Mock) =>
    useTelemetryStore.setState({
      source: { simulated: false,
    start: jest.fn(), stop: jest.fn(), readSetting: jest.fn(), writeSetting },
    });

  it('confirms a matching read-back and stores it', async () => {
    setSource(jest.fn(async (_k: string, v: number) => ({ ok: true, readBack: v })));
    const q = await wrap();
    await passGatesAnd(q);
    expect(useSettingsStore.getState().values.cell_ovp).toBe(3.755);
    expect(useActivityStore.getState().entries[0].result).toBe('success');
  });

  it('stores what the BMS actually kept when it differs', async () => {
    setSource(jest.fn(async () => ({ ok: true, readBack: 3.75 })));
    const q = await wrap();
    await passGatesAnd(q);
    expect(useSettingsStore.getState().values.cell_ovp).toBe(3.75);
    expect(useActivityStore.getState().entries[0].result).toBe('adjusted');
    await waitFor(() => expect(q.getByText(/Written, with a different value/)).toBeTruthy());
  });

  it('leaves the value untouched when the link drops mid-write', async () => {
    setSource(jest.fn(async () => {
      throw new Error('Device disconnected');
    }));
    const q = await wrap();
    await passGatesAnd(q);
    expect(useSettingsStore.getState().values.cell_ovp).toBe(3.75); // unchanged
    expect(useActivityStore.getState().entries[0].result).toBe('indeterminate');
    await waitFor(() => expect(q.getByText(/Outcome unknown/)).toBeTruthy());
    await waitFor(() => expect(q.getByText(/may or may not have changed/)).toBeTruthy());
  });

  it('leaves the value untouched when the BMS accepts but returns nothing', async () => {
    setSource(jest.fn(async () => ({ ok: true })));
    const q = await wrap();
    await passGatesAnd(q);
    expect(useSettingsStore.getState().values.cell_ovp).toBe(3.75);
    expect(useActivityStore.getState().entries[0].result).toBe('indeterminate');
  });

  it('records a rejection without changing the value', async () => {
    setSource(jest.fn(async () => ({ ok: false, error: 'Out of range' })));
    const q = await wrap();
    await passGatesAnd(q);
    expect(useSettingsStore.getState().values.cell_ovp).toBe(3.75);
    expect(useActivityStore.getState().entries[0].result).toBe('rejected');
    await waitFor(() => expect(q.getByText(/Rejected by the BMS/)).toBeTruthy());
  });

  /** An unknown outcome must never be filed as success or as failure. */
  it('files an unknown outcome as unknown, not as either extreme', async () => {
    setSource(jest.fn(async () => {
      throw new Error('Device disconnected');
    }));
    const q = await wrap();
    await passGatesAnd(q);
    const entry = useActivityStore.getState().entries[0];
    expect(entry.result).not.toBe('success');
    expect(entry.result).not.toBe('rejected');
    expect(entry.result).toBe('indeterminate');
  });

  it('offers a way out instead of leaving a dead write button', async () => {
    setSource(jest.fn(async () => ({ ok: false, error: 'Out of range' })));
    const q = await wrap();
    await passGatesAnd(q);
    await waitFor(() => expect(q.getByLabelText('Close')).toBeTruthy());
  });
});

/** The PIN is asked for on Critical parameters only, and only when one is set. */
describe('PIN gate', () => {
  const passGates = async (q: Queries) => {
    await fireEvent.press(q.getByLabelText('Increase'));
    await fireEvent(q.getByLabelText('Acknowledge the effect of this change'), 'valueChange', true);
    await fireEvent.changeText(q.getByLabelText('Reason for this change'), 'Vendor bulletin 2026-114');
  };

  it('announces the requirement on the button when a PIN is set', async () => {
    useSecurityStore.setState({ pinSet: true });
    const q = await wrap();
    await passGates(q);
    expect(String(writeButton(q).props.accessibilityLabel)).toContain('PIN required');
  });

  it('does not announce it when no PIN is set', async () => {
    const q = await wrap();
    await passGates(q);
    expect(String(writeButton(q).props.accessibilityLabel)).not.toContain('PIN required');
  });

  it('asks for the PIN instead of writing', async () => {
    useSecurityStore.setState({ pinSet: true });
    const q = await wrap();
    await passGates(q);
    await fireEvent.press(writeButton(q));

    expect(q.getByText(/Enter your \d-digit PIN/)).toBeTruthy();
    expect(useTelemetryStore.getState().source!.writeSetting).not.toHaveBeenCalled();
  });

  it('writes straight through when no PIN is set', async () => {
    const q = await wrap();
    await passGates(q);
    await fireEvent.press(writeButton(q));
    expect(useTelemetryStore.getState().source!.writeSetting).toHaveBeenCalledWith('cell_ovp', 3.755);
  });
});

/**
 * A completed write is only half the job. The entry it produces is the only
 * record that a change reached a physical battery, and until it reaches the
 * server it lives on one phone.
 *
 * This used to wait for the *next* link to the same pack — so a technician who
 * connected, made changes and disconnected carried the only copy away with
 * them. The pieces were all tested; the sequence was not.
 */
describe('what happens after the write completes', () => {
  beforeEach(() => {
    useSessionStore.setState({ connectedBatteryId: 'BAT-00042' });
    useActivityStore.setState({ entries: [], uploading: false, droppedCount: 0 });
  });

  /**
   * The write flow deliberately pauses on read-back and auditing, so a test can
   * finish while its own write is still settling — and the tail of it then
   * lands inside the next test. Waiting it out here keeps a real assertion
   * about "was this called" from being answered by the previous test.
   */
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 700));
  });

  /**
   * Counted as a delta rather than an absolute. An earlier test's write can
   * still be settling when this one starts — the flow spends a moment on
   * read-back and auditing — and an absolute count turns that into a flake
   * that looks like a product bug.
   */
  const completeAWrite = async (q: Awaited<ReturnType<typeof wrap>>) => {
    const before = useActivityStore.getState().entries.length;

    await fireEvent.press(q.getByLabelText('Increase'));
    await fireEvent(q.getByLabelText('Acknowledge the effect of this change'), 'valueChange', true);
    await fireEvent.changeText(
      q.getByLabelText('Reason for this change'),
      'Vendor bulletin 2026-114'
    );
    await fireEvent.press(writeButton(q));

    await waitFor(
      () => expect(useActivityStore.getState().entries.length).toBeGreaterThan(before),
      { timeout: 3000 }
    );
  };

  it('records what happened', async () => {
    const q = await wrap();
    await completeAWrite(q);
    // Newest first, so the entry this write produced is at the front.
    expect(useActivityStore.getState().entries[0]!.parameterKey).toBe('cell_ovp');
  });

  /** The mutation this exists for: dropping the push leaves it queued forever. */
  it('pushes it to the server without waiting for the next link', async () => {
    const sync = jest.spyOn(useActivityStore.getState(), 'sync').mockResolvedValue();
    sync.mockClear();

    const q = await wrap();
    await completeAWrite(q);

    await waitFor(() => expect(sync).toHaveBeenCalledWith('BAT-00042'));
  });

  it('does not try when no pack is linked', async () => {
    useSessionStore.setState({ connectedBatteryId: null });
    const sync = jest.spyOn(useActivityStore.getState(), 'sync').mockResolvedValue();
    sync.mockClear();

    const q = await wrap();
    await completeAWrite(q);

    expect(sync).not.toHaveBeenCalled();
  });
});
