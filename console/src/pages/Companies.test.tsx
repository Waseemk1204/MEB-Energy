import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../store/AuthProvider';
import { App } from '../App';

const reply = (status: number, body: unknown = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response;

const company = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Acme EV',
  status: 'active',
  created_at: 1_700_000_000_000,
  ...over,
});

const YEAR = 365 * 24 * 60 * 60 * 1000;

const entitlement = (over: Record<string, unknown> = {}) => ({
  code: 'ok',
  ok: true,
  expiresAt: Date.now() + YEAR,
  seatLimit: 20,
  deviceLimit: 2,
  sessionDeviceLimit: 2,
  batteryLimit: null,
  seats: { used: 3, limit: 20 },
  devices: { used: 1, limit: 2 },
  sessionDevices: { used: 2, limit: 2 },
  batteries: { used: 0, limit: null },
  ...over,
});

async function openCompanies(
  companies: unknown[] = [company()],
  onCreate?: () => Response,
  onEntitlement?: () => Response,
  onChange?: () => Response
) {
  const sent: { url: string; method: string; body: unknown }[] = [];

  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });

    if (url.endsWith('/auth/login')) {
      return reply(200, {
        accessToken: 'a1',
        refreshToken: 'r1',
        user: { id: 'u1', email: 'ops@knowyourev.example', displayName: 'Ops', role: 'admin' },
        company: null,
      });
    }
    if (url.endsWith('/companies') && init.method === 'POST') {
      return onCreate ? onCreate() : reply(201, { companyId: 'c9', subscriptionId: 's9' });
    }
    if (url.endsWith('/companies')) return reply(200, { companies });
    if (url.includes('/entitlement')) {
      return onEntitlement ? onEntitlement() : reply(200, entitlement());
    }
    if (url.includes('/access') || url.includes('/limits')) {
      return onChange ? onChange() : reply(200, { expiresAt: Date.now() + YEAR });
    }
    return reply(200, {});
  }) as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={['/companies']}>
      <AuthProvider baseUrl="https://api.test" fetchImpl={fetchImpl}>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), 'ops@knowyourev.example');
  await user.type(screen.getByLabelText('Password'), 'a-real-passphrase');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { name: 'Companies' });

  return { user, sent, unmount: () => cleanup() };
}

beforeEach(() => {
  sessionStorage.clear();
});

/*
 * Unmount before clearing, and clear again after.
 *
 * A tree left mounted at the end of a test keeps its in-flight sign-in going,
 * and that request finishes *after* the next test's beforeEach has cleared
 * storage — so the next render hydrates as already authenticated and its login
 * form is gone. That surfaced as an intermittent "no button named Sign in",
 * two failures in three hundred, only under a full run.
 */
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

/**
 * Answers the prompts in order and records what was asked, so a test can
 * assert on the questions as well as the outcome.
 */
function answerPrompts(answers: (string | null)[]) {
  // The default matters as much as the question: an administrator who accepts
  // every prompt applies exactly these numbers.
  const asked: { question: string; suggested: string }[] = [];
  let i = 0;
  vi.stubGlobal('prompt', (question: string, suggested: string) => {
    asked.push({ question, suggested });
    return answers[i++] ?? null;
  });
  return asked;
}

describe('the list', () => {
  it('names each tenant with its access state', async () => {
    await openCompanies();
    const tr = (await screen.findByText('Acme EV')).closest('tr')!;
    await waitFor(() => expect(within(tr).getByText('Active')).toBeInTheDocument());
  });

  it('shows an empty platform as empty', async () => {
    await openCompanies([]);
    expect(await screen.findByText('No companies yet.')).toBeInTheDocument();
  });
});

describe('adding a company', () => {
  const fillIn = async (
    user: ReturnType<typeof userEvent.setup>,
    { name = 'Northern Haulage', seats = '25', batteries = '' } = {}
  ) => {
    await user.click(screen.getByRole('button', { name: 'Add a company' }));
    await user.type(screen.getByLabelText('Name'), name);
    await user.clear(screen.getByLabelText(/Seat limit/));
    await user.type(screen.getByLabelText(/Seat limit/), seats);
    if (batteries) await user.type(screen.getByLabelText(/Battery limit/), batteries);
  };

  it('sends the name and limits', async () => {
    const { user, sent } = await openCompanies();
    await fillIn(user, { batteries: '40' });
    await user.click(screen.getByRole('button', { name: 'Create company' }));

    await waitFor(() =>
      expect(sent.some((s) => s.method === 'POST' && s.url.endsWith('/companies'))).toBe(true)
    );
    const body = sent.find((s) => s.method === 'POST' && s.url.endsWith('/companies'))!.body;
    expect(body).toEqual({ name: 'Northern Haulage', seatLimit: 25, batteryLimit: 40 });
  });

  /** Blank is "no limit", which is a different thing from a limit of zero. */
  it('sends null for a blank battery limit rather than zero', async () => {
    const { user, sent } = await openCompanies();
    await fillIn(user);
    await user.click(screen.getByRole('button', { name: 'Create company' }));

    await waitFor(() =>
      expect(sent.some((s) => s.method === 'POST' && s.url.endsWith('/companies'))).toBe(true)
    );
    const body = sent.find((s) => s.method === 'POST' && s.url.endsWith('/companies'))!.body as {
      batteryLimit: number | null;
    };
    expect(body.batteryLimit).toBeNull();
  });

  it('says the new company has nobody in it yet', async () => {
    const { user } = await openCompanies();
    await fillIn(user);
    await user.click(screen.getByRole('button', { name: 'Create company' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Northern Haulage created');
    expect(status).toHaveTextContent(/no users yet/);
  });

  it('will not submit without a name', async () => {
    const { user } = await openCompanies();
    await user.click(screen.getByRole('button', { name: 'Add a company' }));
    expect(screen.getByRole('button', { name: 'Create company' })).toBeDisabled();
  });

  it('will not submit a seat limit below one', async () => {
    const { user } = await openCompanies();
    await fillIn(user, { seats: '0' });
    expect(screen.getByRole('button', { name: 'Create company' })).toBeDisabled();
  });

  it('surfaces a refusal from the server', async () => {
    const { user } = await openCompanies([company()], () =>
      reply(403, { error: 'forbidden', message: 'Only an administrator may create a company' })
    );
    await fillIn(user);
    await user.click(screen.getByRole('button', { name: 'Create company' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only an administrator may create a company'
    );
  });
});

/**
 * A company owner has no business seeing the other tenants, and the server
 * answers their request with 404 rather than 403 so it does not even confirm
 * the route exists. The rail simply does not offer it.
 */
describe('who can see this at all', () => {
  it('is not offered in the rail to a company owner', async () => {
    const fetchImpl = (async (url: string) =>
      url.endsWith('/auth/login')
        ? reply(200, {
            accessToken: 'a1',
            refreshToken: 'r1',
            user: { id: 'u2', email: 'owner@acme.example', displayName: 'Owner', role: 'company' },
            company: { id: 'c1', name: 'Acme EV' },
          })
        : reply(200, { batteries: [], users: [], devices: [], companies: [] })) as unknown as typeof fetch;

    render(
      <MemoryRouter initialEntries={['/batteries']}>
        <AuthProvider baseUrl="https://api.test" fetchImpl={fetchImpl}>
          <App />
        </AuthProvider>
      </MemoryRouter>
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'owner@acme.example');
    await user.type(screen.getByLabelText('Password'), 'a-real-passphrase');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const rail = await screen.findByRole('navigation', { name: 'Sections' });
    expect(within(rail).queryByText('Companies')).not.toBeInTheDocument();
    // The sections they can use are still there.
    expect(within(rail).getByText('Users')).toBeInTheDocument();
    expect(within(rail).getByText('Devices')).toBeInTheDocument();
  });
});


/**
 * Payment happens outside knowyourEV. Granting access here is an administrator
 * recording that it did — and none of it was enforced before: a company could
 * be suspended, or its plan a year lapsed, and every one of its users carried
 * on working.
 */
describe('a company’s access', () => {
  const rowFor = async (name: string) => (await screen.findByText(name)).closest('tr')!;

  it('says how long is left rather than only when it ends', async () => {
    await openCompanies();
    const tr = await rowFor('Acme EV');
    await waitFor(() => expect(within(tr).getByText(/months left/)).toBeInTheDocument());
  });

  it('reports usage against each limit', async () => {
    await openCompanies();
    const tr = await rowFor('Acme EV');
    await waitFor(() => expect(within(tr).getByText('3 of 20')).toBeInTheDocument());
    // Gateways and sign-ins, which are different numbers and different cells.
    expect(within(tr).getByText('1 of 2')).toBeInTheDocument();
    expect(within(tr).getByText('2 of 2')).toBeInTheDocument();
  });

  it('says when a limit is not set rather than showing nothing', async () => {
    await openCompanies([company()], undefined, () =>
      reply(200, entitlement({ seats: { used: 3, limit: null } }))
    );
    const tr = await rowFor('Acme EV');
    await waitFor(() => expect(within(tr).getByText('3 · no limit')).toBeInTheDocument());
  });

  /** Four different refusals, four different things to tell somebody. */
  it('distinguishes expired from suspended from never granted', async () => {
    for (const [code, label] of [
      ['subscription_expired', 'Expired'],
      ['company_suspended', 'Suspended'],
      ['no_subscription', 'No access'],
      ['subscription_cancelled', 'Cancelled'],
    ] as const) {
      // One render per case: repeated renders in a single test leave the
      // previous tree mounted and `findByText` then matches the wrong one.
      const view = await openCompanies([company()], undefined, () =>
        reply(200, entitlement({ code, ok: false }))
      );
      const tr = await rowFor('Acme EV');
      await waitFor(() => expect(within(tr).getByText(label)).toBeInTheDocument());
      view.unmount();
      sessionStorage.clear();
    }
  });

  it('offers to grant access to a company that has none', async () => {
    await openCompanies([company()], undefined, () =>
      reply(200, entitlement({ code: 'no_subscription', ok: false }))
    );
    const tr = await rowFor('Acme EV');
    await waitFor(() =>
      expect(within(tr).getByRole('button', { name: 'Grant access' })).toBeInTheDocument()
    );
  });

  it('offers to renew or change one that has it', async () => {
    await openCompanies();
    const tr = await rowFor('Acme EV');
    await waitFor(() =>
      expect(within(tr).getByRole('button', { name: 'Renew or change' })).toBeInTheDocument()
    );
  });

  /** Revoking a company nobody can use is a control with nothing to do. */
  it('offers no revoke for a company without access', async () => {
    await openCompanies([company()], undefined, () =>
      reply(200, entitlement({ code: 'subscription_expired', ok: false }))
    );
    const tr = await rowFor('Acme EV');
    await waitFor(() => expect(within(tr).queryByRole('button', { name: 'Revoke' })).toBeNull());
  });
});

/**
 * Two different things are called "devices" in this product: knowyourEV
 * gateways, and the phones and browsers the owner account is signed in on.
 * Conflating them is the mistake this whole section exists to prevent.
 */
describe('the two device limits', () => {
  const rowFor = async (name: string) => (await screen.findByText(name)).closest('tr')!;

  it('shows gateways and sign-ins as separate columns', async () => {
    await openCompanies([company()], undefined, () =>
      reply(200, entitlement({ devices: { used: 7, limit: 10 }, sessionDevices: { used: 1, limit: 2 } }))
    );

    const header = screen.getByRole('table').querySelectorAll('th');
    const names = [...header].map((th) => th.textContent);
    expect(names).toContain('Gateways');
    expect(names).toContain('Sign-ins');

    const tr = await rowFor('Acme EV');
    await waitFor(() => expect(within(tr).getByText('7 of 10')).toBeInTheDocument());
    expect(within(tr).getByText('1 of 2')).toBeInTheDocument();
  });

  it('asks about them separately, in words that tell them apart', async () => {
    const { user } = await openCompanies();
    const asked = answerPrompts(['50', '10', '4']);

    const tr = await rowFor('Acme EV');
    await waitFor(() => within(tr).getByRole('button', { name: 'Renew or change' }));
    await user.click(within(tr).getByRole('button', { name: 'Renew or change' }));

    await waitFor(() => expect(asked).toHaveLength(3));
    expect(asked[1]!.question).toMatch(/gateway/i);
    expect(asked[2]!.question).toMatch(/signed in/i);
  });

  /**
   * The dangerous version of conflating them: an administrator opening this on
   * a company with forty gateways is shown "40" for the sign-in cap, and three
   * OKs silently raise a cap of two to forty.
   */
  it('suggests each limit’s own current value, not the other one’s', async () => {
    const { user } = await openCompanies([company()], undefined, () =>
      reply(200, entitlement({ seatLimit: 50, deviceLimit: 40, sessionDeviceLimit: 2 }))
    );
    const asked = answerPrompts([null]);

    const tr = await rowFor('Acme EV');
    await waitFor(() => within(tr).getByRole('button', { name: 'Renew or change' }));
    await user.click(within(tr).getByRole('button', { name: 'Renew or change' }));

    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(asked[0]!.suggested).toBe('50');
  });

  it('suggests the current sign-in cap rather than the gateway count', async () => {
    const { user } = await openCompanies([company()], undefined, () =>
      reply(200, entitlement({ deviceLimit: 40, sessionDeviceLimit: 2 }))
    );
    const asked = answerPrompts(['50', '40', null]);

    const tr = await rowFor('Acme EV');
    await waitFor(() => within(tr).getByRole('button', { name: 'Renew or change' }));
    await user.click(within(tr).getByRole('button', { name: 'Renew or change' }));

    await waitFor(() => expect(asked).toHaveLength(3));
    expect(asked[1]!.suggested).toBe('40');
    expect(asked[2]!.suggested).toBe('2');
  });

  it('sends both limits, and does not send one as the other', async () => {
    const { user, sent } = await openCompanies();
    answerPrompts(['50', '10', '4']);

    const tr = await rowFor('Acme EV');
    await waitFor(() => within(tr).getByRole('button', { name: 'Renew or change' }));
    await user.click(within(tr).getByRole('button', { name: 'Renew or change' }));

    await waitFor(() => expect(sent.some((s) => s.method === 'PATCH')).toBe(true));
    expect(sent.find((s) => s.method === 'PATCH')!.body).toEqual({
      seatLimit: 50,
      deviceLimit: 10,
      sessionDeviceLimit: 4,
    });
  });

  it('starts a fresh year when there was no access, sending both limits', async () => {
    const { user, sent } = await openCompanies([company()], undefined, () =>
      reply(200, entitlement({ code: 'no_subscription', ok: false }))
    );
    answerPrompts(['20', '5', '3']);

    const tr = await rowFor('Acme EV');
    await waitFor(() => within(tr).getByRole('button', { name: 'Grant access' }));
    await user.click(within(tr).getByRole('button', { name: 'Grant access' }));

    await waitFor(() => expect(sent.some((s) => s.url.includes('/access'))).toBe(true));
    expect(sent.find((s) => s.url.includes('/access'))!.body).toEqual({
      seatLimit: 20,
      deviceLimit: 5,
      sessionDeviceLimit: 3,
    });
  });

  /** Half a change applied because somebody hit Cancel is worse than none. */
  it('changes nothing when the last question is cancelled', async () => {
    const { user, sent } = await openCompanies();
    answerPrompts(['50', '10', null]);

    const tr = await rowFor('Acme EV');
    await waitFor(() => within(tr).getByRole('button', { name: 'Renew or change' }));
    await user.click(within(tr).getByRole('button', { name: 'Renew or change' }));

    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
    expect(sent.some((s) => s.method === 'PATCH' || s.url.includes('/access'))).toBe(false);
  });

  it('refuses a sign-in limit that is not a whole number', async () => {
    const { user, sent } = await openCompanies();
    answerPrompts(['50', '10', 'two']);

    const tr = await rowFor('Acme EV');
    await waitFor(() => within(tr).getByRole('button', { name: 'Renew or change' }));
    await user.click(within(tr).getByRole('button', { name: 'Renew or change' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/sign-in devices/i);
    expect(sent.some((s) => s.method === 'PATCH')).toBe(false);
  });
});
