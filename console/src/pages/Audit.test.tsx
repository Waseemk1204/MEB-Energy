import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../store/AuthProvider';
import { App } from '../App';
import type { WriteResult, WriteSource } from '../api/audit';
import {
  DEFAULT_AUDIT_ROWS,
  LATE_UPLOAD_MS,
  describeChange,
  formatWhen,
  fromRow,
  wasUploadedLate,
  type AuditEvent,
} from '../api/audit';

const reply = (status: number, body: unknown = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  actor_user_id: 'u1',
  actor_role: 'admin',
  battery_id: 'b1',
  parameter_key: 'cell_ovp',
  old_value: '3.750',
  new_value: '3.800',
  reason: 'Vendor bulletin 2026-114',
  source: 'admin_remote' as WriteSource,
  result: 'success' as WriteResult,
  support_session_id: 's1',
  occurred_at: Date.now() - 60_000,
  recorded_at: Date.now() - 60_000,
  seq: 1,
  ...over,
});

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({ ...fromRow(row()), ...over });

async function openAudit(events: unknown[], onAudit?: () => Response) {
  const requested: string[] = [];

  const fetchImpl = (async (url: string) => {
    if (url.includes('/audit')) requested.push(url);
    if (url.endsWith('/auth/login')) {
      return reply(200, {
        accessToken: 'a1',
        refreshToken: 'r1',
        user: { id: 'u1', email: 'ops@knowyourev.example', displayName: 'Ops', role: 'admin' },
        company: null,
      });
    }
    if (url.includes('/audit')) {
      if (onAudit) return onAudit();
      // Filter here too, or the test proves nothing about server-side filtering.
      const params = new URL(url, 'https://api.test').searchParams;
      const rows = events as { result: string; source: string }[];
      return reply(200, {
        events: rows.filter(
          (e) =>
            (!params.get('result') || e.result === params.get('result')) &&
            (!params.get('source') || e.source === params.get('source'))
        ),
      });
    }
    return reply(200, { batteries: [] });
  }) as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={['/audit']}>
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

const rowFor = async (parameterKey: string) => (await screen.findByText(parameterKey)).closest('tr')!;

beforeEach(() => {
  sessionStorage.clear();
});

describe('reading an audit row', () => {
  it('maps the wire shape', () => {
    const mapped = fromRow(row());
    expect(mapped.parameterKey).toBe('cell_ovp');
    expect(mapped.supportSessionId).toBe('s1');
    expect(mapped.seq).toBe(1);
  });

  it('keeps both clocks, which are different facts', () => {
    const mapped = fromRow(row({ occurred_at: 1000, recorded_at: 5000 }));
    expect(mapped.occurredAt).toBe(1000);
    expect(mapped.recordedAt).toBe(5000);
  });
});

describe('describing a change', () => {
  it('reads as a transition', () => {
    expect(describeChange(event())).toBe('3.750 → 3.800');
  });

  it('marks an unknown previous value rather than implying none', () => {
    expect(describeChange(event({ oldValue: null }))).toBe('? → 3.800');
  });

  it('shows a dash for an event that changed no parameter', () => {
    expect(describeChange(event({ parameterKey: null }))).toBe('—');
  });
});

describe('an event uploaded long after it happened', () => {
  it('is flagged', () => {
    const at = Date.now();
    expect(wasUploadedLate(event({ occurredAt: at, recordedAt: at + LATE_UPLOAD_MS + 1 }))).toBe(true);
  });

  it('is not flagged when the two clocks agree closely', () => {
    const at = Date.now();
    expect(wasUploadedLate(event({ occurredAt: at, recordedAt: at + 1000 }))).toBe(false);
  });

  it('shows the badge in the table', async () => {
    const at = Date.now() - 3 * 60 * 60 * 1000;
    await openAudit([row({ occurred_at: at, recorded_at: at + 2 * 60 * 60 * 1000 })]);
    expect(within(await rowFor('cell_ovp')).getByText('uploaded later')).toBeInTheDocument();
  });

  it('does not show it for an event recorded as it happened', async () => {
    await openAudit([row()]);
    expect(within(await rowFor('cell_ovp')).queryByText('uploaded later')).not.toBeInTheDocument();
  });
});

describe('formatting when something happened', () => {
  const now = 1_700_000_000_000;

  it('reads recent times relatively', () => {
    expect(formatWhen(now - 30_000, now)).toBe('Just now');
    expect(formatWhen(now - 10 * 60_000, now)).toBe('10m ago');
    expect(formatWhen(now - 5 * 3_600_000, now)).toBe('5h ago');
  });

  it('falls back to a date once relative time stops meaning anything', () => {
    expect(formatWhen(now - 9 * 24 * 3_600_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

/**
 * A trail of successes cannot answer "what did someone try to do", which is
 * usually the question being asked of it.
 */
describe('what the table shows', () => {
  it('lists a refusal alongside a success', async () => {
    await openAudit([
      row({ id: 'e1', result: 'success' }),
      row({ id: 'e2', parameter_key: 'cell_uvp', result: 'rejected' }),
    ]);
    expect(within(await rowFor('cell_ovp')).getByText('Applied')).toBeInTheDocument();
    expect(within(await rowFor('cell_uvp')).getByText('Refused')).toBeInTheDocument();
  });

  /** It means nobody knows. Rendering it as either outcome invents a fact. */
  it('calls an unconfirmed write unconfirmed, not failed', async () => {
    await openAudit([row({ result: 'indeterminate' })]);
    const tr = await rowFor('cell_ovp');
    expect(within(tr).getByText('Unconfirmed')).toBeInTheDocument();
    expect(tr.textContent).not.toMatch(/failed|error/i);
  });

  it('distinguishes a BMS adjustment from a clean success', async () => {
    await openAudit([row({ result: 'adjusted' })]);
    expect(within(await rowFor('cell_ovp')).getByText('Adjusted by BMS')).toBeInTheDocument();
  });

  it('names where each change came from', async () => {
    await openAudit([
      row({ id: 'e1', source: 'local' }),
      row({ id: 'e2', parameter_key: 'cell_uvp', source: 'admin_remote' }),
      row({ id: 'e3', parameter_key: 'balance_start_v', source: 'admin_force_push' }),
    ]);
    expect(within(await rowFor('cell_ovp')).getByText('On site')).toBeInTheDocument();
    expect(within(await rowFor('cell_uvp')).getByText('Remote')).toBeInTheDocument();
    expect(within(await rowFor('balance_start_v')).getByText('Force Push')).toBeInTheDocument();
  });

  it('shows the reason a change was made', async () => {
    await openAudit([row()]);
    expect(within(await rowFor('cell_ovp')).getByText('Vendor bulletin 2026-114')).toBeInTheDocument();
  });

  it('says plainly when no reason was recorded', async () => {
    await openAudit([row({ reason: null })]);
    expect(within(await rowFor('cell_ovp')).getByText('None recorded')).toBeInTheDocument();
  });

  it('shows an empty ledger as empty', async () => {
    await openAudit([]);
    expect(await screen.findByText('Nothing has been changed yet.')).toBeInTheDocument();
  });
});

describe('when the trail cannot be loaded', () => {
  it('says so rather than showing an empty ledger', async () => {
    await openAudit([], () => reply(500, { error: 'boom', message: 'Something went wrong' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.queryByText('Nothing has been changed yet.')).not.toBeInTheDocument();
  });

  it('offers a retry', async () => {
    await openAudit([], () => reply(500, { error: 'boom', message: 'nope' }));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

/**
 * Every rail link now goes somewhere real. This is the guard that says so.
 */
describe('the rail', () => {
  it('every rail link reaches its own page rather than redirecting', async () => {
    const fetchImpl = (async (url: string) =>
      url.endsWith('/auth/login')
        ? reply(200, {
            accessToken: 'a1',
            refreshToken: 'r1',
            user: { id: 'u1', email: 'ops@knowyourev.example', displayName: 'Ops', role: 'admin' },
            company: null,
          })
        : reply(200, { batteries: [], events: [] })) as unknown as typeof fetch;

    render(
      <MemoryRouter initialEntries={['/users']}>
        <AuthProvider baseUrl="https://api.test" fetchImpl={fetchImpl}>
          <App />
        </AuthProvider>
      </MemoryRouter>
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'ops@knowyourev.example');
    await user.type(screen.getByLabelText('Password'), 'a-real-passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // "Users" is also the rail link, so assert the heading specifically.
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument();
    // Not silently swapped for the fleet.
    expect(screen.queryByText('Every pack registered to your company, with the last reading it reported.')).not.toBeInTheDocument();
  });
});


/**
 * The server caps the trail at 200 rows. Fetching that page and narrowing it
 * in the browser would quietly hide every older match — a filtered view that
 * silently omits results is worse than no filter at all.
 */
describe('narrowing the trail', () => {
  const mixed = [
    row({ id: 'e1', result: 'success', source: 'admin_remote' }),
    row({ id: 'e2', parameter_key: 'cell_uvp', result: 'rejected', source: 'admin_remote' }),
    row({ id: 'e3', parameter_key: 'balance_start_v', result: 'success', source: 'local' }),
  ];

  it('offers both filters', async () => {
    await openAudit(mixed);
    expect(await screen.findByLabelText('Outcome')).toBeInTheDocument();
    expect(screen.getByLabelText('Source')).toBeInTheDocument();
  });

  it('says the filtering happens server-side', async () => {
    await openAudit(mixed);
    expect(await screen.findByText(/rather than the page already fetched/)).toBeInTheDocument();
  });

  it('asks the server for an outcome rather than filtering here', async () => {
    const { user, requested } = await openAudit(mixed);
    await screen.findByText('cell_ovp');

    await user.selectOptions(screen.getByLabelText('Outcome'), 'rejected');
    await waitFor(() =>
      expect(requested.some((u: string) => u.includes('result=rejected'))).toBe(true)
    );
  });

  it('asks the server for a source', async () => {
    const { user, requested } = await openAudit(mixed);
    await screen.findByText('cell_ovp');

    await user.selectOptions(screen.getByLabelText('Source'), 'local');
    await waitFor(() =>
      expect(requested.some((u: string) => u.includes('source=local'))).toBe(true)
    );
  });

  it('sends no filter parameters when nothing is selected', async () => {
    const { requested } = await openAudit(mixed);
    await screen.findByText('cell_ovp');
    expect(requested[0]).not.toContain('?');
  });

  it('shows what came back', async () => {
    const { user } = await openAudit(mixed);
    await screen.findByText('cell_ovp');

    await user.selectOptions(screen.getByLabelText('Outcome'), 'rejected');
    await waitFor(() => expect(screen.getByText('cell_uvp')).toBeInTheDocument());
    expect(screen.queryByText('balance_start_v')).not.toBeInTheDocument();
  });

  /** An empty filtered view is not the same statement as an empty trail. */
  it('distinguishes no matches from nothing ever having happened', async () => {
    const { user } = await openAudit([row({ result: 'success', source: 'admin_remote' })]);
    await screen.findByText('cell_ovp');

    await user.selectOptions(screen.getByLabelText('Outcome'), 'timeout');
    expect(await screen.findByText('No changes match that filter.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing has been changed yet.')).not.toBeInTheDocument();
  });

  it('says nothing has happened when the unfiltered trail is empty', async () => {
    await openAudit([]);
    expect(await screen.findByText('Nothing has been changed yet.')).toBeInTheDocument();
  });
});

/**
 * A page that is exactly full is probably not the whole story, and reading it
 * as complete is the mistake worth preventing.
 */
describe('a full page', () => {
  it('says there may be more', async () => {
    const full = Array.from({ length: DEFAULT_AUDIT_ROWS }, (_, i) =>
      row({ id: `e${i}`, parameter_key: `param_${i}` })
    );
    await openAudit(full);
    expect(
      await screen.findByText(new RegExp(`Showing the most recent ${DEFAULT_AUDIT_ROWS}`))
    ).toBeInTheDocument();
  });

  it('says nothing of the sort for a short page', async () => {
    await openAudit([row()]);
    await screen.findByText('cell_ovp');
    expect(screen.queryByText(/Showing the most recent/)).not.toBeInTheDocument();
  });
});
