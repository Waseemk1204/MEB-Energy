import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../store/AuthProvider';
import { App } from '../App';
import { GAP_MS } from '../api/history';

const reply = (status: number, body: unknown = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response;

const NOW = Date.now();

const battery = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  serial: 'BAT-00042',
  chemistry: 'LiFePO4',
  cell_count: 24,
  bms_model: 'JBD SP24S004',
  lastReading: { soc: 72, pack_voltage: 79.2, fault_count: 0, recorded_at: NOW - 90_000 },
  ...over,
});

const readingRow = (at: number, soc = 50, faults = 0) => ({
  recorded_at: at,
  soc,
  pack_voltage: 79.2,
  pack_current: -12,
  temperature_c: 24,
  delta_mv: 30,
  fault_count: faults,
});

const auditRow = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  actor_user_id: 'u1',
  actor_role: 'admin',
  battery_id: 'b1',
  parameter_key: 'cell_ovp',
  old_value: '3.750',
  new_value: '3.800',
  reason: 'Vendor bulletin 2026-114',
  source: 'admin_remote',
  result: 'success',
  support_session_id: null,
  occurred_at: NOW - 60_000,
  recorded_at: NOW - 60_000,
  seq: 1,
  ...over,
});

interface Options {
  batteries?: unknown[];
  readings?: unknown[];
  audit?: unknown[];
  onHistory?: () => Response;
}

async function openBattery(path = '/batteries/b1', options: Options = {}) {
  const requested: string[] = [];

  const fetchImpl = (async (url: string) => {
    requested.push(url);
    if (url.endsWith('/auth/login')) {
      return reply(200, {
        accessToken: 'a1',
        refreshToken: 'r1',
        user: { id: 'u1', email: 'ops@knowyourev.example', displayName: 'Ops', role: 'admin' },
        company: null,
      });
    }
    if (url.includes('/telemetry')) {
      return options.onHistory ? options.onHistory() : reply(200, { readings: options.readings ?? [] });
    }
    if (url.includes('/audit')) {
      // The real server filters; so does this, or the test would prove nothing.
      const wanted = new URL(url, 'https://api.test').searchParams.get('batteryId');
      const events = (options.audit ?? []) as { battery_id: string }[];
      return reply(200, {
        events: wanted ? events.filter((e) => e.battery_id === wanted) : events,
      });
    }
    if (url.endsWith('/batteries')) {
      return reply(200, { batteries: options.batteries ?? [battery()], truncated: false });
    }
    // One battery, fetched directly — the page no longer scans the fleet.
    const match = /\/batteries\/([^/?]+)$/.exec(url);
    if (match) {
      const found = ((options.batteries ?? [battery()]) as { id: string }[]).find(
        (b) => b.id === match[1]
      );
      return found
        ? reply(200, found)
        : reply(404, { error: 'not_found', message: 'Battery not found' });
    }
    return reply(200, {});
  }) as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider baseUrl="https://api.test" fetchImpl={fetchImpl}>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), 'ops@knowyourev.example');
  await user.type(screen.getByLabelText('Password'), 'a-real-passphrase');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));

  return { user, requested };
}

beforeEach(() => {
  sessionStorage.clear();
});

describe('getting here from the fleet', () => {
  it('the serial is a link to the pack', async () => {
    await openBattery('/batteries');
    const link = await screen.findByRole('link', { name: 'BAT-00042' });
    expect(link).toHaveAttribute('href', '/batteries/b1');
  });

  it('opens the pack when followed', async () => {
    const { user } = await openBattery('/batteries');
    await user.click(await screen.findByRole('link', { name: 'BAT-00042' }));
    expect(await screen.findByRole('heading', { name: 'BAT-00042' })).toBeInTheDocument();
  });

  it('offers a way back', async () => {
    await openBattery();
    expect(await screen.findByRole('link', { name: '← All batteries' })).toBeInTheDocument();
  });
});

describe('what the pack is', () => {
  it('names its chemistry, cell count and BMS', async () => {
    await openBattery();
    expect(await screen.findByText('24S LiFePO4 · JBD SP24S004')).toBeInTheDocument();
  });

  it('says the BMS is unknown rather than leaving it blank', async () => {
    await openBattery('/batteries/b1', { batteries: [battery({ bms_model: null })] });
    expect(await screen.findByText(/BMS unknown/)).toBeInTheDocument();
  });

  it('shows the last reading with its age', async () => {
    await openBattery();
    expect(await screen.findByText('72%')).toBeInTheDocument();
    expect(screen.getByText('Reported recently')).toBeInTheDocument();
  });

  it('says a pack with no faults has none', async () => {
    await openBattery();
    expect(await screen.findByText('No faults')).toBeInTheDocument();
  });

  it('marks active faults', async () => {
    await openBattery('/batteries/b1', {
      batteries: [battery({ lastReading: { soc: 19, pack_voltage: 70, fault_count: 2, recorded_at: NOW } })],
    });
    expect(await screen.findByText('2 active faults')).toBeInTheDocument();
  });

  it('uses the singular for one fault', async () => {
    await openBattery('/batteries/b1', {
      batteries: [battery({ lastReading: { soc: 19, pack_voltage: 70, fault_count: 1, recorded_at: NOW } })],
    });
    expect(await screen.findByText('1 active fault')).toBeInTheDocument();
  });

  /** Neither claims nor denies a fault for a pack that never reported. */
  it('claims nothing about a pack that has never reported', async () => {
    await openBattery('/batteries/b1', { batteries: [battery({ lastReading: null })] });
    expect(await screen.findByText('Never reported')).toBeInTheDocument();
    expect(screen.queryByText('No faults')).not.toBeInTheDocument();
  });

  /**
   * The server answers 404 for "not yours" and "not there" identically, and so
   * does this — it is not the console's job to tell them apart.
   */
  it('says so when the battery is not in your fleet', async () => {
    await openBattery('/batteries/nope', { batteries: [battery()] });
    expect(await screen.findByText('That battery is not in your fleet.')).toBeInTheDocument();
  });

  it('does not present a missing battery as a server error', async () => {
    await openBattery('/batteries/nope', { batteries: [battery()] });
    await screen.findByText('That battery is not in your fleet.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * The fleet listing is bounded. Picking this pack out of it would work until
   * a fleet grew past the page, and then quietly stop finding batteries that
   * plainly exist.
   */
  it('fetches the one battery rather than scanning the fleet', async () => {
    const { requested } = await openBattery('/batteries/b1');
    await screen.findByRole('heading', { name: 'BAT-00042' });

    expect(requested.some((u) => /\/batteries\/b1$/.test(u))).toBe(true);
    expect(requested.some((u) => /\/batteries$/.test(u))).toBe(false);
  });
});

describe('the history charts', () => {
  const series = Array.from({ length: 20 }, (_, i) => readingRow(NOW - (20 - i) * 10_000, 40 + i));

  it('counts the stored readings', async () => {
    await openBattery('/batteries/b1', { readings: series });
    expect(await screen.findByText(/20 stored readings/)).toBeInTheDocument();
  });

  it('draws each measure', async () => {
    await openBattery('/batteries/b1', { readings: series });
    for (const label of ['State of charge', 'Pack voltage', 'Temperature', 'Active faults']) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
  });

  /**
   * Somebody who cannot see the line still needs the range and the reading,
   * so the accessible name carries the numbers rather than describing a shape.
   */
  it('describes each chart with its numbers, not its shape', async () => {
    await openBattery('/batteries/b1', { readings: series });
    const chart = await screen.findByRole('img', { name: /State of charge: 20 readings/ });
    expect(chart).toHaveAccessibleName(/40\.0 to 59\.0 %/);
  });

  /**
   * The app only uploads while a technician is linked, so a gap means nobody
   * was there — not that the pack sat still.
   */
  it('says how many gaps there are rather than drawing through them', async () => {
    const withGap = [
      readingRow(NOW - GAP_MS * 20, 40),
      readingRow(NOW - GAP_MS * 20 + 10_000, 41),
      readingRow(NOW - 10_000, 70),
      readingRow(NOW, 71),
    ];
    await openBattery('/batteries/b1', { readings: withGap });

    // Every chart on the page reports it, not just the first — the gap is a
    // fact about the data, not about one measure.
    const notes = await screen.findAllByText(/1 gap where nothing was reported/);
    expect(notes).toHaveLength(4);
    expect(screen.getAllByText(/broken there rather than drawn through/)).toHaveLength(4);
  });

  it('mentions the gap in the accessible name too', async () => {
    const withGap = [
      readingRow(NOW - GAP_MS * 20, 40),
      readingRow(NOW - 10_000, 70),
    ];
    await openBattery('/batteries/b1', { readings: withGap });
    const chart = await screen.findByRole('img', { name: /State of charge/ });
    expect(chart).toHaveAccessibleName(/1 gap where nothing was reported/);
  });

  it('says nothing about gaps in a contiguous series', async () => {
    await openBattery('/batteries/b1', { readings: series });
    expect(screen.queryByText(/gap where nothing was reported/)).not.toBeInTheDocument();
  });

  it('says the pack has never reported rather than drawing an empty chart', async () => {
    await openBattery('/batteries/b1', { readings: [] });
    expect(await screen.findByText('This pack has never reported.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('the changes made to this pack', () => {
  it('lists them', async () => {
    await openBattery('/batteries/b1', { audit: [auditRow()] });
    const tr = (await screen.findByText('cell_ovp')).closest('tr')!;
    expect(within(tr).getByText('3.750 → 3.800')).toBeInTheDocument();
    expect(within(tr).getByText('Applied')).toBeInTheDocument();
    expect(within(tr).getByText('Remote')).toBeInTheDocument();
  });

  /**
   * The trail is capped at 200 rows fleet-wide. Fetching that page and
   * narrowing it here would silently miss anything older, and a pack whose
   * changes fall outside the window would report "nothing has been changed" —
   * a false statement about an audit trail rather than an empty one.
   */
  it('asks the server to filter rather than narrowing a capped page', async () => {
    const { requested } = await openBattery('/batteries/b1', { audit: [auditRow()] });
    await screen.findByText('cell_ovp');

    const call = requested.find((u) => u.includes('/audit'));
    expect(call).toBeDefined();
    expect(new URL(call!, 'https://api.test').searchParams.get('batteryId')).toBe('b1');
  });

  it('shows only this pack’s changes', async () => {
    await openBattery('/batteries/b1', {
      audit: [auditRow(), auditRow({ id: 'e2', battery_id: 'b2', parameter_key: 'cell_uvp' })],
    });
    await screen.findByText('cell_ovp');
    expect(screen.queryByText('cell_uvp')).not.toBeInTheDocument();
  });

  it('says so when nothing has been changed', async () => {
    await openBattery('/batteries/b1', { audit: [] });
    expect(await screen.findByText('Nothing has been changed on this pack.')).toBeInTheDocument();
  });

  it('shows a refusal alongside a success', async () => {
    await openBattery('/batteries/b1', {
      audit: [auditRow(), auditRow({ id: 'e2', parameter_key: 'cell_uvp', result: 'rejected' })],
    });
    expect(await screen.findByText('Applied')).toBeInTheDocument();
    expect(screen.getByText('Refused')).toBeInTheDocument();
  });
});

describe('when the page cannot load', () => {
  it('says so and offers a retry', async () => {
    await openBattery('/batteries/b1', {
      onHistory: () => reply(500, { error: 'boom', message: 'Something went wrong' }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('still offers a way back to the fleet', async () => {
    await openBattery('/batteries/b1', {
      onHistory: () => reply(500, { error: 'boom', message: 'nope' }),
    });
    await screen.findByRole('alert');
    expect(screen.getByRole('link', { name: '← All batteries' })).toBeInTheDocument();
  });
});
