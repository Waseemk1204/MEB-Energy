import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));

import Activity from '../app/activity';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { useActivityStore, type ActivityEntry } from '../src/store/useActivityStore';

const wrap = () => render(<ThemeProvider><Activity /></ThemeProvider>);

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: 'a1',
  timestamp: Date.now() - 60_000,
  parameterKey: 'cell_ovp',
  displayName: 'Cell over-voltage',
  oldValue: '3.750 V',
  newValue: '3.800 V',
  actor: 'You',
  source: 'local',
  dangerLevel: 'Critical',
  result: 'success',
  ...over,
});

const setEntries = (entries: ActivityEntry[]) =>
  useActivityStore.setState({ entries, unseenAdminEntryId: null });

beforeEach(() => setEntries([entry()]));

describe('write history', () => {
  it('shows the parameter and its before/after values', async () => {
    const q = await wrap();
    expect(q.getByText('Cell over-voltage')).toBeTruthy();
    expect(q.getByText(/3\.750 V/)).toBeTruthy();
    expect(q.getByText(/3\.800 V/)).toBeTruthy();
  });

  it('names the actor', async () => {
    setEntries([entry({ actor: 'R. Mehta (Admin)', source: 'admin_remote' })]);
    const q = await wrap();
    expect(q.getByText(/R\. Mehta \(Admin\)/)).toBeTruthy();
  });

  it('quotes the reason when one was given', async () => {
    setEntries([entry({ reason: 'Vendor bulletin 2026-114' })]);
    const q = await wrap();
    expect(q.getByText(/Vendor bulletin 2026-114/)).toBeTruthy();
  });

  it('renders every entry', async () => {
    setEntries([
      entry({ id: 'a1', displayName: 'Cell over-voltage' }),
      entry({ id: 'a2', displayName: 'Balance turn-on voltage' }),
      entry({ id: 'a3', displayName: 'Charge high-temp protection' }),
    ]);
    const q = await wrap();
    expect(q.getByText('Cell over-voltage')).toBeTruthy();
    expect(q.getByText('Balance turn-on voltage')).toBeTruthy();
    expect(q.getByText('Charge high-temp protection')).toBeTruthy();
  });
});

/**
 * PRD §7.5 and §6.3: an Admin remote write reaches the BMS without ever
 * prompting the user, so the source badge is how they learn who initiated it.
 */
describe('write source', () => {
  it('badges a local write', async () => {
    const q = await wrap();
    expect(q.getByText('Local')).toBeTruthy();
  });

  it('badges an admin remote write', async () => {
    setEntries([entry({ source: 'admin_remote', actor: 'R. Mehta (Admin)' })]);
    const q = await wrap();
    expect(q.getByText('Admin remote')).toBeTruthy();
  });

  it('badges a force push distinctly from an ordinary remote write', async () => {
    setEntries([entry({ source: 'admin_force_push', actor: 'R. Mehta (Admin)' })]);
    const q = await wrap();
    expect(q.getByText('Admin Force Push')).toBeTruthy();
    expect(q.queryByText('Admin remote')).toBeNull();
  });

  it('shows the support session when the write belonged to one', async () => {
    setEntries([entry({ source: 'admin_remote', supportSessionId: 'SS-4471' })]);
    const q = await wrap();
    expect(q.getByText(/SS-4471/)).toBeTruthy();
  });
});

/** §7.12: every attempt is recorded, rejected ones included. */
describe('results', () => {
  it('marks a successful write', async () => {
    const q = await wrap();
    expect(q.getByText('success')).toBeTruthy();
  });

  it('records a rejected write rather than hiding it', async () => {
    setEntries([entry({ result: 'rejected' })]);
    const q = await wrap();
    expect(q.getByText('rejected')).toBeTruthy();
    expect(q.getByText('Cell over-voltage')).toBeTruthy();
  });

  it('records a timeout', async () => {
    setEntries([entry({ result: 'timeout' })]);
    const q = await wrap();
    expect(q.getByText('timeout')).toBeTruthy();
  });

  it('records a value the BMS adjusted', async () => {
    setEntries([entry({ result: 'adjusted' })]);
    const q = await wrap();
    expect(q.getByText('adjusted')).toBeTruthy();
  });

  /**
   * An unconfirmed write is neither a success nor a failure, and the timeline
   * must not let a reader mistake it for either.
   */
  it('labels an unconfirmed write as unknown', async () => {
    setEntries([entry({ result: 'indeterminate' })]);
    const q = await wrap();
    // Once on the entry's chip, once in the footnote explaining what it means.
    expect(q.getAllByText('unknown')).toHaveLength(2);
    expect(q.queryByText('success')).toBeNull();
    expect(q.queryByText('rejected')).toBeNull();
  });

  it('explains what an unknown entry means', async () => {
    const q = await wrap();
    expect(q.getByText(/may or may not have changed/)).toBeTruthy();
  });
});

/**
 * The local log is a field record and a sync queue, not the ledger of record.
 * A technician must be able to see what has not left the device.
 */
describe('ledger status', () => {
  it('says how many entries are still only on this device', async () => {
    setEntries([entry({ id: 'a', synced: false }), entry({ id: 'b', synced: true })]);
    const q = await wrap();
    expect(q.getByText(/1 of 2 entries are held on this device/)).toBeTruthy();
  });

  it('says so plainly when everything is recorded', async () => {
    setEntries([entry({ synced: true })]);
    const q = await wrap();
    expect(q.getByText(/1 entries, all recorded/)).toBeTruthy();
  });

  it('discloses entries dropped to stay within storage', async () => {
    useActivityStore.setState({ entries: [entry()], unseenAdminEntryId: null, droppedCount: 4 });
    const q = await wrap();
    expect(q.getByText(/4 older entries have been dropped/)).toBeTruthy();
  });

  it('offers an export while there is no backend to receive it', async () => {
    const q = await wrap();
    expect(q.getByLabelText('Export write history')).toBeTruthy();
  });
});

describe('opening the screen', () => {
  it('clears the dashboard banner, since the change has now been seen', async () => {
    useActivityStore.setState({ entries: [entry()], unseenAdminEntryId: 'a1' });
    await wrap();
    expect(useActivityStore.getState().unseenAdminEntryId).toBeNull();
  });
});
