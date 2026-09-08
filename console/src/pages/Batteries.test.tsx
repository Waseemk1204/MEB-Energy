import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../store/AuthProvider';
import { App } from '../App';
import { describeReading, byAttention, fromRow, type Battery } from '../api/fleet';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const reply = (status: number, body: unknown = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  serial: 'BAT-00042',
  chemistry: 'LiFePO4',
  cell_count: 24,
  bms_model: 'JBD SP24S004',
  lastReading: null,
  ...over,
});

const reading = (agoMs: number, soc = 72, faults = 0) => ({
  soc,
  pack_voltage: 79.2,
  fault_count: faults,
  recorded_at: Date.now() - agoMs,
});

/** Sign in as an administrator, then serve `batteries` from /batteries. */
async function openFleet(batteries: unknown[], onFleet?: () => Response) {
  const fetchImpl = (async (url: string) => {
    if (url.endsWith('/auth/login')) {
      return reply(200, {
        accessToken: 'a1',
        refreshToken: 'r1',
        user: { id: 'u1', email: 'ops@knowyourev.example', displayName: 'Ops', role: 'admin' },
        company: null,
      });
    }
    return onFleet ? onFleet() : reply(200, { batteries, truncated: false });
  }) as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={['/batteries']}>
      <AuthProvider baseUrl="https://api.test" fetchImpl={fetchImpl}>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), 'ops@knowyourev.example');
  await user.type(screen.getByLabelText('Password'), 'a-real-passphrase');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

const rowFor = async (serial: string) => {
  const cell = await screen.findByText(serial);
  return cell.closest('tr')!;
};

beforeEach(() => {
  sessionStorage.clear();
});

describe('reading the wire shape', () => {
  it('maps a battery row', () => {
    expect(fromRow(row())).toEqual({
      id: 'b1',
      serial: 'BAT-00042',
      chemistry: 'LiFePO4',
      cellCount: 24,
      bmsModel: 'JBD SP24S004',
      lastReading: null,
    });
  });

  it('keeps the reading’s timestamp, which the table needs as much as the value', () => {
    const at = Date.now() - HOUR;
    const mapped = fromRow(row({ lastReading: { ...reading(HOUR), recorded_at: at } }));
    expect(mapped.lastReading?.recordedAt).toBe(at);
  });
});

/**
 * An administrator reading fifty rows is further from the hardware than a
 * technician standing in front of one pack, and has no other way to tell a
 * live number from a three-week-old one.
 */
describe('how a reading is described', () => {
  const now = 1_700_000_000_000;
  const at = (ms: number) => ({ soc: 41, packVoltage: 76, faultCount: 0, recordedAt: now - ms });

  it('says a pack has never reported rather than showing zero', () => {
    expect(describeReading(null, now)).toMatchObject({ soc: '—', age: 'Never reported' });
  });

  it('calls the last hour recent', () => {
    expect(describeReading(at(10 * 60 * 1000), now).age).toBe('Reported recently');
  });

  it('counts hours within a day', () => {
    expect(describeReading(at(5 * HOUR), now).age).toBe('5h ago');
  });

  it('counts days beyond one', () => {
    expect(describeReading(at(3 * DAY), now).age).toBe('3d ago');
  });

  it('never reports an age of zero, which would read as live', () => {
    for (const ms of [61 * 60 * 1000, 23.6 * HOUR, 25 * HOUR]) {
      expect(describeReading(at(ms), now).age).not.toMatch(/^0[hd]/);
    }
  });

  it('still reports the value alongside the age, however old', () => {
    expect(describeReading(at(400 * DAY), now).soc).toBe('41%');
  });
});

describe('ordering', () => {
  const pack = (serial: string, faults: number): Battery => ({
    id: serial,
    serial,
    chemistry: 'LiFePO4',
    cellCount: 24,
    bmsModel: null,
    lastReading: faults >= 0 ? { soc: 50, packVoltage: 76, faultCount: faults, recordedAt: 0 } : null,
  });

  it('puts packs with active faults first — the reason to open the page', () => {
    const sorted = [pack('BAT-2', 0), pack('BAT-1', 0), pack('BAT-3', 2)].sort(byAttention);
    expect(sorted.map((b) => b.serial)).toEqual(['BAT-3', 'BAT-1', 'BAT-2']);
  });

  it('orders the rest by serial, so the table is scannable', () => {
    const sorted = [pack('BAT-9', 0), pack('BAT-1', 0), pack('BAT-5', 0)].sort(byAttention);
    expect(sorted.map((b) => b.serial)).toEqual(['BAT-1', 'BAT-5', 'BAT-9']);
  });

  it('sorts more faults above fewer', () => {
    const sorted = [pack('BAT-1', 1), pack('BAT-2', 3)].sort(byAttention);
    expect(sorted[0]!.serial).toBe('BAT-2');
  });
});

describe('the fleet table', () => {
  it('lists each pack with its chemistry and cell count', async () => {
    await openFleet([row(), row({ id: 'b2', serial: 'BAT-00051', cell_count: 16 })]);
    expect(within(await rowFor('BAT-00042')).getByText('24S LiFePO4')).toBeInTheDocument();
    expect(within(await rowFor('BAT-00051')).getByText('16S LiFePO4')).toBeInTheDocument();
  });

  it('shows a charge with the age of the reading it came from', async () => {
    await openFleet([row({ lastReading: reading(5 * HOUR, 41) })]);
    const tr = await rowFor('BAT-00042');
    expect(within(tr).getByText('41%')).toBeInTheDocument();
    expect(within(tr).getByText('5h ago')).toBeInTheDocument();
  });

  it('shows a dash and no age claim for a pack that has never reported', async () => {
    await openFleet([row()]);
    const tr = await rowFor('BAT-00042');

    // Two dashes, and both are right: with no reading, neither the charge nor
    // the fault count is known. Printing "0%" or "None" would be a claim.
    expect(within(tr).getAllByText('—')).toHaveLength(2);
    expect(within(tr).getByText('Never reported')).toBeInTheDocument();
  });

  it('never prints a charge without an age beside it', async () => {
    await openFleet([
      row({ lastReading: reading(2 * 60 * 1000, 72) }),
      row({ id: 'b2', serial: 'BAT-00043', lastReading: reading(5 * HOUR, 41) }),
      row({ id: 'b3', serial: 'BAT-00051', lastReading: reading(9 * DAY, 88) }),
      row({ id: 'b4', serial: 'BAT-00028' }),
    ]);
    await rowFor('BAT-00042');

    for (const serial of ['BAT-00042', 'BAT-00043', 'BAT-00051', 'BAT-00028']) {
      const tr = await rowFor(serial);
      expect(tr.textContent).toMatch(/Reported recently|\d+[hd] ago|Never reported/);
    }
  });

  it('marks a pack carrying faults', async () => {
    await openFleet([row({ lastReading: reading(60_000, 72, 2) })]);
    expect(within(await rowFor('BAT-00042')).getByText('2 active')).toBeInTheDocument();
  });

  it('does not claim zero faults for a pack that has never reported', async () => {
    await openFleet([row()]);
    const tr = await rowFor('BAT-00042');
    expect(within(tr).queryByText('None')).not.toBeInTheDocument();
  });

  it('says None only where a reading actually exists', async () => {
    await openFleet([row({ lastReading: reading(60_000, 72, 0) })]);
    expect(within(await rowFor('BAT-00042')).getByText('None')).toBeInTheDocument();
  });

  it('names an unknown BMS rather than leaving the cell blank', async () => {
    await openFleet([row({ bms_model: null })]);
    expect(within(await rowFor('BAT-00042')).getByText('Unknown')).toBeInTheDocument();
  });

  it('shows an empty fleet as empty', async () => {
    await openFleet([]);
    expect(await screen.findByText('No batteries are registered yet.')).toBeInTheDocument();
  });
});

describe('when the fleet cannot be loaded', () => {
  it('says so rather than showing an empty fleet', async () => {
    await openFleet([], () => reply(500, { error: 'boom', message: 'Something went wrong' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(screen.queryByText('No batteries are registered yet.')).not.toBeInTheDocument();
  });

  it('offers a retry', async () => {
    await openFleet([], () => reply(500, { error: 'boom', message: 'Something went wrong' }));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('invents no batteries', async () => {
    await openFleet([], () => reply(500, { error: 'boom', message: 'nope' }));
    await screen.findByRole('alert');
    expect(screen.queryByText(/BAT-/)).not.toBeInTheDocument();
  });
});


/**
 * The listing is bounded on the server. A partial fleet read as the whole one
 * is the failure that bound creates, so the page says which it is looking at.
 */
describe('a fleet larger than one page', () => {
  const truncatedFetch = (async (url: string) =>
    url.endsWith('/auth/login')
      ? reply(200, {
          accessToken: 'a1',
          refreshToken: 'r1',
          user: { id: 'u1', email: 'ops@knowyourev.example', displayName: 'Ops', role: 'admin' },
          company: null,
        })
      : reply(200, { batteries: [row()], truncated: true })) as unknown as typeof fetch;

  it('says it is showing part of the fleet', async () => {
    render(
      <MemoryRouter initialEntries={['/batteries']}>
        <AuthProvider baseUrl="https://api.test" fetchImpl={truncatedFetch}>
          <App />
        </AuthProvider>
      </MemoryRouter>
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'ops@knowyourev.example');
    await user.type(screen.getByLabelText('Password'), 'a-real-passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/there are more packs than this page returned/)).toBeInTheDocument();
    expect(screen.queryByText(/Every pack registered to your company/)).not.toBeInTheDocument();
  });

  it('claims completeness only when the fleet was complete', async () => {
    await openFleet([row()]);
    expect(await screen.findByText(/Every pack registered to your company/)).toBeInTheDocument();
  });
});
