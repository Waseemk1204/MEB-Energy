import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../store/AuthProvider';
import { App } from '../App';
import {
  MIN_REASON_LENGTH,
  describeDisposition,
  fromRow,
  reasonIsSufficient,
} from '../api/support';

const reply = (status: number, body: unknown = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response;

const BATTERY = {
  id: 'b1',
  serial: 'BAT-00042',
  chemistry: 'LiFePO4',
  cell_count: 24,
  bms_model: 'JBD SP24S004',
  lastReading: null,
};

const PARAMETERS = [
  {
    parameterKey: 'cell_ovp',
    displayName: 'Cell over-voltage',
    unit: 'V',
    minValue: 3.7,
    maxValue: 3.8,
    dangerLevel: 'Critical',
    writable: true,
    requiresAdmin: false,
    requiresConfirmation: true,
  },
  {
    parameterKey: 'balance_start_v',
    displayName: 'Balance turn-on voltage',
    unit: 'V',
    minValue: 3.37,
    maxValue: 3.43,
    dangerLevel: 'Normal',
    writable: true,
    requiresAdmin: false,
    requiresConfirmation: true,
  },
  {
    parameterKey: 'cell_count',
    displayName: 'Series cell count',
    unit: 'S',
    minValue: 8,
    maxValue: 24,
    dangerLevel: 'Critical',
    writable: false,
    requiresAdmin: true,
    requiresConfirmation: true,
  },
];

interface Options {
  onSite?: boolean;
  onIssue?: (body: unknown) => Response;
  onClose?: () => Response;
}

/** Sign in as an administrator and land on Remote support. */
async function openSupport(options: Options = {}) {
  const issued: unknown[] = [];

  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;

    if (url.endsWith('/auth/login')) {
      return reply(200, {
        accessToken: 'a1',
        refreshToken: 'r1',
        user: { id: 'u1', email: 'ops@knowyourev.example', displayName: 'Ops', role: 'admin' },
        company: null,
      });
    }
    if (url.endsWith('/batteries')) return reply(200, { batteries: [BATTERY] });
    if (url.endsWith('/session')) return reply(200, { active: options.onSite ?? false });
    if (url.includes('/bms/')) return reply(200, { parameters: PARAMETERS });
    if (url.endsWith('/support-sessions') && init.method === 'POST') {
      return reply(201, { supportSessionId: 's1' });
    }
    if (url.includes('/commands')) {
      issued.push(body);
      return options.onIssue
        ? options.onIssue(body)
        : reply(202, {
            commandId: 'c1',
            disposition: options.onSite ? 'deliverable' : 'queued',
            auditId: 'a1',
          });
    }
    if (init.method === 'PATCH') {
      return options.onClose ? options.onClose() : reply(200, { cancelledCommands: 0 });
    }
    return reply(200, {});
  }) as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={['/support']}>
      <AuthProvider baseUrl="https://api.test" fetchImpl={fetchImpl}>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), 'ops@knowyourev.example');
  await user.type(screen.getByLabelText('Password'), 'a-real-passphrase');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { name: 'Remote support' });

  return { user, issued };
}

const selectBattery = async (user: ReturnType<typeof userEvent.setup>) => {
  await waitFor(() => expect(screen.getByLabelText('Battery')).toBeInTheDocument());
  await user.selectOptions(screen.getByLabelText('Battery'), 'b1');
};

beforeEach(() => {
  sessionStorage.clear();
});

describe('what an administrator is told after issuing a change', () => {
  /**
   * The wording that matters most in the product. Neither branch claims the
   * battery changed — because issuing a change is not making a change.
   */
  it('never says the change was applied', () => {
    for (const d of ['deliverable', 'queued'] as const) {
      expect(describeDisposition(d).text).not.toMatch(/applied|changed|updated|done|success/i);
    }
  });

  it('says a technician will collect it when one is on site', () => {
    expect(describeDisposition('deliverable').text).toMatch(/technician is on site/i);
  });

  it('says plainly that it is waiting when nobody is', () => {
    const { text, tone } = describeDisposition('queued');
    expect(text).toMatch(/Queued/);
    expect(text).toMatch(/Nobody is linked/);
    expect(tone).toBe('warn');
  });
});

describe('requiring a reason', () => {
  it('rejects something too short to mean anything', () => {
    expect(reasonIsSufficient('fix')).toBe(false);
    expect(reasonIsSufficient('   ')).toBe(false);
  });

  it('accepts a real one', () => {
    expect(reasonIsSufficient('Vendor bulletin 2026-114')).toBe(true);
  });

  it('does not count surrounding whitespace towards the minimum', () => {
    expect(reasonIsSufficient(`  ${'x'.repeat(MIN_REASON_LENGTH - 1)}  `)).toBe(false);
  });
});

describe('reading a session row', () => {
  it('maps the wire shape', () => {
    const mapped = fromRow({
      id: 's1',
      battery_id: 'b1',
      admin_user_id: 'u1',
      started_at: 1000,
      ended_at: null,
      outcome: null,
    });
    expect(mapped).toEqual({
      id: 's1',
      batteryId: 'b1',
      adminUserId: 'u1',
      startedAt: 1000,
      endedAt: null,
      outcome: null,
    });
  });
});

describe('before a session is open', () => {
  it('offers no way to issue a change', async () => {
    const { user } = await openSupport();
    await selectBattery(user);
    expect(screen.queryByRole('button', { name: 'Issue change' })).not.toBeInTheDocument();
  });

  /** Presence is stated before anything can be issued, not discovered after. */
  it('says whether anyone is on site', async () => {
    const { user } = await openSupport({ onSite: false });
    await selectBattery(user);
    expect(await screen.findByText('Nobody is linked to this battery')).toBeInTheDocument();
  });

  it('says when someone is', async () => {
    const { user } = await openSupport({ onSite: true });
    await selectBattery(user);
    expect(await screen.findByText('A technician is linked to this battery')).toBeInTheDocument();
  });
});

describe('issuing a change', () => {
  const fill = async (
    user: ReturnType<typeof userEvent.setup>,
    { value = '3.75', reason = 'Vendor bulletin 2026-114' } = {}
  ) => {
    await user.click(await screen.findByRole('button', { name: 'Open support session' }));
    await user.selectOptions(await screen.findByLabelText('Parameter'), 'cell_ovp');
    await user.type(screen.getByLabelText(/New value/), value);
    await user.type(screen.getByLabelText(/Reason/), reason);
  };

  it('offers only parameters the BMS allows writing', async () => {
    const { user } = await openSupport();
    await selectBattery(user);
    await user.click(await screen.findByRole('button', { name: 'Open support session' }));

    const options = await screen.findByLabelText('Parameter');
    expect(options).toHaveTextContent('Cell over-voltage');
    // `cell_count` is not writable, so it is not offered at all.
    expect(options).not.toHaveTextContent('Series cell count');
  });

  it('will not submit without a reason', async () => {
    const { user } = await openSupport();
    await selectBattery(user);
    await fill(user, { reason: 'no' });
    expect(screen.getByRole('button', { name: 'Issue change' })).toBeDisabled();
  });

  it('sends the change with its reason', async () => {
    const { user, issued } = await openSupport();
    await selectBattery(user);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Issue change' }));

    await waitFor(() => expect(issued).toHaveLength(1));
    expect(issued[0]).toEqual({
      parameterKey: 'cell_ovp',
      value: 3.75,
      reason: 'Vendor bulletin 2026-114',
      forcePush: false,
    });
  });

  it('reports a queued change as queued, not as done', async () => {
    const { user } = await openSupport({ onSite: false });
    await selectBattery(user);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Issue change' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/Queued/);
    expect(status).not.toHaveTextContent(/applied|success/i);
  });

  it('reports a deliverable change without claiming it landed', async () => {
    const { user } = await openSupport({ onSite: true });
    await selectBattery(user);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Issue change' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/will collect it/);
    expect(status).not.toHaveTextContent(/applied|changed/i);
  });

  /** The server decides. This is guidance, and says so. */
  it('warns about a value outside the permitted range without blocking it', async () => {
    const { user } = await openSupport();
    await selectBattery(user);
    await fill(user, { value: '4.2' });

    expect(await screen.findByText(/The server will refuse it/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issue change' })).toBeEnabled();
  });

  it('surfaces the server’s refusal, which names the rule', async () => {
    const { user } = await openSupport({
      onIssue: () =>
        reply(422, { error: 'policy_denied', message: 'Above the safe maximum for cell_ovp' }),
    });
    await selectBattery(user);
    await fill(user, { value: '4.2' });
    await user.click(screen.getByRole('button', { name: 'Issue change' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Above the safe maximum for cell_ovp');
  });

  it('names a protection threshold as one', async () => {
    const { user } = await openSupport();
    await selectBattery(user);
    await user.click(await screen.findByRole('button', { name: 'Open support session' }));
    await user.selectOptions(await screen.findByLabelText('Parameter'), 'cell_ovp');

    expect(await screen.findByText(/protection threshold/)).toBeInTheDocument();
  });

  it('says nothing alarming about an ordinary parameter', async () => {
    const { user } = await openSupport();
    await selectBattery(user);
    await user.click(await screen.findByRole('button', { name: 'Open support session' }));
    await user.selectOptions(await screen.findByLabelText('Parameter'), 'balance_start_v');

    expect(screen.queryByText(/protection threshold/)).not.toBeInTheDocument();
  });
});

/**
 * Force Push overrides queue order and soft holds. It does not override the
 * requirement that someone be present — the constraint most likely to be
 * quietly weakened for support convenience.
 */
describe('Force Push', () => {
  it('says what it does not do', async () => {
    const { user } = await openSupport();
    await selectBattery(user);
    await user.click(await screen.findByRole('button', { name: 'Open support session' }));
    await user.click(await screen.findByLabelText('Force Push'));

    const caveat = await screen.findByText(/does not deliver it any sooner/);
    expect(caveat).toHaveTextContent(/technician still has to be linked/);
  });

  it('is off unless asked for', async () => {
    const { user, issued } = await openSupport();
    await selectBattery(user);
    await user.click(await screen.findByRole('button', { name: 'Open support session' }));
    await user.selectOptions(await screen.findByLabelText('Parameter'), 'cell_ovp');
    await user.type(screen.getByLabelText(/New value/), '3.75');
    await user.type(screen.getByLabelText(/Reason/), 'Vendor bulletin 2026-114');
    await user.click(screen.getByRole('button', { name: 'Issue change' }));

    await waitFor(() => expect(issued).toHaveLength(1));
    expect((issued[0] as { forcePush: boolean }).forcePush).toBe(false);
  });

  it('still only queues when nobody is on site', async () => {
    const { user } = await openSupport({ onSite: false });
    await selectBattery(user);
    await user.click(await screen.findByRole('button', { name: 'Open support session' }));
    await user.click(await screen.findByLabelText('Force Push'));
    await user.selectOptions(await screen.findByLabelText('Parameter'), 'cell_ovp');
    await user.type(screen.getByLabelText(/New value/), '3.75');
    await user.type(screen.getByLabelText(/Reason/), 'Urgent vendor advisory');
    await user.click(screen.getByRole('button', { name: 'Issue change' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/Queued/);
  });
});

/**
 * A command issued during a call must not fire hours later, after the
 * conversation that justified it has ended.
 */
describe('closing a session', () => {
  it('reports how much queued work it cancelled', async () => {
    const { user } = await openSupport({ onClose: () => reply(200, { cancelledCommands: 2 }) });
    await selectBattery(user);
    await user.click(await screen.findByRole('button', { name: 'Open support session' }));
    await user.click(await screen.findByRole('button', { name: 'Close session' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('2 queued changes cancelled');
    expect(status).toHaveTextContent(/must not fire hours later/);
  });

  it('says so plainly when nothing was left queued', async () => {
    const { user } = await openSupport();
    await selectBattery(user);
    await user.click(await screen.findByRole('button', { name: 'Open support session' }));
    await user.click(await screen.findByRole('button', { name: 'Close session' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Nothing was left queued');
  });

  it('uses the singular for one cancelled change', async () => {
    const { user } = await openSupport({ onClose: () => reply(200, { cancelledCommands: 1 }) });
    await selectBattery(user);
    await user.click(await screen.findByRole('button', { name: 'Open support session' }));
    await user.click(await screen.findByRole('button', { name: 'Close session' }));

    expect(await screen.findByRole('status')).toHaveTextContent('1 queued change cancelled');
  });

  it('closes the form with the session', async () => {
    const { user } = await openSupport();
    await selectBattery(user);
    await user.click(await screen.findByRole('button', { name: 'Open support session' }));
    expect(await screen.findByLabelText('Parameter')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close session' }));
    await waitFor(() => expect(screen.queryByLabelText('Parameter')).not.toBeInTheDocument());
  });
});
